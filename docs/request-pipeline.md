# Shared request pipeline

Generation ingress routes construct a `RequestPipeline(manager, event,
incomingProtocol)`. OpenAI and Gemini embeddings also use it for provider
resolution, usage observation, errors and completion, but bypass generation
request, response and stream hooks.

## Request and stream processing

- `resolve(request)` records the model and resolves the adapter, updating provider
  context. `prepare(request)` resolves it, runs ordered request hooks and returns
  `{ request, resolved }`. If a hook changes the model, resolution runs again
  after the hook chain; hooks in that chain see the initially selected provider.
- `call(request)` invokes the manager, observes upstream usage, runs response
  hooks and observes the returned response's usage when present.
- `embed(request)` invokes the manager's embedding operation. A returned model
  replaces the completion model, prefixed with the selected provider when not
  already namespaced. Embedding `totalTokens` becomes `promptTokens`, with zero
  `completionTokens`.
- `openStream(request, adapter)` formats and opens the upstream stream with
  `stream: true`.
- `consumeStream(stream, adapter, consumer)` decodes UTF-8, buffers lines and
  parses `data: ` JSON through the adapter. It observes each converted chunk's
  usage before stream hooks, so filtering or replacing chunks does not remove
  the observed upstream usage. `consumer.onChunks(chunks)` owns protocol framing;
  `onDoneMarker()` handles `[DONE]`. Conversion or consumer errors notify error
  hooks and `onChunkError(error)`; reader failures propagate to the route.
- `error(error)` records and notifies error hooks once per error identity.
  Protocol wrappers are distinct errors.

The pipeline processes a nonempty trailing line at EOF. Protocol framing, SSE
pings, Claude block state, OpenAI pending finish/late usage handling, Responses
ordering and Gemini array-vs-SSE output remain in ingress routes. The pipeline
has no decoder flush, reader cancellation/release, retry or added EOF frame.

## Completion and accounting

Ingress routes call `complete()` from their outer `finally` blocks. Completion
is once per pipeline instance, including parse/provider failures and streams
without usage. It contains the resolved/request model (or the embedding response
model), latest observed usage and last recorded error. Usage is a cumulative
snapshot, not the sum of successive usage chunks.

An early client close records `Client disconnected` without completing or
cancelling upstream consumption. Later upstream usage can still be observed;
a subsequent reported error replaces that failure. `complete()` removes the
close listener and starts completion hooks, but awaiting it does **not** await
those hooks or their storage writes. Pending completion work is tracked at
process scope; `drainCompletions()` waits until that set is empty.

Accounting belongs to built-in completion hooks, not pipeline methods:

- `stats` increments the global call count on completion.
- `quota` updates API-key usage when a key record is present. Without usage it
  records a zero-token call; with usage it obtains billable tokens from the
  `token-billing` service and attributes them to the completion model/provider.
  If conversion fails, it records a zero-token call and rethrows for hook logging.
- `token-billing` provides token conversion; it does not register an accounting
  hook itself.

## Hook registration

`requestHooks.register(hook)` returns an unregister function. A hook has a unique
nonempty `id`, optional numeric `priority` (default zero), and any of:

```ts
onBeforeIdentity(context: AdmissionContext): Awaitable<AdmissionRejection | void>
onAfterIdentity(context: AdmissionContext): Awaitable<AdmissionRejection | void>
onModelResolved(context: AdmissionContext): Awaitable<AdmissionRejection | void>
onModels(models: ModelInfo[], context: HookContext): Awaitable<ModelInfo[] | void>
onModelsRefreshed(validModelIds: ReadonlySet<string>): Awaitable<void>
onRequest(request: LLMRequest, context: HookContext): Awaitable<LLMRequest | void>
onResponse(response: LLMResponse, context: HookContext): Awaitable<LLMResponse | void>
onStreamChunk(chunk: LLMStreamChunk, context: HookContext):
  Awaitable<LLMStreamChunk | LLMStreamChunk[] | null | void>
onError(error: unknown, context: HookContext): Awaitable<void>
onComplete(completion: CompletionInfo, context: HookContext): Awaitable<void>
```

Lower priorities run first; ties preserve registration order. `undefined` retains
an input; stream `null` or `[]` drops it. Expanded chunks each pass through the
remaining hooks. Request failures abort forwarding as gateway errors, formatted
by the ingress error boundary. Admission stops at the first rejection; exceptions
from admission, model-list and model-refresh hooks propagate to their callers.
Response, stream, error and completion hook failures log and continue. Hooks
should return replacements rather than mutating input before throwing; mutations
are not rolled back.

`HookContext` contains `incomingProtocol`, optional `providerName`,
`providerConfig` and `apiKeyRecord`. These are trusted server-side objects that
can contain secrets, not response metadata. `AdmissionContext` instead contains
the HTTP event, protocol, optional key record and model. Admission and model-list
hooks are invoked outside the generation pipeline.

## Built-in request policies

Thinking policy is a request hook at priority -100. Its scope is OpenAI chat,
Responses, Claude messages and Gemini generation, not legacy completions. Gemini
uses its model prefix for policy lookup.

CCH normalization is an ordinary request hook at priority 1000. For Claude
messages with a provider and system prompt, it reads fresh provider configuration
and, when enabled, replaces `/;\s*cch=\w+;/g` with `; cch=00000;`. There is no
separate normalization registry.

Built-in and runtime plugins register hooks through their plugin API. See
[Plugins](plugins/README.md) for lifecycle and authoring details.
