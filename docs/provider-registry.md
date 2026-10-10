# Provider and protocol registration

`ProviderConfig.protocol` is an extensible string. Built-in IDs and their type are
exported as `BUILTIN_PROVIDER_IDS` and `BuiltinProviderId` from
`server/providers/builtins.ts`.

## Providers

Register a `ProviderDefinition` on `providerRegistry` before loading providers:

- `id`: persisted provider protocol identifier.
- `createAdapter(config)`: creates the upstream adapter.
- `fetchModels(config, context: ModelDiscoveryContext)`: retrieves the upstream model catalog.
  `context.fetcher(url, options?)` uses a fixed ten-second timeout and one retry,
  regardless of provider connection settings. Options are standard `RequestInit`.
- `secretConnectionFields: readonly string[]`: required declaration of additional
  top-level connection fields to strip; use `[]` when there are no extra secrets.
- `requiresRefreshToken?: boolean`: when true, `authenticated` requires both an
  API/access token and a refresh token; otherwise it requires only the API token.

The store owns sanitization: it always strips `api_key`, `refresh_token`,
`id_token`, `device_id`, `account_id`, `project_id`, and `account_email`, plus
registered secret fields, without mutating stored configuration. It computes
`authenticated` after stripping fields, so neither stored data nor secret field
names can override that flag. Providers cannot supply sanitization callbacks.

Registration rejects empty and duplicate IDs. Unknown protocols are logged and
skipped for adapter creation and model discovery, including custom catalogs.
Their management responses still strip known credential fields.

Built-in discovery functions live in `server/providers/model-discovery.ts`.
`ProviderLoader` retains custom-model handling, failure fallback, the shared
five-minute stale-while-revalidate cache and invalidation generations. Built-ins may continue using their existing discovery functions, which also
retain the fixed ten-second timeout and one retry. OpenAI adapter selection
still uses `connection.api_type`; missing values retain Chat Completions.

## Client protocols

`ProtocolRegistry` is separate from provider registration. Register a
`ProtocolDefinition` on `protocolRegistry` from `server/protocols/builtins.ts`
before constructing a manager. Each definition supplies `id`, `createParser`
and `createSerializer`. Parser precedence follows registration order; managers
create fresh parser/serializer instances. The six built-in protocols retain their
existing precedence and IDs.

## Verification

`tests/registry.test.ts` uses the same `ADAPTER_BUILD` output as existing adapter
tests. New runtime modules are `core/registry.ts`, `core/protocol-registry.ts`,
`providers/builtins.ts`, `providers/model-discovery.ts`, and
`protocols/builtins.ts`. TypeScript includes these transitively when compiling
`providers/manager.ts` and `stores/provider.store.ts`.
