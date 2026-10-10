import type { H3Event } from 'h3'
import type * as Author from '../examples/plugins/llmhub-plugin'
import type * as Core from '../server/core/types'
import type * as Hooks from '../server/core/hooks'
import type * as Providers from '../server/core/registry'
import type * as Protocols from '../server/core/protocol-registry'
import type * as Ingresses from '../server/core/ingress-registry'
import type * as Runtime from '../server/plugins-runtime/manager'
import type * as Manifest from '../shared/types/plugin'
import type * as Subscriptions from '../server/services/subscription-usage'
import type * as Authentication from '../server/stores/auth.store'

// Comparing keys alone misses signature drift. Generic-function equality also
// catches optional fields, readonly modifiers, any widening, and method shapes
// that ordinary (bivariant) interface assignability can silently accept.
type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2)
    ? (<Value>() => Value extends Right ? 1 : 2) extends
      (<Value>() => Value extends Left ? 1 : 2) ? true : false
    : false
type Assert<Value extends true> = Value
type Bidirectional<Left, Right> = [Left] extends [Right]
  ? [Right] extends [Left] ? true : false
  : false

// Normalize only known event-bearing paths, leaving generic services, storage,
// return types and all unrelated members untouched. In particular, do not
// structurally match arbitrary objects against the small public event subset.
type NormalizeEvent<Value> = Equal<Value, H3Event> extends true ? Author.H3Event : Value
type EventMember = 'registerRoute' | 'registerHook' | 'registerIngress' | 'setup'
  | 'onBeforeIdentity' | 'onAfterIdentity' | 'onModelResolved'
  | 'extractKey' | 'extractModel' | 'sendError'
type NormalizeCallback<Value> = Value extends (...arguments_: infer Arguments) => infer Result
  ? (...arguments_: { [Index in keyof Arguments]: NormalizeContract<NormalizeEvent<Arguments[Index]>> }) => Result
  : Value
type NormalizeContract<Value> = Value extends (...arguments_: any[]) => unknown
  ? NormalizeCallback<Value>
  : Value extends object ? {
    [Key in keyof Value]: Key extends 'event' ? NormalizeEvent<Value[Key]>
      : Key extends EventMember ? NormalizeCallback<Value[Key]>
      : Key extends 'default' ? NormalizeContract<Value[Key]>
      : Value[Key]
  } : Value

// Real runtime events must be safe inputs to the supported author surface.
// Public members are checked separately: normalization must not hide drift here.
export type RuntimeEventAssignable = Assert<H3Event extends Author.H3Event ? true : false>
export type EventPublicFields = Assert<Equal<
  Pick<Author.H3Event, 'node' | 'method' | 'path' | 'headers' | 'handled' | 'respondWith'>,
  Pick<H3Event, 'node' | 'method' | 'path' | 'headers' | 'handled' | 'respondWith'>
>>
export type EventContextFields = Assert<Equal<
  Pick<Author.H3Event['context'], 'params' | 'clientAddress'>,
  Pick<H3Event['context'], 'params' | 'clientAddress'>
>>

// Both whole-object assignability and per-member equality are deliberate:
// extra optional members pass assignability, but must still fail this test.
type MemberChecks<Left, Right> = {
  [Key in keyof Left]: Key extends keyof Right ? Equal<Left[Key], Right[Key]> : false
}[keyof Left]
type ContractMatches<Left, Right> = StrictContractMatches<NormalizeContract<Left>, NormalizeContract<Right>>
type StrictContractMatches<Left, Right> = Equal<{ [Key in keyof Left]: Left[Key] }, { [Key in keyof Right]: Right[Key] }> extends true
  ? Bidirectional<Left, Right> extends true
    ? Exclude<MemberChecks<Left, Right>, true | undefined> extends never ? true : false
    : false
  : false

