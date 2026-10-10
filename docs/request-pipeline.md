# Shared generation pipeline

The six generation ingress routes construct a `RequestPipeline(manager, event,
incomingProtocol)`. Embeddings remain outside this generation pipeline.

- `prepare(request)` resolves the provider and runs ordered request hooks, returning
  `{ request, resolved }`. Replacing the model resolves the adapter again before
  forwarding. Context describes the provider selected before the hook chain;
  after the chain it is refreshed if the model changed.
- `call(request)` invokes the manager and runs response hooks on the unified response.
- `openStream(request, adapter)` formats and opens the upstream stream.
- `consumeStream(stream, adapter, consumer)` decodes UTF-8, buffers lines, parses
  upstream JSON and converts it to unified chunks. `consumer.onChunks(chunks)`
  owns protocol framing. `onDoneMarker()` retains protocol-specific `[DONE]`
  handling; `onChunkError(error)` retains each route's existing log message.
- `incrementCalls()` and `trackUsage(usage, model?)` centralize accounting access.
  Routes deliberately retain their original call sites and await behavior.
- `error(error)` notifies error hooks once per error identity. Protocol error
  wrappers are distinct errors. `complete()` notifies completion hooks once.

## Hook registration

`requestHooks.register(hook)` returns an unregister function. A hook has a unique
`id`, optional numeric `priority` (default zero), and any of:

```ts
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
by the existing ingress error boundary (Claude messages retains its 400 wrapper).
Other hook failures log and continue with the current value. Hooks should return
replacements rather than mutating input before throwing; mutations are not rolled
back. Registrations should be installed before accepting requests.

Context contains `incomingProtocol`, optional `providerName`, `providerConfig`
and `apiKeyRecord`. These are trusted server-side objects containing secrets;
they are never response metadata. Completion carries the latest observed unified
`usage` and the last reported `error`, if present. It is not an accounting-storage
flush barrier: existing fire-and-forget accounting remains fire-and-forget. Usage
is a cumulative upstream snapshot, not the sum of successive usage chunks.

## Built-ins and compatibility

Thinking policy is a request hook at priority -100. Its scope remains chat,
Responses, Claude messages and Gemini generation, not legacy completions. Gemini
retains its model-prefix policy lookup and original stream-flag assignment timing.
CCH normalization is registered on `normalizationHooks`, invoked only at the
existing Claude messages boundary after the request log. It retains the fresh
provider-store lookup, regex, and replacement. This separate boundary preserves
logging/store-failure order rather than moving normalization earlier.

SSE ping formats, Claude block state, OpenAI pending finish/late usage handling,
Responses event order, Gemini array-vs-SSE output, and EOF behavior stay in the
routes. The pipeline intentionally does not add decoder flushing, reader cleanup,
new EOF frames, retries or billing deduplication absent from the old routes.

No plugin loader, management endpoints, dashboard pages, dependency installation,
or persisted-data migration is implemented in this phase.
