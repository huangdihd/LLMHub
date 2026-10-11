import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { readDocument, systemPrompt } from './guide.mjs'

const MAX_TOOL_OUTPUT = 24000
const MAX_HISTORY = 60
const REQUEST_TIMEOUT = 180000

const tool = (name, description, properties = {}, required = Object.keys(properties)) =>
  ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } } })
const text = description => ({ type: 'string', description })

export const TOOLS = [
  tool('list_files', 'List every file in the plugin folder with its size.'),
  tool('read_file', 'Read a text file from the plugin folder.', { path: text('Path relative to the plugin folder') }),
  tool('write_file', 'Create or replace a whole file.', { path: text('Path relative to the plugin folder'), content: text('Complete new file content') }),
  tool('edit_file', 'Replace one exact, unique occurrence of old_text with new_text in a file.', {
    path: text('Path relative to the plugin folder'), old_text: text('Existing text, copied exactly, including whitespace'), new_text: text('Replacement text')
  }),
  tool('delete_file', 'Delete a file from the plugin folder.', { path: text('Path relative to the plugin folder') }),
  tool('check_project', 'Validate package.json and check every JavaScript file for syntax errors.'),
  tool('read_docs', 'Read LLMHub plugin documentation.', { name: { type: 'string', enum: ['reference', 'getting-started', 'types'] } })
]

const truncate = value => value.length > MAX_TOOL_OUTPUT ? `${value.slice(0, MAX_TOOL_OUTPUT)}\n… (truncated, ${value.length} characters in total)` : value

const nodeCheck = file => new Promise(resolve => {
  execFile(process.execPath, ['--check', file], { timeout: 10000 }, (error, _stdout, stderr) => resolve(error ? (stderr || error.message).trim() : ''))
})