export type RuntimeContract = Assert<ContractMatches<Author.PluginAPI, Runtime.PluginAPI>>
export type StorageContract = Assert<ContractMatches<Author.PluginStorage, Runtime.PluginStorage>>
export type ModuleContract = Assert<ContractMatches<Author.PluginModule, Runtime.PluginModule>>
export type ManifestContract = Assert<ContractMatches<Author.PluginManifest, Manifest.PluginManifest>>
export type PackageManifestContract = Assert<ContractMatches<Author.PluginPackageManifest, Manifest.PluginPackageManifest>>
export type PackageMetadataContract = Assert<ContractMatches<Author.PluginPackageMetadata, Manifest.PluginPackageMetadata>>
export type FieldContract = Assert<ContractMatches<Author.PluginField, Manifest.PluginField>>
export type ProviderContract = Assert<ContractMatches<Author.ProviderDefinition, Providers.ProviderDefinition>>
export type ProviderManagementContract = Assert<ContractMatches<Author.ProviderManagement, Providers.ProviderManagement>>
export type DiscoveryContract = Assert<ContractMatches<Author.ModelDiscoveryContext, Providers.ModelDiscoveryContext>>
export type SafeConnectionContract = Assert<ContractMatches<Author.SafeProviderConnection, Providers.SafeProviderConnection>>
export type HookContract = Assert<ContractMatches<Author.RequestHook, Hooks.RequestHook>>
export type HookContextContract = Assert<ContractMatches<Author.HookContext, Hooks.HookContext>>
export type AdmissionContract = Assert<ContractMatches<Author.AdmissionContext, Hooks.AdmissionContext>>
export type RejectionContract = Assert<ContractMatches<Author.AdmissionRejection, Hooks.AdmissionRejection>>
export type CompletionContract = Assert<ContractMatches<Author.CompletionInfo, Hooks.CompletionInfo>>
export type AccountingContract = Assert<Equal<Author.AccountingCompletion, Hooks.AccountingCompletion>>
export type AdmissionStageContract = Assert<Equal<Author.AdmissionStage, Hooks.AdmissionStage>>
export type ProtocolContract = Assert<ContractMatches<Author.ProtocolDefinition, Protocols.ProtocolDefinition>>
export type IngressContract = Assert<ContractMatches<Author.IngressDefinition, Ingresses.IngressDefinition>>
export type IngressModelContract = Assert<ContractMatches<Author.IngressModel, Ingresses.IngressModel>>
export type SubscriptionContract = Assert<ContractMatches<Author.SubscriptionUsage, Subscriptions.SubscriptionUsage>>
export type SubscriptionWindowContract = Assert<ContractMatches<Author.SubscriptionUsageWindow, Subscriptions.SubscriptionUsageWindow>>
export type SubscriptionCreditContract = Assert<ContractMatches<Author.SubscriptionResetCredit, Subscriptions.SubscriptionResetCredit>>
export type SubscriptionResetContract = Assert<ContractMatches<Author.SubscriptionResetResult, Subscriptions.SubscriptionResetResult>>
export type ApiKeyContract = Assert<ContractMatches<Author.ApiKeyRecord, Authentication.ApiKeyRecord>>
export type FallbackContract = Assert<ContractMatches<Author.FallbackStrategy, Authentication.FallbackStrategy>>

// Every core type is checked independently so drift cannot hide behind a method
// parameter's variance or an optional parent object.
export type CoreContracts = [
  Assert<ContractMatches<Author.LLMRequest, Core.LLMRequest>>,
  Assert<ContractMatches<Author.Message, Core.Message>>,
  Assert<Equal<Author.Content, Core.Content>>,
  Assert<ContractMatches<Author.ContentBlock, Core.ContentBlock>>,
  Assert<ContractMatches<Author.ToolUse, Core.ToolUse>>,
  Assert<ContractMatches<Author.ToolResult, Core.ToolResult>>,
  Assert<ContractMatches<Author.MessageMeta, Core.MessageMeta>>,
  Assert<ContractMatches<Author.Tool, Core.Tool>>,
  Assert<Equal<Author.ToolChoice, Core.ToolChoice>>,
  Assert<Equal<Author.ThinkingEffort, Core.ThinkingEffort>>,
  Assert<ContractMatches<Author.ThinkingRequest, Core.ThinkingRequest>>,
  Assert<Equal<Author.OutputFormat, Core.OutputFormat>>,
  Assert<ContractMatches<Author.GenerateConfig, Core.GenerateConfig>>,
  Assert<ContractMatches<Author.TokenLogprob, Core.TokenLogprob>>,
  Assert<ContractMatches<Author.LLMResponse, Core.LLMResponse>>,
  Assert<ContractMatches<Author.ToolCall, Core.ToolCall>>,
  Assert<ContractMatches<Author.Usage, Core.Usage>>,
  Assert<ContractMatches<Author.EmbeddingRequest, Core.EmbeddingRequest>>,
  Assert<ContractMatches<Author.EmbeddingResponse, Core.EmbeddingResponse>>,
  Assert<ContractMatches<Author.LLMStreamChunk, Core.LLMStreamChunk>>,
  Assert<ContractMatches<Author.ToolCallDelta, Core.ToolCallDelta>>,
  Assert<ContractMatches<Author.ProviderConfig, Core.ProviderConfig>>,
  Assert<ContractMatches<Author.ModelConfig, Core.ModelConfig>>,
  Assert<ContractMatches<Author.ModelInfo, Core.ModelInfo>>,
  Assert<ContractMatches<Author.ProtocolParser, Core.ProtocolParser>>,
  Assert<ContractMatches<Author.ProtocolSerializer, Core.ProtocolSerializer>>,
  Assert<ContractMatches<Author.ProviderAdapter, Core.ProviderAdapter>>
]

