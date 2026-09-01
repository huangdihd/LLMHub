import { OpenAIResponsesSerializer } from './openai-responses-serializer'

/** Codex downstream responses are standard Responses API objects/events. */
export class CodexResponsesSerializer extends OpenAIResponsesSerializer {
  name = 'codex-responses'
}
