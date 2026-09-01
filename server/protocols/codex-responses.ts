import { OpenAIResponsesParser } from './openai-responses'

/** Codex uses the Responses wire format at a distinct gateway endpoint. */
export class CodexResponsesParser extends OpenAIResponsesParser {
  name = 'codex-responses'

  canHandle(url: string, method: string, _body: any): boolean {
    return url.includes('/codex/responses') && method === 'POST'
  }
}