// Prove the checker rejects missing/extra optional fields and changed signatures.
export type RejectExtra = Assert<Equal<ContractMatches<Author.PluginManifest & { extra?: string }, Author.PluginManifest>, false>>
export type RejectMissing = Assert<Equal<ContractMatches<Omit<Author.PluginManifest, 'engines'>, Author.PluginManifest>, false>>
export type RejectParameter = Assert<Equal<ContractMatches<{ call(value: string): void }, { call(value: string | number): void }>, false>>
export type RejectReturn = Assert<Equal<ContractMatches<{ call(): void }, { call(): string }>, false>>
export type RejectAny = Assert<Equal<ContractMatches<{ value: any }, { value: string }>, false>>
export type RejectReadonly = Assert<Equal<ContractMatches<{ readonly value: string }, { value: string }>, false>>

// Event normalization must not erase unrelated fields or widened event inputs.
export type RejectAnyEvent = Assert<Equal<ContractMatches<{ event: any }, { event: H3Event }>, false>>
export type RejectUnknownEvent = Assert<Equal<ContractMatches<{ event: unknown }, { event: H3Event }>, false>>
export type RejectEventReturn = Assert<Equal<ContractMatches<
  { extractKey(event: Author.H3Event): number },
  { extractKey(event: H3Event): string }
>, false>>
export type RejectAdmissionDrift = Assert<Equal<ContractMatches<
  Omit<Author.AdmissionContext, 'model'> & { model?: string }, Hooks.AdmissionContext
>, false>>
export type RejectUnrelatedEvent = Assert<Equal<ContractMatches<
  { unrelated: Author.H3Event }, { unrelated: H3Event }
>, false>>

function eventUsage(event: H3Event, api: Author.PluginAPI) {
  const publicEvent: Author.H3Event = event
  const request: import('node:http').IncomingMessage = publicEvent.node.req
  const response: import('node:http').ServerResponse = publicEvent.node.res
  const parameter: string | undefined = publicEvent.context.params?.id
  const extension: unknown = publicEvent.context.pluginData
  api.registerRoute('GET', '/example', authorEvent => {
    const path: string = authorEvent.path
    authorEvent.node.res.setHeader('x-example-path', path)
    return authorEvent.headers.get('accept')
  })
  // @ts-expect-error The portable surface intentionally excludes h3 internals.
  publicEvent._handled
  return { request, response, parameter, extension }
}
void eventUsage

// Check generic constraints, default type arguments and concrete instantiation;
// ReturnType alone would erase the generic relationship on require/getItem.
function authorUsage(api: Author.PluginAPI) {
  const service = api.require<{ format(value: string): string }>('example-text-service')
  const formatted: string | undefined = service?.format('hello')
  const defaultService = api.require('example-text-service')
  type DefaultService = Assert<Equal<typeof defaultService, Record<string, unknown> | undefined>>
  api.provide({ format: (value: string) => value })
  // @ts-expect-error Services must be objects.
  api.provide('not an object')
  // @ts-expect-error The requested service must be an object.
  api.require<string>('example-text-service')
  // @ts-expect-error Dependency identifiers must be strings.
  api.require(42)
  const stored: Promise<{ count: number } | null> = api.storage.getItem<{ count: number }>('count')
  return { formatted, stored } as { formatted: typeof formatted; stored: typeof stored; checked?: DefaultService }
}
void authorUsage