/** Static checks a model can run after editing: the manifest and JavaScript syntax. */
export async function checkProject(workspace, project) {
  const problems = []
  const files = await workspace.list(project)
  const names = new Set(files.map(file => file.path))
  let entry = 'index.mjs'
  if (names.has('package.json')) {
    try {
      const data = JSON.parse(await workspace.read(project, 'package.json'))
      if (!data.llmhub || typeof data.llmhub !== 'object') problems.push('package.json has no "llmhub" block')
      else if (data.llmhub.id !== undefined && data.llmhub.id !== project) problems.push(`llmhub.id is "${data.llmhub.id}" but the folder is "${project}"; they must match`)
      if (!data.name || !data.version) problems.push('package.json needs "name" and "version"')
      if (!data.engines?.llmhub) problems.push('package.json should declare engines.llmhub')
      entry = (typeof data.exports === 'string' && data.exports) || data.main || entry
      for (const panel of data.llmhub?.contributes?.panels ?? []) {
        if (panel?.page && !names.has(String(panel.page).replace(/^\.\//, ''))) problems.push(`Panel "${panel.id}" points to missing file ${panel.page}`)
      }
    } catch (error) { problems.push(`package.json: ${error.message}`) }
  } else if (!names.has('plugin.json')) problems.push('No package.json or plugin.json')
  entry = String(entry).replace(/^\.\//, '')
  if (!names.has(entry)) problems.push(`Entry file ${entry} does not exist`)
  for (const file of files) {
    if (!/\.(mjs|cjs|js)$/.test(file.path)) continue
    const error = await nodeCheck(join(await workspace.projectDirectory(project), file.path))
    if (error) problems.push(`${file.path}: ${error.split('\n').slice(0, 6).join('\n')}`)
  }
  return problems.length ? `Problems found:\n- ${problems.join('\n- ')}` : `No problems found in ${files.length} files. Entry: ${entry}`
}

/** One conversation per project, driven by a model reached through LLMHub's own OpenAI-compatible endpoint. */
export class Agent {
  /**
   * @param {object} options
   * @param {import('./workspace.mjs').Workspace} options.workspace
   * @param {string} options.project
   * @param {object[]} [options.messages] a saved conversation
   * @param {(project: string, messages: object[]) => Promise<void>} options.save
   */
  constructor({ workspace, project, messages = [], save }) {
    this.workspace = workspace
    this.project = project
    this.messages = messages
    /** Messages trimmed from the front, so panel positions stay absolute. */
    this.dropped = 0
    this.save = save
    this.running = false
    this.controller = null
    this.error = ''
    this.changed = []
  }

  /** @param {{ prompt: string, model: string, endpoint: { url: string, headers: Record<string, string> }, maxSteps: number, file?: string }} options */
  async run({ prompt, model, endpoint, maxSteps, file }) {
    if (this.running) throw new Error('The assistant is already working on this project')
    this.running = true
    this.error = ''
    this.changed = []
    this.controller = new AbortController()
    this.messages.push({ role: 'user', content: file ? `${prompt}\n\n(The user has ${file} open in the editor.)` : prompt })
    try {
      for (let step = 0; step < maxSteps; step++) {
        const files = await this.workspace.list(this.project)
        const reply = await this.complete({ model, endpoint, files })
        const message = { role: 'assistant', content: reply.content || '' }
        if (reply.tool_calls?.length) message.tool_calls = reply.tool_calls.map(call => ({ id: call.id, type: 'function', function: { name: call.function?.name, arguments: call.function?.arguments || '{}' } }))
        this.messages.push(message)
        if (!message.tool_calls) return
        for (const call of message.tool_calls) {
          if (this.controller.signal.aborted) throw new Error('Stopped')
          const content = await this.execute(call.function.name, call.function.arguments)
          this.messages.push({ role: 'tool', tool_call_id: call.id, content: truncate(content) })
        }
      }
      this.messages.push({ role: 'assistant', content: `Stopped after ${maxSteps} steps. Say "continue" to let me keep going.` })
    } catch (error) {
      this.error = this.controller.signal.aborted ? 'Stopped' : error.message
    } finally {
      this.answerPendingCalls()
      this.running = false
      this.controller = null
      this.trim()
      await this.save(this.project, this.messages)
    }
  }

  stop() { this.controller?.abort() }

  /** Every tool call needs a result before the next model request, including calls a stop skipped. */
  answerPendingCalls() {
    const index = this.messages.findLastIndex(message => message.role === 'assistant' && message.tool_calls)
    if (index < 0) return
    const answered = new Set(this.messages.slice(index + 1).map(message => message.tool_call_id))
    for (const call of this.messages[index].tool_calls) {
      if (!answered.has(call.id)) this.messages.push({ role: 'tool', tool_call_id: call.id, content: 'Error: not run, the assistant was stopped' })
    }
  }

  clear() {
    if (this.running) throw new Error('Stop the assistant first')
    this.dropped += this.messages.length
    this.messages = []
    this.error = ''
    return this.save(this.project, this.messages)
  }

  /** Keeps the conversation bounded without leaving a tool result whose call was cut off. */
  trim() {
    if (this.messages.length <= MAX_HISTORY) return
    let start = this.messages.length - MAX_HISTORY
    while (start < this.messages.length && this.messages[start].role !== 'user') start++
    this.dropped += start
    this.messages = this.messages.slice(start)
  }

  async complete({ model, endpoint, files }) {
    const signal = AbortSignal.any([this.controller.signal, AbortSignal.timeout(REQUEST_TIMEOUT)])
    const response = await fetch(`${endpoint.url}/chat/completions`, {
      method: 'POST', signal,
      headers: { 'content-type': 'application/json', ...endpoint.headers },
      body: JSON.stringify({
        model, stream: false, tools: TOOLS, tool_choice: 'auto',
        messages: [{ role: 'system', content: systemPrompt(this.project, files) }, ...this.messages]
      })
    })
    const body = await response.text()
    let data
    try { data = JSON.parse(body) } catch { data = null }
    if (!response.ok) throw new Error(`The model request failed (${response.status}): ${data?.error?.message || body.slice(0, 300)}`)
    const message = data?.choices?.[0]?.message
    if (!message) throw new Error('The model returned no message')
    return message
  }

  async execute(name, rawArguments) {
    let args
    try { args = JSON.parse(rawArguments || '{}') } catch { return 'Error: arguments were not valid JSON' }
    const { workspace, project } = this
    try {
      switch (name) {
        case 'list_files': return (await workspace.list(project)).map(file => `${file.path} (${file.size} bytes)`).join('\n') || '(empty)'
        case 'read_file': return await workspace.read(project, args.path)
        case 'write_file':
          await workspace.write(project, args.path, String(args.content ?? ''))
          this.changed.push(args.path)
          return `Wrote ${args.path}`
        case 'edit_file': {
          const current = await workspace.read(project, args.path)
          const oldText = String(args.old_text ?? '')
          if (!oldText) return 'Error: old_text is empty'
          const count = current.split(oldText).length - 1
          if (count !== 1) return `Error: old_text occurs ${count} times in ${args.path}; it must occur exactly once. Read the file and copy the text exactly.`
          await workspace.write(project, args.path, current.replace(oldText, () => String(args.new_text ?? '')))
          this.changed.push(args.path)
          return `Edited ${args.path}`
        }
        case 'delete_file':
          await workspace.remove(project, args.path)
          this.changed.push(args.path)
          return `Deleted ${args.path}`
        case 'check_project': return await checkProject(workspace, project)
        case 'read_docs': return await readDocument(args.name)
        default: return `Error: unknown tool ${name}`
      }
    } catch (error) {
      return `Error: ${error.message}`
    }
  }

  /**
   * What the panel shows, from absolute position `since` on. Tool output is
   * shortened: the panel shows that a tool ran, not everything it read.
   */
  snapshot(since = 0) {
    const from = Math.max(0, Math.min(this.messages.length, since - this.dropped))
    const messages = this.messages.slice(from).map(message => message.role === 'tool' && message.content.length > 2000
      ? { ...message, content: `${message.content.slice(0, 2000)}\n…` } : message)
    return { running: this.running, error: this.error, changed: [...new Set(this.changed)], start: this.dropped + from, end: this.dropped + this.messages.length, messages }
  }
}
