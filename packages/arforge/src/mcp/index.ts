import path from "node:path"
import fs from "node:fs"
import { pathToFileURL } from "node:url"
import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { ConfigV1 } from "@arforge-ai/core/v1/config/config"
import { serviceUse } from "@arforge-ai/core/effect/service-use"
import { Client, type ClientOptions } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js"
import {
  ListRootsRequestSchema,
  type LoggingMessageNotification,
  LoggingMessageNotificationSchema,
  type Tool as MCPToolDef,
  ToolListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js"
import { Config } from "@/config/config"
import { ConfigMCPV1 } from "@arforge-ai/core/v1/config/mcp"
import { ConfigMCP } from "@arforge-ai/core/config/mcp"
import { NamedError } from "@arforge-ai/core/util/error"
import { InstallationVersion } from "@arforge-ai/core/installation/version"
import { withTimeout } from "@/util/timeout"
import { FSUtil } from "@arforge-ai/core/fs-util"
import { McpOAuthPendingProvider, McpOAuthProvider, OAUTH_CALLBACK_PATH } from "./oauth-provider"
import { McpOAuthCallback } from "./oauth-callback"
import { McpAuth } from "./auth"
import { EventV2Bridge } from "@/event-v2-bridge"
import { TuiEvent } from "@/server/tui-event"
import { Cause, Effect, Exit, Layer, Context, Option, Schema, Semaphore, Stream } from "effect"
import { EffectBridge } from "@/effect/bridge"
import { InstanceState } from "@/effect/instance-state"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { CrossSpawnSpawner } from "@arforge-ai/core/cross-spawn-spawner"
import { McpCatalog } from "./catalog"
import { McpEvent } from "@arforge-ai/schema/mcp-event"
import { McpBrowser } from "./browser"
import { allowlistedChildEnvironment } from "@arforge-ai/core/secret-environment"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { Project } from "@arforge-ai/schema/project"
import { ActionGateway } from "@arforge-ai/core/action-gateway"
import { ControlPrincipal } from "@arforge-ai/core/runtime/control-principal"
import { DurableAction } from "@arforge-ai/core/runtime/durable-action"
import * as RuntimeInvariants from "@arforge-ai/core/runtime/invariants"
import { Location } from "@arforge-ai/core/location"
import { LocationServiceMap } from "@arforge-ai/core/location-services"
import { Database } from "@arforge-ai/core/database/database"
import { AbsolutePath } from "@arforge-ai/core/schema"
import { EventV2 } from "@arforge-ai/core/event"
import { Deferred, Fiber } from "effect"
import { Global } from "@arforge-ai/core/global"
import { SecretProvider } from "@arforge-ai/core/secret-provider"
import { EffectFlock } from "@arforge-ai/core/util/effect-flock"
import { KeyedMutex } from "@arforge-ai/core/effect/keyed-mutex"
import { makeIntentSealer } from "./intent-key"
import {
  awaitLocalAttemptTermination,
  makeLocalAttemptTombstones,
  nextCancellationDisposition,
  type LocalAttemptCancellationDisposition,
} from "./cancellation"
import {
  McpSupervisor,
  assertRuntimeInvariant,
  checkpointProjection,
  registerInvariants as registerSupervisorInvariants,
  supervisorEventData,
  type McpSupervisorSnapshot,
  type SupervisorCheckpoint,
  type SupervisorDecision,
} from "./supervisor"
import {
  capabilityPermission,
  McpCapabilityRegistry,
  safeCapabilityKey,
  safeCapabilityReference,
  type McpCapability,
  type McpCapabilityKind,
} from "./capability-registry"
import { SandboxRunner } from "@/sandbox/runner"
import { observeLocalStartupError, TransportOutcomeUnknownError } from "./transport-error"
import { isMcpTaskID, type McpTaskLookupState } from "./reconciliation"

function effectiveTimeouts(timeout?: ConfigMCPV1.Info["timeout"], defaults?: ConfigMCPV1.Info["timeout"]) {
  return ConfigMCP.resolveTimeouts(
    ConfigMCPV1.canonicalTimeout(timeout, "server"),
    ConfigMCPV1.canonicalTimeout(defaults, "defaults"),
  )
}
const RECOVERY_SCAN_LIMIT = 100_000
/** Background remote health checks are bounded and slow enough for normal MCP servers. */
const MCP_HEALTH_MONITOR_INTERVAL_MS = 5_000
/** Keep cancellation responsive even if a third-party transport ignores close. */
const LOCAL_ATTEMPT_CLOSE_GRACE = 2_000
/**
 * A catalogue read is allowed a small number of generation-fenced retries.
 * Reconnects are external to the read and may otherwise leave a permanently
 * mixed projection; the bound keeps a flapping server from turning a CLI/API
 * request into an unbounded loop.
 */
const MCP_CATALOG_FENCE_ATTEMPTS = 3
/** Give a replacement transport a bounded scheduling window before retrying. */
const MCP_CATALOG_FENCE_RETRY_DELAY_MS = 25
const CLIENT_OPTIONS = {
  capabilities: {
    // sampling: {},
    // elicitation: {},
    roots: {},
    // tasks: {},
  },
} satisfies ClientOptions

const capabilityLeaseProofPayload = (input: {
  readonly id: string
  readonly server: string
  readonly generation: number
  readonly kind: McpCapabilityKind
  readonly reference?: string
  readonly template?: string
}) => ({
  version: 1,
  purpose: "mcp-capability-lease",
  id: input.id,
  server: input.server,
  generation: input.generation,
  kind: input.kind,
  // The target reference is intentionally kept exact inside the HMAC input;
  // it never leaves the process.  Only the lease's public redacted reference
  // is returned to a caller.
  reference: input.reference ?? null,
  template: input.template === undefined ? null : safeCapabilityReference(input.template),
})

export const Resource = Schema.Struct({
  name: Schema.String,
  uri: Schema.String,
  description: Schema.optional(Schema.String),
  mimeType: Schema.optional(Schema.String),
  client: Schema.String,
}).annotate({ identifier: "McpResource" })
export type Resource = Schema.Schema.Type<typeof Resource>

export const ToolsChanged = McpEvent.ToolsChanged

export const BrowserOpenFailed = McpEvent.BrowserOpenFailed

export const Failed = NamedError.create("MCPFailed", {
  name: Schema.String,
})

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("MCP.NotFoundError", {
  name: Schema.String,
}) {}

type MCPClient = Client

function createClient(directory: string) {
  const client = new Client({ name: "arforge", version: InstallationVersion }, CLIENT_OPTIONS)
  client.setRequestHandler(ListRootsRequestSchema, () =>
    Promise.resolve({ roots: [{ uri: pathToFileURL(directory).href }] }),
  )
  return client
}

const StatusConnected = Schema.Struct({ status: Schema.Literal("connected") }).annotate({
  identifier: "MCPStatusConnected",
})
const StatusDisabled = Schema.Struct({ status: Schema.Literal("disabled") }).annotate({
  identifier: "MCPStatusDisabled",
})
const StatusFailed = Schema.Struct({ status: Schema.Literal("failed"), error: Schema.String }).annotate({
  identifier: "MCPStatusFailed",
})
const StatusNeedsAuth = Schema.Struct({ status: Schema.Literal("needs_auth") }).annotate({
  identifier: "MCPStatusNeedsAuth",
})
const StatusNeedsClientRegistration = Schema.Struct({
  status: Schema.Literal("needs_client_registration"),
  error: Schema.String,
}).annotate({ identifier: "MCPStatusNeedsClientRegistration" })
const StatusNeedsApproval = Schema.Struct({
  status: Schema.Literal("needs_approval"),
  reason: Schema.String,
}).annotate({ identifier: "MCPStatusNeedsApproval" })

export const Status = Schema.Union([
  StatusConnected,
  StatusDisabled,
  StatusFailed,
  StatusNeedsAuth,
  StatusNeedsClientRegistration,
  StatusNeedsApproval,
]).annotate({ identifier: "MCPStatus", discriminator: "status" })
export type Status = Schema.Schema.Type<typeof Status>

export { McpSupervisorSnapshot } from "./supervisor"

// OAuth transports are process-global because a callback can finish after an
// InstanceState reload. They are nevertheless scoped to a canonical project
// and server, and every generation carries a protected configuration identity.
type TransportWithAuth = StreamableHTTPClientTransport | SSEClientTransport
type FrozenRemoteConfig = Readonly<ConfigMCPV1.Info & { readonly type: "remote" }>
interface OAuthIdentity {
  readonly projectPrefix: string
  readonly server: string
  readonly generation: string
  readonly configDigest: string
  /** Opaque key for credential, PKCE, and state persistence. */
  readonly authKey: string
  /** Opaque key for the process-global OAuth callback reverse index. */
  readonly callbackKey: string
}
interface PendingOAuthTransport {
  readonly identity: OAuthIdentity
  readonly remote: FrozenRemoteConfig
  readonly transport: TransportWithAuth
  readonly provider?: McpOAuthPendingProvider
  /** Set only by the pending provider's redirect callback. */
  authorizationUrl: string | undefined
}
const pendingOAuthTransports = new Map<string, PendingOAuthTransport>()

// Prompt cache types
type PromptInfo = Awaited<ReturnType<MCPClient["listPrompts"]>>["prompts"][number]
type ResourceInfo = Awaited<ReturnType<MCPClient["listResources"]>>["resources"][number]
type ResourceTemplateInfo = Awaited<ReturnType<MCPClient["listResourceTemplates"]>>["resourceTemplates"][number]
type McpEntry = NonNullable<ConfigV1.Info["mcp"]>[string]

function isMcpConfigured(entry: McpEntry): entry is ConfigMCPV1.Info {
  return typeof entry === "object" && entry !== null && "type" in entry
}

function remoteURL(value: string) {
  if (URL.canParse(value)) return new URL(value)
}

interface CreateResult {
  mcpClient?: MCPClient
  status: Status
  defs?: MCPToolDef[]
  instructions?: string
}

interface AuthResult {
  authorizationUrl: string
  oauthState: string
  identity: OAuthIdentity
  pending: PendingOAuthTransport
  client?: MCPClient
}

// --- Effect Service ---

interface State {
  config: Record<string, ConfigMCPV1.Info>
  status: Record<string, Status>
  clients: Record<string, MCPClient>
  defs: Record<string, MCPToolDef[]>
  instructions: Record<string, string>
  /** Single generation-scoped projection for tools, prompts and resources. */
  readonly capabilities: McpCapabilityRegistry
  /** Exact in-memory targets used only to mint installation-bound leases. */
  readonly capabilityTargets: Map<
    string,
    Map<
      string,
      { readonly kind: Exclude<McpCapabilityKind, "tool">; readonly generation: number; readonly reference: string }
    >
  >
  /** Shared read admission across simultaneous callers and server catalogs. */
  readonly catalogReads: Semaphore.Semaphore
  /** Effect bridge captured for callbacks and the background health monitor. */
  readonly bridge: EffectBridge.Shape
  /** One supervisor is the sole connection-health/retry authority per server. */
  supervisors: Map<string, McpSupervisor>
  /** Digest of the last successfully committed durable supervisor checkpoint. */
  readonly supervisorCheckpointDigests: Map<string, string>
  /** One scheduled recovery fiber per remote server; all retries flow here. */
  readonly reconnectFibers: Map<string, Fiber.Fiber<unknown, unknown>>
  /** Requests captured before the layer finished wiring the recovery handler. */
  readonly pendingReconnects: Map<string, { readonly generation: number; readonly bridge: EffectBridge.Shape }>
  /** One cancellable monitor per instance; it exits when no remote client remains. */
  healthMonitorFiber: Fiber.Fiber<unknown, unknown> | undefined
  /** In-flight or pending authorized local connect attempts, keyed by server name. */
  connecting: Map<string, LocalAttempt>
  /** Stable per-project prefix for cross-runtime local-attempt tombstones. */
  readonly localAttemptPrefix: string
  /** Frozen local intent currently backing an already connected client. */
  readonly localClientConfigDigests: Map<string, string>
  /** Pending OAuth generations created by this concrete InstanceState. */
  readonly oauthPending: Set<PendingOAuthTransport>
}

/**
 * One authorized local stdio connect attempt. The durable action identity and
 * the pending control request identity are minted before any spawn and are
 * the source of truth for the `needs_approval` status. The attempt is
 * registered in `State.connecting` atomically BEFORE its fiber is forked, so
 * the map never misses a live attempt. `origin` records who initiated the
 * attempt for the durable initiator field ("recovery" for startup/recovery,
 * "user" for explicit add/connect).
 */
interface LocalAttempt {
  readonly server: string
  readonly actionID: AgentRuntime.ActionID
  readonly subject: AgentRuntime.ControlPlaneSubject
  readonly requestID: AgentRuntime.ControlPlaneRequestID
  readonly intent: ConnectIntent
  readonly origin: ConnectOrigin
  readonly deferred: Deferred.Deferred<AttemptOutcome>
  /**
   * `cancelling` is a server-name tombstone, not a finished action. It blocks
   * every replacement until this exact runner has exited.
   */
  phase: "active" | "cancelling"
  /**
   * Shutdown/reload cancels the runner but retains an unapproved durable
   * request so the next InstanceState can resume that exact user decision.
   * Explicit disable/replace/disconnect instead settles it as superseded.
   */
  cancellationDisposition: LocalAttemptCancellationDisposition | undefined
  /** Direct compensation handle once the approved stdio transport exists. */
  transport: StdioClientTransport | undefined
  /** Cancellation handle: interrupting it on disconnect keeps the spawn at 0. */
  fiber: Fiber.Fiber<AttemptOutcome, unknown> | undefined
}

type AttemptOutcome = { readonly kind: "connected" } | { readonly kind: "failed"; readonly reason: string }
type CancellationResult = "terminated" | "timed_out" | "settlement_failed"

/** Who initiated the connect: an explicit user action or startup/recovery. */
type ConnectOrigin = "user" | "recovery"

/**
 * InstanceState is disposed during reload while EffectBridge runners can still
 * be in non-cooperative third-party code. Keep the server-name tombstone
 * process-local until that runner terminates so a rebuilt runtime cannot spawn
 * a replacement beside it. The key includes the real project directory.
 */
const localAttemptTombstones = makeLocalAttemptTombstones<LocalAttempt>()
/**
 * Serializes state transitions for one canonical project/server pair across
 * InstanceState reloads. KeyedMutex removes idle entries, so this process-local
 * safety fence cannot grow with historical MCP names.
 */
const localAttemptTransitions = KeyedMutex.makeUnsafe<string>()

type ExecutableIdentity = Readonly<{
  realpath: string
  device: number
  inode: number
  size: number
  modifiedMs: number
  createdMs: number
}>

type FrozenSpawnSpec = Readonly<{
  executable: string
  executableIdentity: ExecutableIdentity
  argv: ReadonlyArray<string>
  cwd: string
  readOnlyRoots?: ReadonlyArray<Readonly<{ path: string; device: number; inode: number }>>
  timeout: ReturnType<typeof ConfigMCP.resolveTimeouts>
  environment: Readonly<Record<string, string>>
  bunBehavior: boolean
}>

/**
 * Canonical, frozen, redacted intent of one local connect: server name, the
 * platform-resolved absolute executable (realpath), the canonical argv
 * digest, the canonical frozen workdir (realpath), explicit environment key
 * NAMES (never values), and the canonical config digest. The spawn uses this
 * frozen spec — never mutable caller config — and rechecks launcher metadata
 * immediately before spawn. This detects ordinary launcher replacement and
 * prevents approval reuse across config changes. It is not an OS-level atomic
 * file-handle guarantee and does not attest scripts or modules later loaded by
 * an interpreter; signed artifacts and sandbox enforcement belong to the
 * Execution Runtime boundary.
 */
type ConnectIntent = {
  readonly name: string
  readonly executable: string
  readonly argvDigest: string
  readonly cwd: string
  readonly envKeys: ReadonlyArray<string>
  readonly resources: ReadonlyArray<string>
  readonly configDigest: string
  readonly spawn: FrozenSpawnSpec
}

export interface ServerInstructions {
  name: string
  instructions: string
  tools: string[]
}

/**
 * One coherent, generation-fenced MCP catalogue read.  User-facing API and
 * CLI surfaces must consume this snapshot instead of independently invoking
 * prompts/resources/resourceTemplates and accidentally presenting a mixed
 * view from different refreshes.
 */
export type CatalogSnapshot = Readonly<{
  prompts: Readonly<Record<string, PromptInfo & { client: string; generation?: number }>>
  resources: Readonly<Record<string, ResourceInfo & { client: string; generation?: number }>>
  resourceTemplates: Readonly<Record<string, ResourceTemplateInfo & { client: string; generation?: number }>>
  capabilities: readonly McpCapability[]
}>

/**
 * A short-lived generation-bound capability lease for one MCP capability.
 * It carries only redacted registry identity and an opaque target proof; the
 * Client, endpoint and credentials remain private to the MCP service.
 */
export type McpCapabilityLease = Readonly<{
  readonly id: string
  readonly server: string
  readonly generation: number
  readonly kind: McpCapabilityKind
  /** For resource/template leases, the redacted URI used for this read. */
  readonly reference?: string
  /**
   * Opaque, installation-bound proof of the exact target URI.  The proof is
   * never interpreted by callers and prevents a generated template lease
   * from being redirected to another expansion by changing only metadata.
   */
  readonly proof?: string
  /** Redacted source template for a resource-template lease. */
  readonly template?: string
}>

/** An MCP tool in its native shape; consumers adapt it to their own tool format. */
export interface McpTool {
  /** Shared cached definition; consumers must copy rather than mutate it. */
  readonly def: MCPToolDef
  readonly client: MCPClient
  readonly timeout?: number
  /** Supervisor generation that produced this definition. */
  readonly generation?: number
}

export interface Interface {
  readonly status: () => Effect.Effect<Record<string, Status>>
  /**
   * Returns redacted connection health. `probe` performs MCP ping for live
   * clients; the normal status endpoint remains side-effect free.
   */
  readonly health: (options?: { readonly probe?: boolean }) => Effect.Effect<Record<string, McpSupervisorSnapshot>>
  readonly clients: () => Effect.Effect<Record<string, MCPClient>>
  /** Safe, generation-scoped capability projection; never exposes a Client. */
  readonly capabilities?: () => Effect.Effect<readonly McpCapability[]>
  /** Fail closed when a caller retained a capability across a reconnect. */
  readonly assertCapability?: (input: {
    readonly id: string
    readonly server: string
    readonly generation: number
    readonly kind?: McpCapabilityKind
  }) => Effect.Effect<void, Error>
  /**
   * Mints a short-lived, generation-bound lease for a capability target.
   * Resource/template targets include an installation-bound proof of the
   * exact URI; callers that cannot obtain a current lease must fail closed.
   */
  readonly leaseForCapability?: (input: {
    readonly id: string
    readonly server: string
    readonly generation: number
    readonly kind: McpCapabilityKind
    readonly reference?: string
    readonly template?: string
  }) => Effect.Effect<McpCapabilityLease | undefined>
  readonly instructions: () => Effect.Effect<ServerInstructions[]>
  readonly tools: () => Effect.Effect<Record<string, McpTool>>
  readonly prompts: () => Effect.Effect<Record<string, PromptInfo & { client: string; generation?: number }>>
  readonly resources: (
    clientName?: string,
  ) => Effect.Effect<Record<string, ResourceInfo & { client: string; generation?: number }>>
  readonly resourceTemplates: (
    clientName?: string,
  ) => Effect.Effect<Record<string, ResourceTemplateInfo & { client: string; generation?: number }>>
  /**
   * Refreshes all three protocol catalogues and returns one immutable
   * generation-fenced projection for user-facing API/CLI readers.
   */
  readonly catalog: () => Effect.Effect<CatalogSnapshot>
  readonly add: (name: string, mcp: ConfigMCPV1.Info) => Effect.Effect<{ status: Record<string, Status> | Status }>
  readonly connect: (name: string) => Effect.Effect<void, NotFoundError>
  readonly disconnect: (name: string) => Effect.Effect<void, NotFoundError>
  readonly getPrompt: (
    clientName: string,
    name: string,
    args?: Record<string, string>,
    generationOrLease?: number | McpCapabilityLease,
  ) => Effect.Effect<Awaited<ReturnType<MCPClient["getPrompt"]>> | undefined>
  readonly readResource: (
    clientName: string,
    resourceUri: string,
    lease?: McpCapabilityLease,
    options?: { readonly propagateTransportError?: boolean },
  ) => Effect.Effect<Awaited<ReturnType<MCPClient["readResource"]>> | undefined, Error>
  /**
   * Reads an official MCP task status for reconciliation. This operation is
   * intentionally separate from tool execution and never fetches task result
   * payloads or creates a new transport attempt.
   */
  readonly lookupTask?: (
    clientName: string,
    taskID: string,
    generation?: number,
  ) => Effect.Effect<McpTaskLookupState | undefined, Error>
  /**
   * Optional host-provided read-only lookup for a non-`tasks` MCP vendor
   * operation. The default MCP runtime intentionally leaves this absent: an
   * embedding host must register an explicit provider contract before a
   * vendor operation can be reconciled. No result body or transport callback
   * crosses this seam.
   */
  readonly lookupExternalOperation?: (
    clientName: string,
    provider: string,
    operationID: string,
    generation?: number,
  ) => Effect.Effect<McpTaskLookupState | undefined, Error>
  /**
   * Scopes statically declared by a server's config: the canonical transport
   * endpoint (resolved URL origin for remote; protected, frozen local
   * configuration identity for local), credential identifier names, and the
   * configured external service identity.
   * Returns undefined when the server is not configured or the endpoint
   * cannot be resolved — callers must fail closed on undefined, never fall
   * back to an interactive prompt for missing auditable scope evidence.
   */
  readonly declaredScope: (clientName: string) => Effect.Effect<
    | {
        readonly endpoint: string
        readonly networkScope: string[]
        readonly secretScope: string[]
        readonly externalServices: string[]
      }
    | undefined
  >
  readonly startAuth: (
    mcpName: string,
  ) => Effect.Effect<{ authorizationUrl: string; oauthState: string }, NotFoundError>
  readonly authenticate: (
    mcpName: string,
    onAuthorization?: (authorizationUrl: string) => void,
  ) => Effect.Effect<Status, NotFoundError>
  /** Complete only the exact OAuth attempt returned by startAuth. */
  readonly finishAuth: (
    mcpName: string,
    authorizationCode: string,
    oauthState: string,
  ) => Effect.Effect<Status, NotFoundError>
  readonly removeAuth: (mcpName: string) => Effect.Effect<void>
  readonly supportsOAuth: (mcpName: string) => Effect.Effect<boolean, NotFoundError>
  readonly hasStoredTokens: (mcpName: string) => Effect.Effect<boolean>
  readonly getAuthStatus: (mcpName: string) => Effect.Effect<AuthStatus>
}

export class Service extends Context.Service<Service, Interface>()("@arforge/MCP") {}

export const use = serviceUse(Service)

/**
 * Builds the auditable scope evidence for one MCP server from its config.
 * Only canonical redacted identities are persisted: the remote endpoint is
 * the URL origin plus normalized path (never query, fragment, header,
 * environment, or OAuth values). Local configuration is intentionally only
 * reduced to its executable identifier here: this synchronous helper has no
 * access to the protected per-installation HMAC key. `MCP.declaredScope`
 * augments that local identity with the frozen, HMAC-sealed connect intent
 * before it can be used to authorize a tool call. Credential IDENTIFIER names
 * only are bound, never values.
 * Returns undefined — fail closed — when the config is missing, the transport
 * kind is unsupported, or the canonical endpoint cannot be resolved.
 */
export function buildDeclaredScope(
  mcpConfig: ConfigMCPV1.Info,
): { endpoint: string; networkScope: string[]; secretScope: string[]; externalServices: string[] } | undefined {
  const networkScope: string[] = []
  const secretScope: string[] = []
  if ("environment" in mcpConfig && mcpConfig.environment) secretScope.push(...Object.keys(mcpConfig.environment))
  if (mcpConfig.type === "remote") {
    const url = remoteURL(mcpConfig.url)
    if (!url) return undefined
    // Origin plus normalized path only: query and fragment may carry
    // credentials and are never persisted in any scope string.
    const pathname = url.pathname.replace(/\/+$/, "")
    const endpoint = pathname.length > 0 ? `${url.origin}${pathname}` : url.origin
    networkScope.push(url.origin)
    if (mcpConfig.headers) secretScope.push(...Object.keys(mcpConfig.headers))
    if (mcpConfig.oauth !== false) secretScope.push("mcp-oauth")
    return { endpoint, networkScope, secretScope, externalServices: [] }
  }
  if (mcpConfig.type === "local") {
    const [command] = mcpConfig.command
    if (!command) return undefined
    // Arguments may themselves contain credentials. Do not substitute a
    // naked deterministic hash here: it would permit offline guessing of
    // secrets present in argv. The effectful service binds this incomplete
    // static identity to the frozen configuration with its protected HMAC.
    return { endpoint: `exec:${command}`, networkScope, secretScope, externalServices: [] }
  }
  return undefined
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const sandbox = yield* SandboxRunner.Service
    const auth = yield* McpAuth.Service
    const events = yield* EventV2Bridge.Service
    const locations = yield* LocationServiceMap.Service
    const cfgSvc = yield* Config.Service

    function catalogDefs(
      s: State,
      clientName: string,
      client: MCPClient,
      timeout?: number,
    ): Effect.Effect<MCPToolDef[] | undefined> {
      // During the initial connect/OAuth handshake the client is not yet
      // published in State; its frozen config/intent is validated by the
      // connect path itself.  Once a connected generation receives a
      // tools/list-changed notification, however, require the same live scope
      // fence as the public catalogue methods before touching the SDK.
      const enforceScope = s.clients[clientName] === client && s.status[clientName]?.status === "connected"
      const defsRead = McpCatalog.defs(client, timeout).pipe(Effect.map((defs) => defs ?? undefined))
      const read: Effect.Effect<MCPToolDef[] | undefined> = enforceScope
        ? Effect.gen(function* () {
            if (!(yield* declaredScope(clientName))) {
              yield* Effect.logWarning("MCP tool catalogue refresh blocked: missing declared scope", {
                server: clientName,
              })
              return undefined
            }
            const defs = yield* McpCatalog.defs(client, timeout)
            return defs ?? undefined
          })
        : defsRead
      return read.pipe(s.catalogReads.withPermit)
    }
    const browser = yield* McpBrowser.Service
    const invariants = yield* RuntimeInvariants.Service
    registerSupervisorInvariants(invariants)
    const sealedDigest = yield* makeIntentSealer()
    const withTimeouts = Effect.fnUntraced(function* (mcp: ConfigMCPV1.Info) {
      const cfg = yield* cfgSvc.get()
      return { ...mcp, timeout: effectiveTimeouts(mcp.timeout, cfg.experimental?.mcp_timeout) }
    })
    /** Maps a supervisor back to its instance state for checkpoint identity.
     * The object itself is process-local; the persisted aggregate ID is an
     * HMAC of the canonical project directory and server name. */
    const supervisorOwners = new WeakMap<McpSupervisor, State>()

    type Transport = StdioClientTransport | StreamableHTTPClientTransport | SSEClientTransport

    /**
     * Make a stable, redacted representation before sealing a remote OAuth
     * configuration. Header and OAuth values are intentionally included in
     * the HMAC input so a secret-only configuration replacement cannot reuse
     * an old authorization; neither the values nor a naked hash escape this
     * process.
     */
    const canonicalRemoteOAuthConfig = (key: string, mcp: ConfigMCPV1.Info & { type: "remote" }) => {
      const headers = Object.entries(mcp.headers ?? {})
        .filter(([, value]) => value !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
      const oauth =
        typeof mcp.oauth === "object"
          ? Object.entries(mcp.oauth)
              .filter(([, value]) => value !== undefined)
              .sort(([left], [right]) => left.localeCompare(right))
          : mcp.oauth === false
            ? false
            : "default"
      return {
        version: 1,
        server: key,
        type: "remote" as const,
        url: mcp.url,
        enabled: mcp.enabled !== false,
        timeout: effectiveTimeouts(mcp.timeout),
        headers,
        oauth,
      }
    }

    const freezeRemoteConfig = (mcp: ConfigMCPV1.Info & { type: "remote" }): FrozenRemoteConfig => {
      const headers = mcp.headers
        ? Object.freeze(
            Object.fromEntries(Object.entries(mcp.headers).sort(([left], [right]) => left.localeCompare(right))),
          )
        : undefined
      const oauth =
        typeof mcp.oauth === "object"
          ? Object.freeze(
              Object.fromEntries(Object.entries(mcp.oauth).sort(([left], [right]) => left.localeCompare(right))),
            )
          : mcp.oauth
      return Object.freeze({
        ...mcp,
        timeout: effectiveTimeouts(mcp.timeout),
        headers,
        oauth,
      }) as FrozenRemoteConfig
    }

    const oauthMapKey = (s: State, key: string) => `${s.localAttemptPrefix}\0${key}`

    const oauthAuthKeyFor = (projectPrefix: string, key: string) => {
      const authIdentity = sealedDigest({ version: 1, purpose: "mcp-oauth-auth", project: projectPrefix, server: key })
      if (!authIdentity) throw new Error(`MCP 服务 ${key} 的 OAuth 身份无法规范化`)
      return `mcp-oauth:${authIdentity}`
    }

    const remoteOAuthIdentity = (s: State, key: string, mcp: ConfigMCPV1.Info & { type: "remote" }) => {
      const configDigest = sealedDigest(canonicalRemoteOAuthConfig(key, mcp))
      const generation = crypto.randomUUID()
      const callbackIdentity = sealedDigest({
        version: 1,
        purpose: "mcp-oauth-callback",
        project: s.localAttemptPrefix,
        server: key,
        generation,
      })
      if (!configDigest || !callbackIdentity) throw new Error(`MCP 服务 ${key} 的 OAuth 配置无法规范化`)
      return Object.freeze({
        projectPrefix: s.localAttemptPrefix,
        server: key,
        generation,
        configDigest,
        authKey: oauthAuthKeyFor(s.localAttemptPrefix, key),
        callbackKey: `mcp-oauth-callback:${callbackIdentity}`,
      }) satisfies OAuthIdentity
    }

    const sameRemoteOAuthConfig = (identity: OAuthIdentity, mcp: ConfigMCPV1.Info | undefined) => {
      if (!mcp || mcp.type !== "remote" || mcp.enabled === false) return false
      return sealedDigest(canonicalRemoteOAuthConfig(identity.server, mcp)) === identity.configDigest
    }

    const supervisorFor = (s: State, name: string) => {
      const existing = s.supervisors.get(name)
      if (existing) return existing
      const created = new McpSupervisor(name)
      s.supervisors.set(name, created)
      supervisorOwners.set(created, s)
      return created
    }

    const supervisorAggregateID = (s: State, name: string) => {
      const digest = sealedDigest({
        version: 1,
        purpose: "mcp-supervisor-checkpoint",
        project: s.localAttemptPrefix,
        server: name,
      })
      if (!digest) throw new Error(`MCP 服务 ${name} 的持久化身份无法规范化`)
      return `mcp-supervisor:${digest}`
    }

    const checkpointDigest = (checkpoint: SupervisorCheckpoint) =>
      JSON.stringify([
        checkpoint.server,
        checkpoint.desiredGeneration,
        checkpoint.observedGeneration,
        checkpoint.phase,
        checkpoint.health,
        checkpoint.failureCount,
        checkpoint.nextRetryAt,
        checkpoint.circuitOpenedAt,
        checkpoint.drainDeadline,
        checkpoint.lastFailure,
        checkpoint.safeMessage,
      ])

    const publishSupervisor = (supervisor: McpSupervisor) => {
      const snapshot = supervisor.snapshot()
      const owner = supervisorOwners.get(supervisor)
      const live = assertRuntimeInvariant(invariants, "snapshot", { kind: "snapshot", snapshot }).pipe(
        Effect.orDie,
        Effect.andThen(events.publish(McpEvent.SupervisorChanged, supervisorEventData(snapshot))),
        Effect.ignore,
      )
      if (!owner) return live

      const checkpoint = checkpointProjection(snapshot, Date.now())
      const digest = checkpointDigest(checkpoint)
      if (owner.supervisorCheckpointDigests.get(supervisor.server) === digest) return live

      const durable = assertRuntimeInvariant(invariants, "checkpoint", { kind: "checkpoint", checkpoint }).pipe(
        Effect.orDie,
        Effect.andThen(
          events.publish(McpEvent.SupervisorCheckpointed, {
            aggregateID: supervisorAggregateID(owner, supervisor.server),
            ...checkpoint,
          }),
        ),
        Effect.tap(() =>
          Effect.sync(() => {
            owner.supervisorCheckpointDigests.set(supervisor.server, digest)
            supervisor.rememberCheckpoint(checkpoint.savedAt)
          }),
        ),
        Effect.catchCause((cause) =>
          Effect.logWarning("MCP supervisor checkpoint could not be persisted", {
            server: supervisor.server,
            cause,
          }),
        ),
      )
      return live.pipe(Effect.andThen(durable), Effect.asVoid)
    }

    const restoreSupervisorCheckpoint = Effect.fnUntraced(function* (s: State, name: string) {
      if (!events.latest) return
      const aggregateID = supervisorAggregateID(s, name)
      const latestEvent = yield* events
        .latest(aggregateID)
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("MCP supervisor checkpoint could not be read", { server: name, cause }).pipe(
              Effect.as(undefined),
            ),
          ),
        )
      if (!latestEvent || latestEvent.type !== EventV2.versionedType(McpEvent.SupervisorCheckpointed.type, 1)) return
      const decoded = yield* Schema.decodeUnknownEffect(McpEvent.SupervisorCheckpointed.data)(latestEvent.data).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("MCP supervisor checkpoint was ignored due to schema mismatch", {
            server: name,
            cause,
          }).pipe(Effect.as(undefined)),
        ),
      )
      if (!decoded || decoded.aggregateID !== aggregateID || decoded.server !== name) return
      const checkpoint: SupervisorCheckpoint = {
        server: decoded.server,
        desiredGeneration: decoded.desiredGeneration,
        observedGeneration: decoded.observedGeneration,
        phase: decoded.phase,
        health: decoded.health,
        failureCount: decoded.failureCount,
        nextRetryAt: decoded.nextRetryAt,
        circuitOpenedAt: decoded.circuitOpenedAt,
        drainDeadline: decoded.drainDeadline,
        lastFailure: decoded.lastFailure,
        safeMessage: decoded.safeMessage,
        savedAt: decoded.savedAt,
      }
      const checkpointValid = yield* assertRuntimeInvariant(invariants, "checkpoint", {
        kind: "checkpoint",
        checkpoint,
      }).pipe(
        Effect.as(true),
        Effect.catchCause((cause) =>
          Effect.logWarning("MCP supervisor checkpoint was ignored due to invariant mismatch", {
            server: name,
            cause,
          }).pipe(Effect.as(false)),
        ),
      )
      if (!checkpointValid) return
      const supervisor = supervisorFor(s, name)
      supervisor.restoreCheckpoint(checkpoint)
      s.supervisorCheckpointDigests.set(name, checkpointDigest(checkpoint))
    })

    const supervisorFailure = (status: Status) => {
      if (status.status !== "failed") return undefined
      return status.error
    }

    const supervisorStart = (s: State, name: string, now = Date.now()): SupervisorDecision =>
      (() => {
        const decision = supervisorFor(s, name).requestConnect(now)
        if (decision.allowed) {
          s.capabilities.activate(name, decision.generation)
          s.capabilityTargets.delete(name)
        }
        return decision
      })()

    type ReconnectHandler = (
      state: State,
      server: string,
      generation: number,
      bridge: EffectBridge.Shape,
    ) => Effect.Effect<void>

    // The handler is assigned after createAndStore is declared. The queue is
    // therefore needed for a transport that closes during initial state
    // construction; no early callback is allowed to be silently lost.
    let reconnectHandlerReady = false
    let reconnectHandler: ReconnectHandler = () => Effect.void
    const activeStates = new Set<State>()

    const reconnectDelay = (snapshot: McpSupervisorSnapshot, now = Date.now()) => {
      if (snapshot.phase !== "backoff" && snapshot.phase !== "circuit_open") return undefined
      if (snapshot.nextRetryAt === null) return undefined
      return Math.max(0, snapshot.nextRetryAt - now)
    }

    const scheduleReconnect = (s: State, name: string) => {
      if (!reconnectHandlerReady || s.reconnectFibers.has(name)) return
      const request = s.pendingReconnects.get(name)
      if (!request) return
      const supervisor = supervisorFor(s, name)
      const snapshot = supervisor.snapshot()
      const delay = reconnectDelay(snapshot)
      if (delay === undefined || request.generation !== snapshot.desiredGeneration) {
        // A manual replacement or a successful parallel generation may have
        // made this request obsolete even when the generation number did not
        // change. Never retain an orphaned request in that case.
        s.pendingReconnects.delete(name)
        return
      }

      let fiber: Fiber.Fiber<unknown, unknown> | undefined
      const run = Effect.gen(function* () {
        if (delay > 0) yield* Effect.sleep(`${delay} millis`)
        const current = s.pendingReconnects.get(name)
        const currentSnapshot = supervisor.snapshot()
        if (!current || current.generation !== currentSnapshot.desiredGeneration) return
        s.pendingReconnects.delete(name)
        yield* reconnectHandler(s, name, current.generation, current.bridge)
      }).pipe(
        Effect.catchCause(() => Effect.void),
        Effect.ensuring(
          Effect.sync(() => {
            if (fiber && s.reconnectFibers.get(name) === fiber) s.reconnectFibers.delete(name)
            // A failed recovery may have queued the next supervisor window
            // while this fiber was still present in the map. Re-arm it only
            // after the old fiber is detached, preserving one fiber per name.
            if (s.pendingReconnects.has(name)) scheduleReconnect(s, name)
          }),
        ),
      )
      fiber = request.bridge.fork(run)
      s.reconnectFibers.set(name, fiber)
    }

    const requestReconnect = (s: State, name: string, bridge: EffectBridge.Shape) => {
      const snapshot = supervisorFor(s, name).snapshot()
      if (snapshot.phase !== "backoff" && snapshot.phase !== "circuit_open") return
      const current = s.pendingReconnects.get(name)
      if (!current || current.generation <= snapshot.desiredGeneration) {
        s.pendingReconnects.set(name, { generation: snapshot.desiredGeneration, bridge })
      }
      if (reconnectHandlerReady) scheduleReconnect(s, name)
    }

    const cancelScheduledReconnect = (s: State, name: string) =>
      Effect.gen(function* () {
        s.pendingReconnects.delete(name)
        const fiber = s.reconnectFibers.get(name)
        if (!fiber) return
        s.reconnectFibers.delete(name)
        yield* Fiber.interrupt(fiber).pipe(Effect.ignore)
      })

    type HealthProbeHandler = (state: State) => Effect.Effect<void>
    let healthProbeHandlerReady = false
    let healthProbeHandler: HealthProbeHandler = () => Effect.void

    const hasRemoteClient = (s: State) =>
      Object.values(s.clients).some((client) => !(client.transport instanceof StdioClientTransport))

    const startHealthMonitor = (s: State) => {
      if (!healthProbeHandlerReady || s.healthMonitorFiber || !hasRemoteClient(s)) return

      let fiber: Fiber.Fiber<unknown, unknown> | undefined
      const loop = Effect.gen(function* () {
        while (true) {
          yield* Effect.sleep(`${MCP_HEALTH_MONITOR_INTERVAL_MS} millis`)
          if (!activeStates.has(s) || !hasRemoteClient(s)) return
          yield* healthProbeHandler(s)
        }
      }).pipe(
        Effect.catchCause(() => Effect.void),
        Effect.ensuring(
          Effect.sync(() => {
            if (s.healthMonitorFiber !== fiber) return
            s.healthMonitorFiber = undefined
            // A replacement remote client may have arrived while the old
            // monitor was exiting. Re-arm only after the old fiber detaches.
            if (activeStates.has(s) && hasRemoteClient(s)) startHealthMonitor(s)
          }),
        ),
      )
      fiber = s.bridge.fork(loop)
      s.healthMonitorFiber = fiber
    }

    const stopHealthMonitor = (s: State) =>
      Effect.gen(function* () {
        const fiber = s.healthMonitorFiber
        s.healthMonitorFiber = undefined
        if (fiber) yield* Fiber.interrupt(fiber).pipe(Effect.ignore)
      })

    const closeOAuthTransport = (pending: PendingOAuthTransport) =>
      Effect.tryPromise(() => pending.transport.close()).pipe(Effect.ignore)

    /** Start closing without making a keyed state transition wait on opaque
     * third-party transport teardown. The identity has already been detached
     * before this is called, so no later completion can publish. */
    const closeOAuthTransportDetached = (pending: PendingOAuthTransport) =>
      Effect.sync(() => {
        void pending.transport.close().catch(() => {})
      })

    /** Delete only the exact pending generation. A delayed old finalizer or
     * callback can therefore never remove a newer generation for this pair. */
    const detachPendingOAuth = (s: State, key: string, pending?: PendingOAuthTransport) => {
      const mapKey = oauthMapKey(s, key)
      const current = pendingOAuthTransports.get(mapKey)
      if (!current || (pending && current !== pending)) return undefined
      pendingOAuthTransports.delete(mapKey)
      s.oauthPending.delete(current)
      return current
    }

    const installPendingOAuth = (s: State, pending: PendingOAuthTransport) => {
      const mapKey = oauthMapKey(s, pending.identity.server)
      const previous = pendingOAuthTransports.get(mapKey)
      pendingOAuthTransports.set(mapKey, pending)
      s.oauthPending.add(pending)
      if (previous) s.oauthPending.delete(previous)
      return previous
    }

    /**
     * Connect a client via the given transport with resource safety:
     * on failure the transport is closed; on success the caller owns it.
     */
    const connectTransport = Effect.fn("MCP.connectTransport")(function* (transport: Transport, timeout: number) {
      const directory = yield* InstanceState.directory
      return yield* Effect.acquireUseRelease(
        Effect.succeed(transport),
        (t) =>
          Effect.tryPromise({
            try: () => {
              const client = createClient(directory)
              return withTimeout(client.connect(t, { timeout, maxTotalTimeout: timeout }), timeout).then(() => client)
            },
            catch: (e) => (e instanceof Error ? e : new Error(String(e))),
          }),
        (t, exit) => (Exit.isFailure(exit) ? Effect.tryPromise(() => t.close()).pipe(Effect.ignore) : Effect.void),
      )
    })

    const DISABLED_RESULT: CreateResult = { status: { status: "disabled" } }

    const connectRemote = Effect.fn("MCP.connectRemote")(function* (
      s: State,
      key: string,
      mcp: ConfigMCPV1.Info & { type: "remote" },
    ) {
      const oauthDisabled = mcp.oauth === false
      const oauthConfig = typeof mcp.oauth === "object" ? mcp.oauth : undefined
      const url = remoteURL(mcp.url)
      if (!url) {
        return {
          client: undefined as MCPClient | undefined,
          status: { status: "failed" as const, error: `Invalid MCP URL for "${key}"` },
        }
      }
      let authProvider: McpOAuthProvider | undefined

      if (!oauthDisabled) {
        const identity = remoteOAuthIdentity(s, key, mcp)
        authProvider = new McpOAuthProvider(
          key,
          mcp.url,
          {
            clientId: oauthConfig?.clientId,
            clientSecret: oauthConfig?.clientSecret,
            scope: oauthConfig?.scope,
            callbackPort: oauthConfig?.callbackPort,
            redirectUri: oauthConfig?.redirectUri,
          },
          {
            onRedirect: async () => {},
          },
          auth,
          identity.authKey,
        )
      }

      const transports: Array<{ name: string; transport: TransportWithAuth }> = [
        {
          name: "StreamableHTTP",
          transport: new StreamableHTTPClientTransport(url, {
            authProvider,
            requestInit: mcp.headers ? { headers: mcp.headers } : undefined,
          }),
        },
        {
          name: "SSE",
          transport: new SSEClientTransport(url, {
            authProvider,
            requestInit: mcp.headers ? { headers: mcp.headers } : undefined,
          }),
        },
      ]

      const connectTimeout = effectiveTimeouts(mcp.timeout).startup
      const deadline = performance.now() + connectTimeout
      let lastStatus: Status | undefined

      for (const { name, transport } of transports) {
        // A transport fallback is part of the same startup, not a fresh budget.
        const remaining = Math.ceil(deadline - performance.now())
        if (remaining <= 0) {
          lastStatus = { status: "failed", error: "MCP startup timed out" }
          break
        }
        const result = yield* connectTransport(transport, remaining).pipe(
          Effect.map((client) => ({ client, transportName: name })),
          Effect.catch((error) => {
            const lastError = error instanceof Error ? error : new Error(String(error))
            const isAuthError =
              error instanceof UnauthorizedError || (authProvider && lastError.message.includes("OAuth"))

            if (isAuthError) {
              if (lastError.message.includes("registration") || lastError.message.includes("client_id")) {
                lastStatus = {
                  status: "needs_client_registration" as const,
                  error: "Server does not support dynamic client registration. Please provide clientId in config.",
                }
                return events
                  .publish(TuiEvent.ToastShow, {
                    title: "MCP Authentication Required",
                    message: `Server "${key}" requires a pre-registered client ID. Add clientId to your config.`,
                    variant: "warning",
                    duration: 8000,
                  })
                  .pipe(Effect.ignore, Effect.as(undefined))
              } else {
                lastStatus = { status: "needs_auth" as const }
                return events
                  .publish(TuiEvent.ToastShow, {
                    title: "MCP Authentication Required",
                    message: `Server "${key}" requires authentication. Run: arforge mcp auth ${key}`,
                    variant: "warning",
                    duration: 8000,
                  })
                  .pipe(Effect.ignore, Effect.as(undefined))
              }
            }

            lastStatus = { status: "failed" as const, error: lastError.message }
            return Effect.void
          }),
        )
        if (result) return { client: result.client, status: { status: "connected" } as Status }
        // If this was an auth error, stop trying other transports
        if (lastStatus?.status === "needs_auth" || lastStatus?.status === "needs_client_registration") break
      }

      return {
        client: undefined as MCPClient | undefined,
        status: (lastStatus ?? { status: "failed", error: "Unknown error" }) as Status,
      }
    })

    /**
     * Connect with tokens held only by a pending provider. This is deliberately
     * separate from `connectRemote`: an OAuth completion must prove that its
     * frozen configuration is still current before committing credentials to
     * disk. The pending provider supplies the just-exchanged token in memory.
     */
    const connectPendingRemote = Effect.fn("MCP.connectPendingRemote")(function* (pending: PendingOAuthTransport) {
      const url = remoteURL(pending.remote.url)
      if (!url || !pending.provider)
        return {
          client: undefined as MCPClient | undefined,
          status: { status: "failed", error: "OAuth 完成后无法解析远程 MCP 配置" } satisfies Status,
        }
      const transports: TransportWithAuth[] = [
        new StreamableHTTPClientTransport(url, {
          authProvider: pending.provider,
          requestInit: pending.remote.headers ? { headers: pending.remote.headers } : undefined,
        }),
        new SSEClientTransport(url, {
          authProvider: pending.provider,
          requestInit: pending.remote.headers ? { headers: pending.remote.headers } : undefined,
        }),
      ]
      const deadline = performance.now() + effectiveTimeouts(pending.remote.timeout).startup
      let lastError: string | undefined
      for (const transport of transports) {
        const remaining = Math.ceil(deadline - performance.now())
        if (remaining <= 0) {
          lastError = "MCP startup timed out"
          break
        }
        const result = yield* Effect.exit(connectTransport(transport, remaining))
        if (Exit.isSuccess(result)) return { client: result.value, status: { status: "connected" } satisfies Status }
        const cause = Cause.squash(result.cause)
        lastError = cause instanceof Error ? cause.message : String(cause)
      }
      return {
        client: undefined as MCPClient | undefined,
        status: { status: "failed", error: lastError || "OAuth 完成后无法连接 MCP 服务" } satisfies Status,
      }
    })

    /**
     * Freezes the platform-resolved absolute launcher for the configured
     * command (realpath). Absolute commands are canonicalized and bare
     * commands are resolved through PATH. The launch boundary later checks
     * the same file metadata to catch ordinary replacement; it does not claim
     * an atomic open-file handle or attest interpreter-loaded script content.
     * Returns undefined when the launcher cannot be resolved, so connection
     * fails closed.
     */
    const resolveExecutable = (command: string, cwd: string): Promise<string | undefined> => {
      const configuredExtensions =
        process.platform === "win32"
          ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
              .split(";")
              .filter(Boolean)
              .map((extension) => extension.toLowerCase())
          : []
      const hasExtension = path.extname(command).length > 0
      const extensions = process.platform === "win32" && !hasExtension ? ["", ...configuredExtensions] : [""]
      const hasPathSeparator = command.includes("/") || command.includes("\\")
      const bases = path.isAbsolute(command)
        ? [command]
        : hasPathSeparator
          ? [path.resolve(cwd, command)]
          : [
              ...(process.platform === "win32" ? [path.resolve(cwd, command)] : []),
              ...(process.env.PATH ?? "")
                .split(path.delimiter)
                .filter(Boolean)
                .map((directory) => path.join(directory, command)),
            ]
      const candidates = bases.flatMap((candidate) => extensions.map((extension) => candidate + extension))
      for (const candidate of candidates) {
        try {
          if (fs.statSync(candidate).isFile()) return Promise.resolve(fs.realpathSync(candidate))
        } catch {
          // keep looking
        }
      }
      return Promise.resolve(undefined)
    }

    const executableIdentity = (executable: string): ExecutableIdentity => {
      const realpath = fs.realpathSync(executable)
      const stat = fs.statSync(realpath)
      if (!stat.isFile()) throw new Error(`MCP executable is not a file: ${realpath}`)
      return Object.freeze({
        realpath,
        device: stat.dev,
        inode: stat.ino,
        size: stat.size,
        modifiedMs: stat.mtimeMs,
        createdMs: stat.birthtimeMs,
      })
    }

    /**
     * Canonical, frozen, redacted intent of one local connect. The full
     * config (and therefore any environment value) only ever enters the
     * canonical one-way config digest; the bound resources carry the server
     * name, the frozen absolute executable identity, the canonical argv
     * digest, the canonical realpath workdir, and environment key NAMES
     * only. The spawn uses this frozen spec.
     */
    const buildConnectIntent = Effect.fnUntraced(function* (key: string, mcp: ConfigMCPV1.Info & { type: "local" }) {
      const baseDir = yield* InstanceState.directory
      const [command, ...args] = mcp.command
      const resolvedCwd = yield* Effect.tryPromise({
        try: () => fs.promises.realpath(mcp.cwd ? path.resolve(baseDir, mcp.cwd) : baseDir),
        catch: () => undefined as string | undefined,
      })
      if (!resolvedCwd) return yield* Effect.fail(new Error(`MCP 服务 ${key} 的工作目录无法解析`))
      const readOnlyRoots = yield* Effect.try({
        try: () => {
          const requested = Schema.decodeUnknownSync(ConfigMCP.ReadOnlyPaths)(mcp.read_only_paths ?? [])
          const canonical = [
            ...new Set(requested.map((directory) => fs.realpathSync(path.resolve(baseDir, directory)))),
          ].sort()
          return Object.freeze(
            canonical.map((directory) => {
              const stat = fs.statSync(directory)
              if (!stat.isDirectory()) throw new Error("MCP read grant requires a directory")
              return Object.freeze({ path: directory, device: stat.dev, inode: stat.ino })
            }),
          )
        },
        catch: () => new Error(`MCP 服务 ${key} 的只读依赖目录无效或无法访问；请检查 read_only_paths`),
      })
      const executable = yield* Effect.tryPromise({
        try: () => resolveExecutable(command, resolvedCwd),
        catch: () => undefined as string | undefined,
      })
      if (!executable) return yield* Effect.fail(new Error(`MCP 服务 ${key} 的可执行文件无法解析`))
      const identity = yield* Effect.try({
        try: () => executableIdentity(executable),
        catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
      })
      const bunBehavior = command === "arforge"
      const environment = Object.freeze(
        allowlistedChildEnvironment(process.env, {
          ...(bunBehavior ? { BUN_BE_BUN: "1" } : {}),
          ...structuredClone(mcp.environment ?? {}),
        }),
      )
      const argv = Object.freeze([...args])
      const timeout = (yield* withTimeouts(mcp)).timeout
      const spawn = Object.freeze({
        executable,
        executableIdentity: identity,
        argv,
        cwd: resolvedCwd,
        ...(readOnlyRoots.length ? { readOnlyRoots } : {}),
        timeout,
        environment,
        bunBehavior,
      }) satisfies FrozenSpawnSpec
      const configDigest = sealedDigest({ key, spawn })
      if (!configDigest) return yield* Effect.fail(new Error(`MCP 服务 ${key} 的配置无法规范化`))
      const argvDigest = sealedDigest([executable, ...argv])
      if (!argvDigest) return yield* Effect.fail(new Error(`MCP 服务 ${key} 的参数无法规范化`))
      const envKeys = Object.freeze(Object.keys(mcp.environment ?? {}).sort())
      const resources = Object.freeze([
        key,
        `exec:${executable}#${argvDigest}`,
        `cwd:${resolvedCwd}`,
        ...readOnlyRoots.map((directory) => `read-only:${directory.path}`),
        ...envKeys.map((name) => `env:${name}`),
        `intent:${configDigest}`,
      ])
      return Object.freeze({
        name: `mcp.connect:${key}`,
        executable,
        argvDigest,
        cwd: resolvedCwd,
        envKeys,
        resources,
        configDigest,
        spawn,
      }) satisfies ConnectIntent
    })

    /**
     * Stable per-(local principal, location, server) control-plane subject with a fresh
     * per-attempt request identity. The subject ID is deterministic so the
     * durable identity is recomputable; the request identity is minted per
     * real start attempt and minted afresh whenever the attempt is new.
     */
    const controlSubjectFor = (
      directory: string,
      projectID: Project.ID,
      key: string,
      requestID: AgentRuntime.ControlPlaneRequestID,
    ): AgentRuntime.ControlPlaneSubject =>
      AgentRuntime.ControlPlaneSubject.make({
        type: "control-plane",
        id: ControlPrincipal.controlPlaneID(ControlPrincipal.LOCAL_PRINCIPAL, {
          location: directory,
          projectID,
          action: key,
        }),
        location: AbsolutePath.make(directory),
        project: projectID,
        actor: "user",
        principalRef: ControlPrincipal.principalRef(ControlPrincipal.LOCAL_PRINCIPAL),
        requestID,
      })

    /**
     * The real spawn: only ever runs inside the gateway operation body after
     * the fresh L3 human approval, and never before it. Uses the frozen
     * executable and workdir from the intent — never a re-resolved command —
     * and the allowlisted child environment stays the only environment
     * source.
     */
    const spawnStdioTransport = Effect.fnUntraced(function* (
      key: string,
      intent: ConnectIntent,
      register: (transport: StdioClientTransport) => void,
    ) {
      const currentIdentity = yield* Effect.try({
        try: () => executableIdentity(intent.spawn.executable),
        catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
      })
      if (
        currentIdentity.realpath !== intent.spawn.executableIdentity.realpath ||
        currentIdentity.device !== intent.spawn.executableIdentity.device ||
        currentIdentity.inode !== intent.spawn.executableIdentity.inode ||
        currentIdentity.size !== intent.spawn.executableIdentity.size ||
        currentIdentity.modifiedMs !== intent.spawn.executableIdentity.modifiedMs ||
        currentIdentity.createdMs !== intent.spawn.executableIdentity.createdMs
      ) {
        return yield* Effect.fail(new Error(`MCP 服务 ${key} 的可执行文件在审批后发生变化，已阻止启动；请重新审批`))
      }
      yield* Effect.try({
        try: () => {
          for (const directory of intent.spawn.readOnlyRoots ?? []) {
            const currentPath = fs.realpathSync(directory.path)
            const stat = fs.statSync(currentPath)
            if (
              currentPath !== directory.path ||
              !stat.isDirectory() ||
              stat.dev !== directory.device ||
              stat.ino !== directory.inode
            )
              throw new Error("MCP read directory identity changed")
          }
        },
        catch: () => new Error(`MCP 服务 ${key} 的只读依赖目录在审批后发生变化，已阻止启动；请重新审批`),
      })
      const prepared = yield* sandbox.prepare({
        command: ChildProcess.make(intent.spawn.executable, [...intent.spawn.argv], {
          cwd: intent.spawn.cwd,
          env: intent.spawn.environment,
          stdin: "ignore",
        }),
        workspace: intent.spawn.cwd,
        cwd: intent.spawn.cwd,
        roots: [intent.spawn.cwd],
        ...(intent.spawn.readOnlyRoots === undefined
          ? {}
          : { readOnlyRoots: intent.spawn.readOnlyRoots.map((directory) => directory.path) }),
        profile: "workspace-write",
        network: "inherit",
        // Local MCP still requires the existing explicit human approval. The
        // platform backend is reported truthfully, while automatic high-risk
        // policy remains owned by the caller and can require full enforcement
        // in a later platform-specific slice.
        requireEnforcement: false,
      })
      yield* Effect.logInfo("MCP local stdio sandbox prepared", {
        server: key,
        backend: prepared.report.backend,
        enforcement: prepared.report.enforcement,
        profile: prepared.report.profile,
        network: prepared.report.network,
      })
      const transport = new StdioClientTransport({
        stderr: "pipe",
        command: prepared.command.command,
        args: [...prepared.command.args],
        cwd: intent.spawn.cwd,
        env: { ...intent.spawn.environment },
      })
      register(transport)
      const diagnostic = observeLocalStartupError(transport.stderr)
      return yield* connectTransport(transport, intent.spawn.timeout.startup).pipe(
        Effect.mapError((error) => diagnostic.error() ?? error),
        Effect.ensuring(Effect.sync(() => diagnostic.stop())),
      )
    })

    /**
     * Effect semantics matching the frozen intent: the canonical workdir is
     * the process filesystem scope and the explicit environment key NAMES
     * are the secret scope — the same facts bound into the authorization
     * resources and the durable identity.
     */
    const connectSemantics = (intent: ConnectIntent) =>
      AgentRuntime.EffectSemantics.make({
        riskTier: "L3",
        authority: "human",
        idempotency: "non_idempotent",
        retryability: "never",
        reversibility: "irreversible",
        filesystemScope: [intent.cwd, ...(intent.spawn.readOnlyRoots ?? []).map((directory) => directory.path)],
        networkScope: [],
        secretScope: [...intent.envKeys],
        externalServices: [],
        expectedArtifacts: [],
        successCriteria: ["local MCP server process started and protocol session established"],
      })

    const connectAuthorizationPlan = (
      key: string,
      intent: ConnectIntent,
      actionID: AgentRuntime.ActionID,
    ): ActionGateway.AuthorizationPlan => ({
      requests: [{ action: intent.name, resources: intent.resources }],
      metadata: {
        server: key,
        actionID,
        reason: `启动本地 MCP 服务 ${key}，需要你确认`,
      },
    })

    const failSummary = (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      if (
        error instanceof ActionGateway.BlockedError ||
        error instanceof ActionGateway.RecoveryRequiredError ||
        error instanceof ActionGateway.AlreadySettledError ||
        error instanceof ActionGateway.ActionIntentMismatchError ||
        error instanceof ActionGateway.InvalidSubjectError
      )
        return message
      return message.length > 0 ? message : "MCP 连接失败"
    }

    /** Runs an effect inside the current location's service context. */
    const inLocation = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.gen(function* () {
        const directory = yield* InstanceState.directory
        return yield* Effect.provide(
          effect,
          Layer.unwrap(Effect.succeed(locations.get(Location.Ref.make({ directory: AbsolutePath.make(directory) })))),
        )
      })

    const localAttemptKey = (s: State, key: string) => `${s.localAttemptPrefix}\0${key}`

    const withLocalAttemptTransition =
      (s: State, key: string) =>
      <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        localAttemptTransitions.withLock(localAttemptKey(s, key))(effect)

    const currentLocalAttempt = (s: State, key: string) =>
      s.connecting.get(key) ?? localAttemptTombstones.get(localAttemptKey(s, key))

    const isCurrentLocalAttempt = (s: State, key: string, attempt: LocalAttempt) =>
      currentLocalAttempt(s, key) === attempt

    const clearLocalAttempt = (s: State, key: string, attempt: LocalAttempt) => {
      if (!isCurrentLocalAttempt(s, key, attempt)) return
      if (s.connecting.get(key) === attempt) s.connecting.delete(key)
      localAttemptTombstones.clear(localAttemptKey(s, key), attempt)
    }

    const statusWaitingTakeover = (key: string, detail?: string): Status => ({
      // This is a business-level retryable failure rather than a protocol
      // enum addition: desktop/API clients already understand `failed` and
      // surface the user-readable safety reason without a wire migration.
      status: "failed",
      error: `正在停止旧的 MCP 服务 ${key}；确认退出后才能继续启动或替换${detail ? `：${detail}` : ""}`,
    })

    const recordedWaitingTakeover = (s: State, key: string): Status =>
      s.status[key]?.status === "failed" ? s.status[key]! : statusWaitingTakeover(key)

    /**
     * Settles both the local status and the tombstone only after the owner
     * runner has actually ended. This is intentionally idempotent: the
     * cancellation owner also performs the same cleanup after a completed
     * Fiber.await, because an interrupted third-party runner must not be the
     * only code path able to release the barrier.
     */
    const settleAttempt = Effect.fnUntraced(function* (
      s: State,
      key: string,
      attempt: LocalAttempt,
      outcome: AttemptOutcome,
    ) {
      if (isCurrentLocalAttempt(s, key, attempt)) {
        if (attempt.phase === "cancelling") s.status[key] = { status: "disabled" }
        else if (outcome.kind === "connected") s.status[key] = { status: "connected" }
        else {
          s.status[key] = { status: "failed", error: outcome.reason }
          const supervisor = supervisorFor(s, key)
          supervisor.markFailure(supervisor.snapshot().desiredGeneration, outcome.reason)
          yield* publishSupervisor(supervisor)
        }
        clearLocalAttempt(s, key, attempt)
      }
      yield* Deferred.succeed(attempt.deferred, outcome).pipe(Effect.ignore)
    })

    const settleSupersededAttempt = Effect.fnUntraced(function* (key: string, attempt: LocalAttempt) {
      return yield* inLocation(
        ActionGateway.Service.pipe(
          Effect.flatMap((gateway) =>
            gateway.settleSupersededAction(
              {
                kind: "control-plane",
                controlPlane: attempt.subject,
                actionID: attempt.actionID,
                name: attempt.intent.name,
                resources: attempt.intent.resources,
                semantics: connectSemantics(attempt.intent),
                // Must remain byte-for-byte identical to the proposal because
                // settleSupersededAction re-validates the frozen intent.
                reasonSummary: `启动本地 MCP 服务 ${key}，需要你确认`,
                initiator: attempt.origin,
                inputDigest: attempt.intent.configDigest,
              },
              connectAuthorizationPlan(key, attempt.intent, attempt.actionID),
              "The pending MCP connect attempt was superseded or cancelled",
            ),
          ),
        ),
      )
    })

    /**
     * A failed durable cancellation is not permission to start a replacement.
     * Keep the tombstone and provide a user-visible, retryable reason instead
     * of swallowing the persistence error as a successful cancellation.
     */
    const settleSupersededOrWait = Effect.fnUntraced(function* (s: State, key: string, attempt: LocalAttempt) {
      const settled = yield* Effect.exit(settleSupersededAttempt(key, attempt))
      if (Exit.isSuccess(settled)) return true
      const reason = failSummary(Cause.squash(settled.cause))
      s.status[key] = statusWaitingTakeover(key, `无法持久化取消：${reason}`)
      yield* Effect.logWarning("MCP cancellation could not settle durable action", { key, reason })
      return false
    })

    /**
     * Runs one authorized local connect attempt: the durable intent is
     * persisted and the fresh L3 human approval is requested before any
     * spawn. The effect completes only after the attempt resolves (approved
     * and connected, or denied/interrupted/failed). The caller forks it so
     * the HTTP/startup flow never blocks on approval. The acquired client is
     * released (closed) whenever the attempt fails or is interrupted, so a
     * rejected or cancelled approval can never leak a process.
     */
    const runLocalAttempt = Effect.fnUntraced(function* (s: State, key: string, identity: LocalAttempt) {
      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const timeout = identity.intent.spawn.timeout.request
          const intent = identity.intent
          const attemptEffect = inLocation(
            Effect.gen(function* () {
              const gateway = yield* ActionGateway.Service
              return yield* gateway
                .execute(
                  {
                    kind: "control-plane",
                    controlPlane: identity.subject,
                    actionID: identity.actionID,
                    name: intent.name,
                    resources: intent.resources,
                    semantics: connectSemantics(intent),
                    reasonSummary: `启动本地 MCP 服务 ${key}，需要你确认`,
                    initiator: identity.origin,
                    inputDigest: intent.configDigest,
                  },
                  {
                    authorization: connectAuthorizationPlan(key, intent, identity.actionID),
                    execute: () =>
                      Effect.gen(function* () {
                        // Approval is not a spawn capability by itself: the
                        // attempt must still be the active generation at the
                        // exact handoff to the process transport.
                        if (identity.phase !== "active" || !isCurrentLocalAttempt(s, key, identity))
                          return yield* Effect.fail(new Error(`MCP 服务 ${key} 的旧启动意图已取消`))
                        return yield* Effect.acquireUseRelease(
                          spawnStdioTransport(key, intent, (transport) => {
                            identity.transport = transport
                          }),
                          (client) =>
                            Effect.gen(function* () {
                              const toolsCapable = client.getServerCapabilities()?.tools
                              const listed = toolsCapable ? yield* catalogDefs(s, key, client, timeout) : []
                              if (!listed) return yield* Effect.fail(new Error("Failed to get tools"))
                              if (identity.phase !== "active" || !isCurrentLocalAttempt(s, key, identity))
                                return yield* Effect.fail(new Error(`MCP 服务 ${key} 的旧启动意图已取消`))
                              yield* storeClient(
                                s,
                                key,
                                client,
                                listed,
                                client.getInstructions()?.trim(),
                                timeout,
                                identity,
                              )
                            }),
                          (client, exit) =>
                            Exit.isSuccess(exit)
                              ? Effect.void
                              : Effect.tryPromise(() => client.close()).pipe(Effect.ignore),
                        )
                      }),
                    successSummary: () => `${key} connected`,
                  },
                )
                .pipe(
                  Effect.as({ kind: "connected" as const }),
                  Effect.catch((error) => Effect.succeed({ kind: "failed" as const, reason: failSummary(error) })),
                )
            }),
          )
          // Capture interruption as data, then make tombstone cleanup
          // uninterruptible. A direct Fiber.interrupt must not leave a completed
          // runner permanently blocking its server name.
          const exit = yield* restore(Effect.exit(attemptEffect))
          const outcome: AttemptOutcome = Exit.isSuccess(exit)
            ? exit.value
            : {
                kind: "failed",
                reason: identity.phase === "cancelling" ? "连接已取消" : failSummary(Cause.squash(exit.cause)),
              }
          if (
            identity.cancellationDisposition === "settle_superseded" &&
            !(yield* settleSupersededOrWait(s, key, identity))
          ) {
            yield* Deferred.succeed(identity.deferred, outcome).pipe(Effect.ignore)
            return outcome
          }
          yield* settleAttempt(s, key, identity, outcome)
          return outcome
        }),
      )
    })

    const statusNeedsApproval = (key: string): Status => ({
      status: "needs_approval",
      reason: `等待你确认启动本地 MCP 服务 ${key}`,
    })
    const statusFailed = (error: string): Status => ({ status: "failed", error })

    /** Starts cancellation but deliberately retains the server-name tombstone. */
    const requestAttemptCancellation = Effect.fnUntraced(function* (
      s: State,
      key: string,
      attempt: LocalAttempt,
      cancellationDisposition: LocalAttemptCancellationDisposition = "settle_superseded",
    ) {
      if (!isCurrentLocalAttempt(s, key, attempt)) return
      attempt.phase = "cancelling"
      attempt.cancellationDisposition = nextCancellationDisposition(
        attempt.cancellationDisposition,
        cancellationDisposition,
      )
      s.status[key] = statusWaitingTakeover(key)
      // An approved transport can be in non-cooperative third-party code.
      // Closing is bounded independently of the runner; afterward the runner
      // remains tombstoned until it really exits.
      if (attempt.transport)
        yield* Effect.tryPromise(() => withTimeout(attempt.transport!.close(), LOCAL_ATTEMPT_CLOSE_GRACE)).pipe(
          Effect.ignore,
        )
      // A completion race can have stored a client immediately before the
      // cancellation fence. Remove and close it before any replacement is
      // allowed to observe this server name as free.
      const client = s.clients[key]
      if (client) {
        delete s.clients[key]
        delete s.defs[key]
        delete s.instructions[key]
        s.localClientConfigDigests.delete(key)
        yield* Effect.tryPromise(() => withTimeout(client.close(), LOCAL_ATTEMPT_CLOSE_GRACE)).pipe(Effect.ignore)
      }
      if (attempt.fiber) yield* Effect.sync(() => attempt.fiber!.interruptUnsafe())
    })

    /**
     * Cancels one attempt with a bounded wait. Timing out is an explicit
     * `waiting_takeover` state, never permission to start another process.
     */
    const cancelAttempt = Effect.fnUntraced(function* (
      s: State,
      key: string,
      attempt: LocalAttempt,
      cancellationDisposition: LocalAttemptCancellationDisposition = "settle_superseded",
    ) {
      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          if (!isCurrentLocalAttempt(s, key, attempt)) return "terminated" as const
          yield* requestAttemptCancellation(s, key, attempt, cancellationDisposition)
          // Try to cancel the durable intent immediately. This is essential
          // when `attempt` is a tombstone inherited from a previous reload:
          // the new state has no runner of its own, but an explicit user
          // disconnect/replace must still revoke the old pending approval.
          if (
            attempt.cancellationDisposition === "settle_superseded" &&
            !(yield* settleSupersededOrWait(s, key, attempt))
          ) {
            // An executing action cannot truthfully become cancelled yet. The
            // close/interrupt request remains in force; wait below for the
            // owner to finish, then retry the durable settlement once.
          }
          if (!attempt.fiber) return "timed_out" as const
          const termination = yield* restore(awaitLocalAttemptTermination(Fiber.await(attempt.fiber)))
          if (termination === "timed_out") return termination
          // Do not depend solely on the runner's cleanup: if it was
          // interrupted before its normal tail, a completed Fiber.await still
          // proves it can no longer overlap a replacement.
          if (
            attempt.cancellationDisposition === "settle_superseded" &&
            !(yield* settleSupersededOrWait(s, key, attempt))
          )
            return "settlement_failed" as const
          yield* settleAttempt(s, key, attempt, { kind: "failed", reason: "连接已取消" })
          return termination
        }),
      )
    })

    const cancellationCompleted = (result: CancellationResult) => result === "terminated"

    /**
     * Enters one authorized local connect attempt and returns the immediate
     * status (never blocking on approval). The canonical intent is always
     * built first: an in-flight attempt merges ONLY when its frozen intent
     * is identical (one ask, one spawn for concurrent connects of the same
     * configuration); any intent change cancels the old attempt atomically
     * before the new one asks. A discovered `awaiting_approval` durable
     * action reuses its persistent identity (actionID, subject, and request
     * identity) so a rebuild re-presents the SAME action; settled or missing
     * actions mint a fresh attempt with a fresh request identity.
     */
    const beginLocalAttempt = Effect.fnUntraced(function* (
      s: State,
      key: string,
      mcp: ConfigMCPV1.Info & { type: "local" },
      bridge: EffectBridge.Shape,
      origin: ConnectOrigin,
    ) {
      const intent = yield* buildConnectIntent(key, mcp)
      // The first queued user takeover may have connected and cleared its
      // tombstone before the next waiter enters this keyed transition. The
      // frozen config digest is the generation claim in that case: reusing the
      // live client is the only safe outcome for an identical request.
      if (s.clients[key] && s.localClientConfigDigests.get(key) === intent.configDigest)
        return { status: "connected" } satisfies Status
      let existing = currentLocalAttempt(s, key)
      if (existing) {
        // A tombstone can originate from a previous InstanceState during
        // reload. Recovery must wait for it, but an explicit user connect/add
        // upgrades the preserved request to a durable cancellation before it
        // can propose a new runner.
        if (s.connecting.get(key) !== existing || existing.phase === "cancelling") {
          if (origin === "recovery") return recordedWaitingTakeover(s, key)
          if (!cancellationCompleted(yield* cancelAttempt(s, key, existing))) return recordedWaitingTakeover(s, key)
          existing = undefined
        }
        if (existing) {
          if (existing.intent.configDigest === intent.configDigest) {
            // A live in-flight attempt with the identical canonical intent
            // merges: concurrent connects share one ask and one spawn.
            return statusNeedsApproval(key)
          }
          // The configuration changed: cancel the old attempt atomically so
          // its pending ask dies, its action becomes terminal, and only the
          // new intent can ask and spawn.
          if (!cancellationCompleted(yield* cancelAttempt(s, key, existing))) return recordedWaitingTakeover(s, key)
        }
      }

      const directory = yield* InstanceState.directory
      const projectID = yield* inLocation(Location.Service.pipe(Effect.map((location) => location.project.id)))
      const discovered = yield* inLocation(
        DurableAction.Service.pipe(
          Effect.flatMap((durable) =>
            durable.list({ limit: RECOVERY_SCAN_LIMIT }).pipe(
              Effect.flatMap((snapshots) => {
                // DurableAction.list currently has no cursor. Scan every
                // available action with a high explicit ceiling and fail
                // closed at saturation rather than silently missing an old
                // approval. A durable action-identity index should replace
                // this compatibility scan.
                if (snapshots.length >= RECOVERY_SCAN_LIMIT)
                  return Effect.fail(new Error("MCP recovery action scan reached its safety limit"))
                return Effect.succeed(
                  snapshots.find(({ action }) => {
                    if (action.name !== intent.name) return false
                    if (
                      !("subject" in action) ||
                      action.subject === undefined ||
                      action.subject.type !== "control-plane"
                    )
                      return false
                    return (
                      action.id ===
                      ActionGateway.stableControlPlaneActionID({
                        subject: action.subject,
                        name: action.name,
                        resources: intent.resources,
                        inputDigest: intent.configDigest,
                        policyVersion: ActionGateway.POLICY_VERSION,
                      })
                    )
                  }),
                )
              }),
            ),
          ),
        ),
      )
      if (discovered) {
        const status = discovered.action.status
        if (status === "awaiting_approval") {
          // The same unfinished attempt persists: reuse its durable identity
          // (actionID, subject, request identity). The gateway re-asks or
          // resumes under that identity and the authorizer binds the same
          // pending ask, so no duplicate action or pending request is ever
          // minted and no new spawn can happen without its approval.
          const discoveredSubject =
            "subject" in discovered.action && discovered.action.subject?.type === "control-plane"
              ? discovered.action.subject
              : undefined
          if (!discoveredSubject) return statusFailed(`本地 MCP 服务 ${key} 的启动尝试缺少控制面身份`)
          return yield* beginNewAttempt(s, key, bridge, intent, directory, projectID, origin, {
            actionID: discovered.action.id,
            subject: discoveredSubject,
          })
        }
        if (
          status === "authorized" ||
          status === "executing" ||
          (status === "blocked" && discovered.authorization !== undefined)
        ) {
          return statusFailed(`本地 MCP 服务 ${key} 的启动尝试需要人工恢复，请重新连接`)
        }
        // A settled historical connection or a blocked request without an
        // authorization grant (human rejection) is not a live process; mint
        // a fresh attempt with a fresh request identity and fresh approval.
      }

      return yield* beginNewAttempt(s, key, bridge, intent, directory, projectID, origin, undefined)
    })

    /**
     * Registers a new local attempt and forks its runner. Registration is
     * atomic: the attempt is visible in `connecting` (with no fiber yet)
     * BEFORE the fork, so a concurrent connect or dispose can never race
     * past a live attempt; the fork only assigns the cancellation handle.
     */
    const beginNewAttempt = Effect.fnUntraced(function* (
      s: State,
      key: string,
      bridge: EffectBridge.Shape,
      intent: ConnectIntent,
      directory: string,
      projectID: Project.ID,
      origin: ConnectOrigin,
      reuse?: { readonly actionID: AgentRuntime.ActionID; readonly subject: AgentRuntime.ControlPlaneSubject },
    ) {
      const subject =
        reuse?.subject ?? controlSubjectFor(directory, projectID, key, AgentRuntime.ControlPlaneRequestID.create())
      const actionID =
        reuse?.actionID ??
        ActionGateway.stableControlPlaneActionID({
          subject,
          name: intent.name,
          resources: intent.resources,
          inputDigest: intent.configDigest,
          policyVersion: ActionGateway.POLICY_VERSION,
        })
      const deferred = yield* Deferred.make<AttemptOutcome>()
      const attempt: LocalAttempt = {
        server: key,
        actionID,
        subject,
        requestID: subject.requestID,
        intent,
        origin,
        deferred,
        phase: "active",
        cancellationDisposition: undefined,
        transport: undefined,
        fiber: undefined,
      }
      s.connecting.set(key, attempt)
      localAttemptTombstones.install(localAttemptKey(s, key), attempt)
      s.status[key] = statusNeedsApproval(key)
      attempt.fiber = bridge.fork(
        runLocalAttempt(s, key, attempt).pipe(
          Effect.catch((error) =>
            Effect.gen(function* () {
              const reason = failSummary(error)
              yield* settleAttempt(s, key, attempt, { kind: "failed", reason })
              return { kind: "failed" as const, reason }
            }),
          ),
        ),
      )
      return statusNeedsApproval(key)
    })

    const connectLocal = Effect.fn("MCP.connectLocal")(function* (
      s: State,
      key: string,
      mcp: ConfigMCPV1.Info & { type: "local" },
      origin: ConnectOrigin,
    ) {
      const bridge = yield* EffectBridge.make()
      const status = yield* beginLocalAttempt(s, key, mcp, bridge, origin)
      return { status } satisfies CreateResult
    })

    const create = Effect.fn("MCP.create")(
      function* (s: State, key: string, mcp: ConfigMCPV1.Info, origin: ConnectOrigin = "user") {
        mcp = yield* withTimeouts(mcp)
        if (mcp.enabled === false) {
          // Disabling the server abandons any in-flight attempt: no spawn
          // happens, its pending reply can never succeed, and its durable
          // action is made terminal.
          const attempt = currentLocalAttempt(s, key)
          if (attempt) {
            if (origin === "recovery" && s.connecting.get(key) !== attempt)
              return { status: recordedWaitingTakeover(s, key) } satisfies CreateResult
            if (!cancellationCompleted(yield* cancelAttempt(s, key, attempt)))
              return { status: recordedWaitingTakeover(s, key) } satisfies CreateResult
          }
          return DISABLED_RESULT
        }
        if (mcp.type === "local") {
          // Local stdio connects run only through the authorized attempt:
          // the status returned here never implies a live process.
          return yield* connectLocal(s, key, mcp as ConfigMCPV1.Info & { type: "local" }, origin)
        }

        // A local→remote switch abandons the local attempt atomically: the
        // old pending ask dies and the old durable action becomes terminal
        // before the remote connect can complete.
        const localAttempt = currentLocalAttempt(s, key)
        if (localAttempt) {
          if (origin === "recovery" && s.connecting.get(key) !== localAttempt)
            return { status: recordedWaitingTakeover(s, key) } satisfies CreateResult
          if (!cancellationCompleted(yield* cancelAttempt(s, key, localAttempt)))
            return { status: recordedWaitingTakeover(s, key) } satisfies CreateResult
        }

        const { client: mcpClient, status } = yield* connectRemote(s, key, mcp as ConfigMCPV1.Info & { type: "remote" })

        if (!mcpClient) {
          if (status.status !== "connected" && status.status !== "disabled") {
            yield* Effect.logWarning("server unavailable", { key, type: mcp.type, status: status.status })
          }
          return { status } satisfies CreateResult
        }

        return yield* Effect.gen(function* () {
          const listed = mcpClient.getServerCapabilities()?.tools
            ? yield* catalogDefs(s, key, mcpClient, effectiveTimeouts(mcp.timeout).request)
            : []
          if (!listed) {
            return yield* Effect.fail(new Error("Failed to get tools"))
          }
          return {
            mcpClient,
            status,
            defs: listed,
            instructions: mcpClient.getInstructions()?.trim(),
          } satisfies CreateResult
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.tryPromise(() => mcpClient.close()).pipe(Effect.ignore, Effect.andThen(Effect.failCause(cause))),
          ),
        )
      },
      Effect.map((result): CreateResult => result),
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt
        const error = Cause.squash(cause)
        return Effect.succeed<CreateResult>({
          status: { status: "failed", error: error instanceof Error ? error.message : String(error) },
        })
      }),
    )

    const descendants = Effect.fnUntraced(
      function* (pid: number) {
        if (process.platform === "win32") return [] as number[]
        const pids: number[] = []
        const queue = [pid]
        for (let index = 0; index < queue.length; index++) {
          const current = queue[index]
          const handle = yield* spawner.spawn(ChildProcess.make("pgrep", ["-P", String(current)], { stdin: "ignore" }))
          const text = yield* Stream.mkString(Stream.decodeText(handle.stdout))
          yield* handle.exitCode
          for (const tok of text.split("\n")) {
            const cpid = parseInt(tok, 10)
            if (!isNaN(cpid) && !pids.includes(cpid)) {
              pids.push(cpid)
              queue.push(cpid)
            }
          }
        }
        return pids
      },
      Effect.scoped,
      Effect.catch(() => Effect.succeed([] as number[])),
    )

    const assertCatalogGeneration = (s: State, server: string, generation: number) =>
      assertRuntimeInvariant(invariants, "catalog-generation", {
        kind: "catalog-generation",
        snapshot: supervisorFor(s, server).snapshot(),
        generation,
      }).pipe(Effect.orDie)

    const registerToolCapabilities = (s: State, server: string, generation: number, listed: readonly MCPToolDef[]) =>
      assertCatalogGeneration(s, server, generation).pipe(
        Effect.andThen(
          Effect.sync(() => {
            const accepted = s.capabilities.replace(
              server,
              generation,
              "tool",
              listed.map((def) => {
                const id = McpCatalog.toolName(server, def.name)
                return {
                  id,
                  server,
                  kind: "tool" as const,
                  generation,
                  name: def.name,
                  ...capabilityPermission("tool", id, server),
                }
              }),
            )
            if (!accepted) throw new Error(`MCP 服务 ${server} 的旧工具目录 generation ${generation} 被拒绝`)
            s.capabilities.assertInvariants()
          }),
        ),
      )

    const registerCatalogCapabilities = <T extends { name: string }>(
      s: State,
      server: string,
      generation: number,
      kind: Exclude<McpCapabilityKind, "tool">,
      items: Record<string, T & { client: string }>,
    ) =>
      assertCatalogGeneration(s, server, generation).pipe(
        Effect.andThen(
          Effect.sync(() => {
            const accepted = s.capabilities.replace(
              server,
              generation,
              kind,
              Object.entries(items).map(([id, item]) => {
                const reference =
                  kind === "resource"
                    ? "uri" in item && typeof item.uri === "string"
                      ? item.uri
                      : undefined
                    : kind === "resource_template" && "uriTemplate" in item && typeof item.uriTemplate === "string"
                      ? item.uriTemplate
                      : undefined
                return {
                  id,
                  server,
                  kind,
                  generation,
                  name: item.name,
                  ...(reference === undefined ? {} : { reference }),
                  ...capabilityPermission(kind, id, server, reference),
                }
              }),
            )
            if (!accepted) throw new Error(`MCP 服务 ${server} 的旧 ${kind} 目录 generation ${generation} 被拒绝`)
            const targets = s.capabilityTargets.get(server) ?? new Map()
            for (const [targetID, target] of targets) if (target.kind === kind) targets.delete(targetID)
            for (const [, item] of Object.entries(items)) {
              const reference =
                kind === "resource"
                  ? "uri" in item && typeof item.uri === "string"
                    ? item.uri
                    : undefined
                  : "uriTemplate" in item && typeof item.uriTemplate === "string"
                    ? item.uriTemplate
                    : undefined
              if (reference !== undefined) {
                const capabilityID = safeCapabilityKey(server, reference)
                targets.set(capabilityID, { kind, generation, reference })
              }
            }
            s.capabilityTargets.set(server, targets)
            s.capabilities.assertInvariants()
          }),
        ),
      )

    function watch(s: State, name: string, client: MCPClient, bridge: EffectBridge.Shape, timeout?: number) {
      client.onclose = () => {
        if (s.clients[name] !== client) return
        delete s.clients[name]
        delete s.defs[name]
        delete s.instructions[name]
        s.status[name] = { status: "failed", error: "Connection closed" }
        const supervisor = supervisorFor(s, name)
        const snapshot = supervisor.snapshot()
        const generation = snapshot.observedGeneration ?? snapshot.desiredGeneration
        s.capabilities.invalidate(name, generation)
        supervisor.markFailure(generation, "connection closed")
        bridge.fork(
          Effect.logWarning("MCP connection closed", { server: name }).pipe(
            Effect.andThen(publishSupervisor(supervisor)),
            Effect.andThen(events.publish(ToolsChanged, { server: name })),
            // Remote transports are safe to recover without a new human
            // approval. Local stdio remains explicitly user-controlled and
            // keeps the existing failed/approval semantics.
            Effect.andThen(
              Effect.sync(() => {
                if (!(client.transport instanceof StdioClientTransport)) requestReconnect(s, name, bridge)
              }),
            ),
            Effect.ignore,
          ),
        )
      }

      client.setNotificationHandler(LoggingMessageNotificationSchema, (notification) =>
        bridge.promise(serverLog(name, notification.params)),
      )

      if (!client.getServerCapabilities()?.tools) return
      client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
        if (s.clients[name] !== client || s.status[name]?.status !== "connected") return

        const listed = await bridge.promise(catalogDefs(s, name, client, timeout))
        if (!listed) return
        if (s.clients[name] !== client || s.status[name]?.status !== "connected") return

        const generation = supervisorFor(s, name).snapshot().observedGeneration
        if (generation === null) return
        const registered = await bridge.promise(
          registerToolCapabilities(s, name, generation, listed).pipe(
            Effect.as(true),
            Effect.catchCause((cause) =>
              Effect.logDebug("Ignored stale MCP tool catalog notification", {
                server: name,
                generation,
                cause,
              }).pipe(Effect.as(false)),
            ),
          ),
        )
        if (
          !registered ||
          s.clients[name] !== client ||
          s.status[name]?.status !== "connected" ||
          supervisorFor(s, name).snapshot().observedGeneration !== generation
        )
          return
        s.defs[name] = listed
        await bridge.promise(events.publish(ToolsChanged, { server: name }).pipe(Effect.ignore))
      })
    }

    function serverLog(name: string, params: LoggingMessageNotification["params"]) {
      const fields = { server: name, logger: params.logger, level: params.level, data: params.data }
      switch (params.level) {
        case "debug":
          return Effect.logDebug("MCP server log", fields)
        case "info":
        case "notice":
          return Effect.logInfo("MCP server log", fields)
        case "warning":
          return Effect.logWarning("MCP server log", fields)
        case "error":
        case "critical":
        case "alert":
        case "emergency":
          return Effect.logError("MCP server log", fields)
      }
    }

    const state = yield* InstanceState.make<State>(
      Effect.fn("MCP.state")(function* () {
        const cfg = yield* cfgSvc.get()
        const bridge = yield* EffectBridge.make()
        const config = cfg.mcp ?? {}
        const localAttemptPrefix = fs.realpathSync(yield* InstanceState.directory)
        const s: State = {
          config: {},
          status: {},
          clients: {},
          defs: {},
          instructions: {},
          capabilities: new McpCapabilityRegistry(),
          capabilityTargets: new Map(),
          catalogReads: Semaphore.makeUnsafe(McpCatalog.Limits.concurrency),
          bridge,
          supervisors: new Map(),
          supervisorCheckpointDigests: new Map(),
          reconnectFibers: new Map(),
          pendingReconnects: new Map(),
          healthMonitorFiber: undefined,
          connecting: new Map(),
          localAttemptPrefix,
          localClientConfigDigests: new Map(),
          oauthPending: new Set(),
        }
        activeStates.add(s)

        yield* Effect.forEach(
          Object.entries(config),
          ([key, mcp]) =>
            Effect.gen(function* () {
              if (!isMcpConfigured(mcp)) {
                yield* Effect.logError("Ignoring MCP config entry without type", { key })
                return
              }

              // Restore only redacted retry/circuit memory. The old transport
              // is never treated as live; the normal create path below still
              // negotiates a fresh MCP session for this generation.
              yield* restoreSupervisorCheckpoint(s, key)

              if (mcp.enabled === false) {
                supervisorFor(s, key).disable()
                s.status[key] = { status: "disabled" }
                return
              }

              const supervisor = supervisorFor(s, key)
              const decision = supervisorStart(s, key)
              if (!decision.allowed) {
                s.status[key] = { status: "failed", error: supervisor.snapshot().safeMessage }
                // A restored backoff/circuit window must not disappear on
                // restart. Queue one remote recovery; the handler is wired
                // after state construction and will schedule it then.
                if (mcp.type === "remote") requestReconnect(s, key, bridge)
                return
              }
              const result = yield* withLocalAttemptTransition(s, key)(create(s, key, mcp, "recovery"))
              if (result.mcpClient) {
                supervisor.markReady(decision.generation)
                yield* registerToolCapabilities(s, key, decision.generation, result.defs!)
                s.status[key] = result.status
                s.clients[key] = result.mcpClient
                s.defs[key] = result.defs!
                if (result.instructions) s.instructions[key] = result.instructions
                watch(s, key, result.mcpClient, bridge, requestTimeout(s, key, mcp, cfg.experimental?.mcp_timeout))
                yield* publishSupervisor(supervisor)
              } else {
                s.status[key] = result.status
                if (result.status.status === "failed") {
                  supervisor.markFailure(decision.generation, result.status.error)
                  yield* publishSupervisor(supervisor)
                  if (mcp.type === "remote") requestReconnect(s, key, bridge)
                }
              }
            }),
          { concurrency: McpCatalog.Limits.concurrency },
        )

        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            activeStates.delete(s)
            const healthMonitor = s.healthMonitorFiber
            s.healthMonitorFiber = undefined
            const reconnectFibers = [...s.reconnectFibers.values()]
            s.reconnectFibers.clear()
            s.pendingReconnects.clear()
            if (healthMonitor) yield* Fiber.interrupt(healthMonitor).pipe(Effect.ignore)
            yield* Effect.forEach(reconnectFibers, (fiber) => Fiber.interrupt(fiber).pipe(Effect.ignore), {
              discard: true,
            })
            // Every pending attempt goes through the same bounded cancellation
            // fence as an explicit disconnect. This lets a cooperative runner
            // settle before a reload recreates its prompt, while an
            // uninterruptible third-party runner returns after the grace period
            // with its process-local tombstone still installed. In particular,
            // finalization must never wait indefinitely or permit overlap.
            const attempts = [...s.connecting.values()]
            yield* Effect.forEach(
              attempts,
              (attempt) =>
                withLocalAttemptTransition(
                  s,
                  attempt.server,
                )(cancelAttempt(s, attempt.server, attempt, "preserve_for_recovery")).pipe(Effect.ignore),
              { discard: true },
            )
            // OAuth flows are process-global only so a callback can outlive a
            // runtime reload. Dispose only generations owned by this concrete
            // state and only while they are still current; an old finalizer
            // must never clear another project's or a newer generation's
            // authorization flow.
            const pending = [...s.oauthPending]
            yield* Effect.forEach(
              pending,
              (attempt) =>
                Effect.gen(function* () {
                  // Detach and cancel are one identity-safe transition with
                  // completion/publish. Transport teardown is deliberately
                  // outside the lock: a third-party close must never block a
                  // new generation or leave a just-published client unowned.
                  const detached = yield* withLocalAttemptTransition(
                    s,
                    attempt.identity.server,
                  )(
                    Effect.sync(() => {
                      const current = detachPendingOAuth(s, attempt.identity.server, attempt)
                      if (current) McpOAuthCallback.cancelPending(current.identity.callbackKey)
                      return current
                    }),
                  )
                  if (detached) yield* closeOAuthTransport(detached)
                }),
              { discard: true },
            )
            // Snapshot after the OAuth transition fence. If a completion won
            // its publish lock immediately before disposal, this captures and
            // closes its client; if disposal won, completion observes stale
            // identity and closes its unowned client itself.
            const clients = Object.values(s.clients)
            s.clients = {}
            s.defs = {}
            s.instructions = {}
            for (const name of Object.keys(s.config)) s.capabilities.remove(name)
            s.localClientConfigDigests.clear()
            yield* Effect.forEach(
              clients,
              (client) =>
                Effect.gen(function* () {
                  const pid = client.transport instanceof StdioClientTransport ? client.transport.pid : null
                  if (typeof pid === "number") {
                    const pids = yield* descendants(pid)
                    for (const dpid of pids) {
                      try {
                        process.kill(dpid, "SIGTERM")
                      } catch {}
                    }
                  }
                  yield* Effect.tryPromise(() => client.close()).pipe(Effect.ignore)
                }),
              { concurrency: 1 },
            )
          }),
        )

        return s
      }),
    )

    function closeClient(s: State, name: string) {
      const client = s.clients[name]
      delete s.clients[name]
      delete s.defs[name]
      delete s.instructions[name]
      const generation = supervisorFor(s, name).snapshot().observedGeneration
      if (generation !== null) s.capabilities.invalidate(name, generation)
      s.localClientConfigDigests.delete(name)
      if (!client) return Effect.void
      return Effect.tryPromise(() => client.close()).pipe(Effect.ignore)
    }

    const storeClient = Effect.fnUntraced(function* (
      s: State,
      name: string,
      client: MCPClient,
      listed: MCPToolDef[],
      instructions: string | undefined,
      timeout?: number,
      attempt?: LocalAttempt,
    ) {
      const bridge = yield* EffectBridge.make()
      // EffectBridge acquisition is an async boundary. Re-check the exact
      // tombstone before publishing a just-connected client so a concurrent
      // cancellation cannot resurrect a superseded connection.
      if (attempt && (attempt.phase !== "active" || !isCurrentLocalAttempt(s, name, attempt)))
        return yield* Effect.die(new Error(`MCP 服务 ${name} 的旧启动意图已取消`))
      const previous = s.clients[name]
      const supervisor = supervisorFor(s, name)
      supervisor.markReady(supervisor.snapshot().desiredGeneration)
      const generation = supervisor.snapshot().observedGeneration
      if (generation === null) return yield* Effect.die(new Error(`MCP 服务 ${name} 缺少可发布的 generation`))
      yield* registerToolCapabilities(s, name, generation, listed)
      s.status[name] = { status: "connected" }
      s.clients[name] = client
      s.defs[name] = listed
      if (instructions) s.instructions[name] = instructions
      else delete s.instructions[name]
      if (attempt) s.localClientConfigDigests.set(name, attempt.intent.configDigest)
      else s.localClientConfigDigests.delete(name)
      // A successful generation consumes any queued recovery request. The
      // currently running recovery fiber (if any) cleans itself up without
      // interrupting the newly stored client.
      s.pendingReconnects.delete(name)
      watch(s, name, client, bridge, timeout)
      startHealthMonitor(s)
      if (previous) yield* Effect.tryPromise(() => previous.close()).pipe(Effect.ignore)
      yield* publishSupervisor(supervisor)
      return s.status[name]
    })

    const status = Effect.fn("MCP.status")(function* () {
      const s = yield* InstanceState.get(state)

      const cfg = yield* cfgSvc.get()
      const config = cfg.mcp ?? {}
      const result: Record<string, Status> = {}

      for (const [key, mcp] of Object.entries(config)) {
        if (!isMcpConfigured(mcp)) continue
        result[key] =
          currentLocalAttempt(s, key)?.phase === "cancelling"
            ? recordedWaitingTakeover(s, key)
            : (s.status[key] ?? { status: "disabled" })
      }

      for (const key of Object.keys(s.config)) {
        result[key] =
          currentLocalAttempt(s, key)?.phase === "cancelling"
            ? recordedWaitingTakeover(s, key)
            : (s.status[key] ?? { status: "disabled" })
      }

      return result
    })

    const health = Effect.fn("MCP.health")(function* (options?: { readonly probe?: boolean }) {
      const s = yield* InstanceState.get(state)
      const cfg = yield* cfgSvc.get()
      const bridge = options?.probe ? yield* EffectBridge.make() : undefined
      const configured = new Set<string>()
      for (const [name, entry] of Object.entries(cfg.mcp ?? {})) {
        if (!isMcpConfigured(entry)) continue
        configured.add(name)
        supervisorFor(s, name)
      }
      for (const name of Object.keys(s.config)) {
        configured.add(name)
        supervisorFor(s, name)
      }

      if (options?.probe) {
        yield* Effect.forEach(
          Object.entries(s.clients),
          ([name, client]) =>
            Effect.gen(function* () {
              const supervisor = supervisorFor(s, name)
              const generation = supervisor.snapshot().observedGeneration
              if (generation === null) return
              const timeout = requestTimeout(s, name, cfg.mcp?.[name], cfg.experimental?.mcp_timeout)
              const result = yield* Effect.exit(
                Effect.tryPromise({
                  try: (signal) => client.ping({ timeout, signal }),
                  catch: (error) => error,
                }).pipe(s.catalogReads.withPermit),
              )
              if (Exit.isSuccess(result)) supervisor.markHealthSuccess(generation)
              else {
                supervisor.markFailure(generation, "health check failed")
                // Streamable HTTP is request/response based, so a server can
                // disappear without delivering a transport onclose callback.
                // A failed explicit probe therefore enters the same recovery
                // queue as a real close event, after detaching the stale client
                // so its session cannot win a later generation.
                if (!(client.transport instanceof StdioClientTransport) && s.clients[name] === client) {
                  delete s.clients[name]
                  delete s.defs[name]
                  delete s.instructions[name]
                  s.capabilities.invalidate(name, generation)
                  s.status[name] = { status: "failed", error: "MCP health probe failed" }
                  yield* Effect.tryPromise(() => client.close()).pipe(Effect.ignore)
                  if (bridge) requestReconnect(s, name, bridge)
                }
              }
              yield* publishSupervisor(supervisor)
            }),
          { concurrency: McpCatalog.Limits.concurrency, discard: true },
        )
      }

      return Object.fromEntries(
        [...configured]
          .sort((left, right) => left.localeCompare(right))
          .map((name) => [name, supervisorFor(s, name).snapshot()]),
      )
    })

    // The monitor intentionally calls the public probe path rather than
    // duplicating ping, failure classification, stale-client detachment, or
    // recovery scheduling. It is therefore an observer, not a second
    // connection manager.
    healthProbeHandler = () => health({ probe: true }).pipe(Effect.asVoid)
    healthProbeHandlerReady = true
    for (const s of activeStates) startHealthMonitor(s)

    const clients = Effect.fn("MCP.clients")(function* () {
      const s = yield* InstanceState.get(state)
      return s.clients
    })

    /**
     * Project only capabilities that still have a live client, the current
     * supervisor generation and auditable declared transport scope.  The
     * registry is intentionally transport-free, so a cached entry can outlive
     * a removed config; exposing that raw snapshot would leak stale model/API
     * capability metadata even though the actual readers already fail closed.
     */
    const visibleCapabilities = Effect.fnUntraced(function* (s: State) {
      const scopeByServer = new Map<string, boolean>()
      const result: McpCapability[] = []
      for (const item of s.capabilities.snapshot()) {
        if (!s.clients[item.server] || s.status[item.server]?.status !== "connected") continue
        let hasScope = scopeByServer.get(item.server)
        if (hasScope === undefined) {
          hasScope = (yield* declaredScope(item.server)) !== undefined
          scopeByServer.set(item.server, hasScope)
        }
        if (!hasScope) continue
        const observedGeneration = supervisorFor(s, item.server).snapshot().observedGeneration
        if (observedGeneration === null || observedGeneration !== item.generation) continue
        if (!s.capabilities.isCurrent(item.id, item.generation, item.server, item.kind)) continue
        result.push(item)
      }
      return result
    })

    const capabilities = Effect.fn("MCP.capabilities")(function* () {
      const s = yield* InstanceState.get(state)
      return yield* visibleCapabilities(s)
    })

    const assertCapability = Effect.fn("MCP.assertCapability")(function* (input: {
      readonly id: string
      readonly server: string
      readonly generation: number
      readonly kind?: McpCapabilityKind
    }) {
      const s = yield* InstanceState.get(state)
      if (!s.capabilities.isCurrent(input.id, input.generation, input.server, input.kind))
        return yield* Effect.fail(new Error(`MCP capability is stale or unavailable: ${input.server}/${input.id}`))
    })

    const leaseForCapability = Effect.fn("MCP.leaseForCapability")(function* (input: {
      readonly id: string
      readonly server: string
      readonly generation: number
      readonly kind: McpCapabilityKind
      readonly reference?: string
      readonly template?: string
    }) {
      const s = yield* InstanceState.get(state)
      const capability = s.capabilities.get(input.id, input.server)
      const observedGeneration = supervisorFor(s, input.server).snapshot().observedGeneration
      if (
        !capability ||
        !s.clients[input.server] ||
        s.status[input.server]?.status !== "connected" ||
        observedGeneration !== input.generation ||
        capability.kind !== input.kind ||
        capability.generation !== input.generation ||
        !s.capabilities.isCurrent(input.id, input.generation, input.server, input.kind)
      )
        return undefined

      if (input.kind === "prompt") {
        if (input.reference !== undefined && capability.name !== input.reference) return undefined
      } else if (input.kind === "resource") {
        if (
          input.reference === undefined ||
          capability.reference === undefined ||
          safeCapabilityReference(capability.reference) !== safeCapabilityReference(input.reference)
        )
          return undefined
      } else if (input.kind === "resource_template") {
        if (
          input.reference === undefined ||
          input.template === undefined ||
          capability.reference === undefined ||
          safeCapabilityReference(capability.reference) !== safeCapabilityReference(input.template)
        )
          return undefined
      }

      if (input.kind === "resource" || input.kind === "resource_template") {
        const target = s.capabilityTargets.get(input.server)?.get(input.id)
        if (!target || target.kind !== input.kind || target.generation !== input.generation) return undefined
        if (input.kind === "resource" && (input.reference === undefined || target.reference !== input.reference))
          return undefined
        if (input.kind === "resource_template" && (input.template === undefined || target.reference !== input.template))
          return undefined
      }

      if (!(yield* declaredScope(input.server))) return undefined
      const proof = sealedDigest(capabilityLeaseProofPayload(input))
      if ((input.reference !== undefined || input.template !== undefined) && !proof) return undefined
      return Object.freeze({
        id: input.id,
        server: input.server,
        generation: input.generation,
        kind: input.kind,
        ...(input.reference === undefined ? {} : { reference: safeCapabilityReference(input.reference) }),
        ...(input.template === undefined ? {} : { template: safeCapabilityReference(input.template) }),
        ...(proof === undefined ? {} : { proof }),
      }) satisfies McpCapabilityLease
    })

    const instructions = Effect.fn("MCP.instructions")(function* () {
      const s = yield* InstanceState.get(state)
      const result: ServerInstructions[] = []
      for (const [name, item] of Object.entries(s.instructions).sort(([a], [b]) => a.localeCompare(b))) {
        if (s.status[name]?.status !== "connected") continue
        // Instructions are model-facing cached metadata just like tools and
        // catalogue entries.  A retained client after config removal must not
        // keep its old instructions visible without current scope evidence.
        if (!(yield* declaredScope(name))) continue
        result.push({
          name,
          instructions: item,
          tools: (s.defs[name] ?? []).map((tool) => McpCatalog.toolName(name, tool.name)),
        })
      }
      return result
    })

    const createAndStore = Effect.fn("MCP.createAndStore")(function* (
      name: string,
      mcp: ConfigMCPV1.Info,
      origin: ConnectOrigin = "user",
    ) {
      const s = yield* InstanceState.get(state)
      mcp = yield* withTimeouts(mcp)
      const supervisor = supervisorFor(s, name)
      if (mcp.enabled === false) {
        supervisor.disable()
        yield* publishSupervisor(supervisor)
      }
      // An explicit local connect is an operator request for a fresh process
      // generation (and, when needed, a fresh approval). It can override the
      // previous local failure window; recovery/startup never bypasses it.
      if (
        mcp.enabled !== false &&
        mcp.type === "local" &&
        origin === "user" &&
        !currentLocalAttempt(s, name) &&
        (supervisor.snapshot().phase === "backoff" || supervisor.snapshot().phase === "circuit_open")
      ) {
        supervisor.disable()
        yield* publishSupervisor(supervisor)
      }
      const decision = mcp.enabled === false ? undefined : supervisorStart(s, name)
      if (decision && !decision.allowed) {
        const blocked: Status = { status: "failed", error: supervisor.snapshot().safeMessage }
        s.status[name] = blocked
        yield* publishSupervisor(supervisor)
        return blocked
      }
      const result = yield* create(s, name, mcp, origin)

      s.status[name] = result.status
      if (!result.mcpClient) {
        // `beginLocalAttempt` can reuse an identical local client that was
        // connected by the immediately preceding keyed waiter. Do not treat
        // that reuse as an absent result and close the winning generation.
        if (result.status.status === "connected" && s.clients[name]) {
          if (decision?.allowed) supervisor.markReady(decision.generation)
          yield* publishSupervisor(supervisor)
          return result.status
        }
        if (decision?.allowed && result.status.status === "failed") {
          supervisor.markFailure(decision.generation, supervisorFailure(result.status))
        }
        yield* publishSupervisor(supervisor)
        yield* closeClient(s, name)
        delete s.clients[name]
        return result.status
      }

      return yield* storeClient(
        s,
        name,
        result.mcpClient,
        result.defs!,
        result.instructions,
        effectiveTimeouts(mcp.timeout).request,
      )
    })

    // Install the only automatic-recovery entry point after the full create
    // pipeline exists. It intentionally reuses createAndStore, the same
    // transport/auth/catalog path used by explicit connect and startup.
    reconnectHandler = (s, name, generation, bridge) =>
      Effect.gen(function* () {
        const supervisor = supervisorFor(s, name)
        const snapshot = supervisor.snapshot()
        if (snapshot.desiredGeneration !== generation) return
        if (!supervisor.canAttempt()) {
          requestReconnect(s, name, bridge)
          return
        }

        const configured = s.config[name] ?? (yield* cfgSvc.get()).mcp?.[name]
        if (
          !configured ||
          !isMcpConfigured(configured) ||
          configured.enabled === false ||
          configured.type !== "remote"
        ) {
          s.pendingReconnects.delete(name)
          return
        }

        const status = yield* withLocalAttemptTransition(
          s,
          name,
        )(
          Effect.gen(function* () {
            // A user add/connect or an explicit disconnect may have advanced
            // the generation while this retry waited for the keyed lock.
            const current = supervisor.snapshot()
            if (current.desiredGeneration !== generation || !supervisor.canAttempt()) return undefined
            return yield* createAndStore(name, { ...configured, enabled: true }, "recovery")
          }),
        )
        if (status?.status === "failed") requestReconnect(s, name, bridge)
      })

    reconnectHandlerReady = true
    // Drain callbacks captured during initial state construction now that the
    // handler can safely call the complete create/store pipeline.
    for (const s of activeStates) {
      for (const name of s.pendingReconnects.keys()) scheduleReconnect(s, name)
    }

    const add = Effect.fn("MCP.add")(function* (name: string, mcp: ConfigMCPV1.Info) {
      // Own the supplied configuration before the first await. Later caller
      // mutations cannot change a live generation's request deadline.
      mcp = structuredClone(mcp)
      const s = yield* InstanceState.get(state)
      mcp = yield* withTimeouts(mcp)
      return yield* withLocalAttemptTransition(
        s,
        name,
      )(
        Effect.gen(function* () {
          yield* cancelScheduledReconnect(s, name)
          // Configuration replacement, disabling, or changing transport type
          // invalidates only the matching OAuth generation. Its delayed
          // callback may still finish networking, but can no longer commit or
          // publish into this (or a new) configuration.
          const pending = pendingOAuthTransports.get(oauthMapKey(s, name))
          if (pending && !sameRemoteOAuthConfig(pending.identity, mcp)) {
            const detached = detachPendingOAuth(s, name, pending)
            if (detached) {
              McpOAuthCallback.cancelPending(detached.identity.callbackKey)
              yield* closeOAuthTransportDetached(detached)
            }
          }
          s.config[name] = mcp
          // `add` is an explicit configuration generation. It is allowed to
          // replace a failed/circuit-open generation, while plain `connect`
          // remains bounded by the supervisor backoff window.
          const supervisor = supervisorFor(s, name)
          supervisor.disable()
          yield* publishSupervisor(supervisor)
          yield* createAndStore(name, mcp)
          return { status: s.status }
        }),
      )
    })

    const connect = Effect.fn("MCP.connect")(function* (name: string) {
      const s = yield* InstanceState.get(state)
      yield* withLocalAttemptTransition(
        s,
        name,
      )(
        Effect.gen(function* () {
          const mcp = yield* requireMcpConfig(name)
          yield* cancelScheduledReconnect(s, name)
          yield* createAndStore(name, { ...mcp, enabled: true })
        }),
      )
    })

    const disconnect = Effect.fn("MCP.disconnect")(function* (name: string) {
      yield* requireMcpConfig(name)
      const s = yield* InstanceState.get(state)
      yield* withLocalAttemptTransition(
        s,
        name,
      )(
        Effect.gen(function* () {
          yield* cancelScheduledReconnect(s, name)
          const pending = detachPendingOAuth(s, name)
          if (pending) {
            McpOAuthCallback.cancelPending(pending.identity.callbackKey)
            yield* closeOAuthTransportDetached(pending)
          }
          // A pending authorized attempt is cancelled: no spawn happens, its
          // pending approval is abandoned (the old requestID can never be
          // replied), and its durable action is made terminal.
          const attempt = currentLocalAttempt(s, name)
          if (attempt) {
            if (!cancellationCompleted(yield* cancelAttempt(s, name, attempt))) {
              s.status[name] = recordedWaitingTakeover(s, name)
              return
            }
            s.status[name] = { status: "disabled" }
            supervisorFor(s, name).disable()
            yield* publishSupervisor(supervisorFor(s, name))
            return
          }
          yield* closeClient(s, name)
          delete s.clients[name]
          if (!hasRemoteClient(s)) yield* stopHealthMonitor(s)
          s.status[name] = { status: "disabled" }
          supervisorFor(s, name).disable()
          yield* publishSupervisor(supervisorFor(s, name))
        }),
      )
    })

    function requestTimeout(
      s: State,
      name: string,
      configured: McpEntry | undefined,
      fallback?: ConfigMCPV1.Info["timeout"],
    ) {
      const staticTimeout = configured && isMcpConfigured(configured) ? configured.timeout : undefined
      return effectiveTimeouts(s.config[name]?.timeout ?? staticTimeout, fallback).request
    }

    const tools = Effect.fn("MCP.tools")(function* () {
      const result: Record<string, McpTool> = {}
      const s = yield* InstanceState.get(state)

      const cfg = yield* cfgSvc.get()
      const config = cfg.mcp ?? {}
      const defaultTimeout = cfg.experimental?.mcp_timeout

      for (const [clientName, client] of Object.entries(s.clients)) {
        if (s.status[clientName]?.status !== "connected") continue
        const mcpConfig = config[clientName]
        const listed = s.defs[clientName]
        if (!listed) {
          yield* Effect.logWarning("missing cached tools for connected server", { clientName })
          continue
        }
        // Tool definitions are cached from the connect handshake rather than
        // refreshed by the read-only catalogue methods below.  Keep them
        // behind the same auditable scope fence so a removed/drifted config
        // cannot leave a model-facing tool visible until the next reconnect.
        if (!(yield* declaredScope(clientName))) {
          yield* Effect.logWarning("MCP tool projection blocked: missing declared scope", { server: clientName })
          continue
        }
        const timeout = requestTimeout(s, clientName, mcpConfig, defaultTimeout)
        const generation = supervisorFor(s, clientName).snapshot().observedGeneration
        if (generation === null) continue
        for (const def of listed) {
          const id = McpCatalog.toolName(clientName, def.name)
          if (!s.capabilities.isCurrent(id, generation, clientName, "tool")) continue
          result[id] = { def, client, timeout, generation }
        }
      }
      return result
    })

    function collectFromConnected<T extends { name: string }>(
      s: State,
      listFn: (c: Client, timeout?: number, signal?: AbortSignal, budget?: McpCatalog.CatalogBudget) => Promise<T[]>,
      label: string,
      kind: Exclude<McpCapabilityKind, "tool">,
      key?: (item: T) => string,
      targetClientName?: string,
      sharedBudget?: McpCatalog.CatalogBudget,
    ) {
      return Effect.gen(function* () {
        const cfg = yield* cfgSvc.get()
        // A complete catalog snapshot may refresh three protocol kinds in
        // parallel.  Callers can provide one operation-level budget so pages,
        // decoded bytes and the deadline are shared instead of multiplied by
        // the number of kinds.  Standalone prompts/resources/template reads
        // retain their existing per-call aggregate budget.
        const aggregate = sharedBudget ?? new McpCatalog.CatalogBudget()
        const collect = Effect.forEach(
          Object.entries(s.clients).filter(
            ([name]) => s.status[name]?.status === "connected" && (!targetClientName || name === targetClientName),
          ),
          ([clientName, client]) => {
            const generation = supervisorFor(s, clientName).snapshot().observedGeneration
            // A connected client is not by itself an auditable permission to
            // enumerate its catalogue.  Configuration can be removed or its
            // endpoint/executable can drift while the in-memory supervisor is
            // still draining the old generation.  Resolve the declared scope
            // before creating the SDK request so catalogue reads fail closed
            // without touching the transport in that window.
            const read = Effect.gen(function* () {
              const scope = yield* declaredScope(clientName)
              if (!scope) {
                yield* Effect.logWarning("MCP catalogue read blocked: missing declared scope", {
                  server: clientName,
                  kind,
                  label,
                  generation,
                })
                return {} as Record<string, T & { client: string }>
              }
              return yield* McpCatalog.fetch(
                clientName,
                client,
                (c, signal, budget) =>
                  listFn(
                    c,
                    requestTimeout(s, clientName, cfg.mcp?.[clientName], cfg.experimental?.mcp_timeout),
                    signal,
                    budget,
                  ),
                label,
                key,
                aggregate,
              )
            })
            return read.pipe(
              s.catalogReads.withPermit,
              Effect.tap((items) =>
                generation !== null && items
                  ? registerCatalogCapabilities(s, clientName, generation, kind, items).pipe(
                      Effect.catchCause((cause) =>
                        Effect.logDebug("Ignored stale MCP catalog response", {
                          server: clientName,
                          generation,
                          kind,
                          cause,
                        }),
                      ),
                    )
                  : Effect.void,
              ),
              Effect.map((items) => {
                // A catalog response may resolve after a reconnect.  Do not
                // expose the old client's result to this caller even though
                // the registry's generation fence already rejected its
                // write.
                const currentGeneration = supervisorFor(s, clientName).snapshot().observedGeneration
                if (
                  generation === null ||
                  currentGeneration !== generation ||
                  s.clients[clientName] !== client ||
                  s.status[clientName]?.status !== "connected"
                )
                  return []
                return Object.entries(items ?? {}).map(
                  ([id, item]) => [id, generation === null ? item : { ...item, generation }] as const,
                )
              }),
            )
          },
          { concurrency: McpCatalog.Limits.concurrency },
        ).pipe(Effect.map((results) => Object.fromEntries<T & { client: string; generation?: number }>(results.flat())))
        return yield* collect.pipe(Effect.ensuring(sharedBudget ? Effect.void : Effect.sync(() => aggregate.close())))
      })
    }

    type CatalogFenceEntry = Readonly<{
      client: MCPClient
      generation: number | null
      desiredGeneration: number
      phase: McpSupervisorSnapshot["phase"]
    }>
    type CatalogFence = Readonly<Record<string, CatalogFenceEntry>>

    /**
     * Capture the exact connected client identity and supervisor generation
     * that a catalogue read is allowed to observe.  A generation number by
     * itself is not sufficient: a transport can be replaced before its
     * supervisor publishes the next ready state, so the client object is part
     * of the fence as well.
     */
    const captureCatalogFence = (s: State): CatalogFence => {
      const result: Record<string, CatalogFenceEntry> = {}
      for (const [name, client] of Object.entries(s.clients)) {
        if (s.status[name]?.status !== "connected") continue
        const snapshot = supervisorFor(s, name).snapshot()
        result[name] = {
          client,
          generation: snapshot.observedGeneration,
          desiredGeneration: snapshot.desiredGeneration,
          phase: snapshot.phase,
        }
      }
      return result
    }

    const catalogFenceMatches = (s: State, expected: CatalogFence) => {
      const actual = captureCatalogFence(s)
      const expectedNames = Object.keys(expected)
      const actualNames = Object.keys(actual)
      if (expectedNames.length !== actualNames.length) return false
      for (const name of expectedNames) {
        const before = expected[name]
        const after = actual[name]
        if (
          !after ||
          after.client !== before.client ||
          after.generation !== before.generation ||
          after.desiredGeneration !== before.desiredGeneration ||
          after.phase !== before.phase
        )
          return false
      }
      return true
    }

    const catalogFenceSettled = (s: State, expected: CatalogFence) => {
      const current = captureCatalogFence(s)
      const names = new Set([...Object.keys(expected), ...Object.keys(current)])
      for (const name of names) {
        const phase = supervisorFor(s, name).snapshot().phase
        if (phase === "connecting" || phase === "draining") return false
      }
      return true
    }

    const catalogFenceFailure = () =>
      new Error(`MCP catalogue changed during a generation-fenced read after ${MCP_CATALOG_FENCE_ATTEMPTS} attempts`)

    const prompts = Effect.fn("MCP.prompts")(function* () {
      return yield* collectFromConnected(yield* InstanceState.get(state), McpCatalog.prompts, "prompts", "prompt")
    })

    const resources = Effect.fn("MCP.resources")(function* (clientName?: string) {
      return yield* collectFromConnected(
        yield* InstanceState.get(state),
        McpCatalog.resources,
        "resources",
        "resource",
        (resource) => resource.uri,
        clientName,
      )
    })

    const resourceTemplates = Effect.fn("MCP.resourceTemplates")(function* (clientName?: string) {
      return yield* collectFromConnected(
        yield* InstanceState.get(state),
        McpCatalog.resourceTemplates,
        "resource templates",
        "resource_template",
        (template) => template.uriTemplate,
        clientName,
      )
    })

    const catalog = Effect.fn("MCP.catalog")(function* () {
      // A user-facing catalogue read is one operation at the service
      // boundary.  Refresh all protocol kinds before taking the capability
      // projection so API/CLI consumers cannot accidentally combine three
      // independently refreshed views.  The existing supervisor, aggregate
      // budgets, generation registry and catalog semaphore remain the sole
      // transport/discovery owners.
      //
      // Reconnects can race the three parallel list requests.  Fence the
      // complete operation with both client identity and observed generation;
      // a changed fence is retried only a bounded number of times and is then
      // reported instead of returning a mixed old/new projection.
      for (let attempt = 1; attempt <= MCP_CATALOG_FENCE_ATTEMPTS; attempt++) {
        const s = yield* InstanceState.get(state)
        const fence = captureCatalogFence(s)
        const aggregate = new McpCatalog.CatalogBudget({
          timeout: McpCatalog.FullCatalogLimits.timeout,
          limits: McpCatalog.FullCatalogLimits,
        })
        const read = yield* Effect.exit(
          Effect.all(
            [
              collectFromConnected(s, McpCatalog.prompts, "prompts", "prompt", undefined, undefined, aggregate),
              collectFromConnected(
                s,
                McpCatalog.resources,
                "resources",
                "resource",
                (resource) => resource.uri,
                undefined,
                aggregate,
              ),
              collectFromConnected(
                s,
                McpCatalog.resourceTemplates,
                "resource templates",
                "resource_template",
                (template) => template.uriTemplate,
                undefined,
                aggregate,
              ),
            ],
            { concurrency: 3 },
          ),
        )
        aggregate.close()

        if (Exit.isFailure(read)) {
          if (!catalogFenceMatches(s, fence) || !catalogFenceSettled(s, fence)) {
            if (attempt < MCP_CATALOG_FENCE_ATTEMPTS) {
              yield* Effect.sleep(`${MCP_CATALOG_FENCE_RETRY_DELAY_MS} millis`)
              continue
            }
            return yield* Effect.die(catalogFenceFailure())
          }
          return yield* Effect.die(read.cause)
        }

        if (!catalogFenceMatches(s, fence) || !catalogFenceSettled(s, fence)) {
          if (attempt < MCP_CATALOG_FENCE_ATTEMPTS) {
            yield* Effect.sleep(`${MCP_CATALOG_FENCE_RETRY_DELAY_MS} millis`)
            continue
          }
          return yield* Effect.die(catalogFenceFailure())
        }

        const [promptEntries, resourceEntries, resourceTemplateEntries] = read.value
        const capabilities = yield* visibleCapabilities(s)
        // Check once more after taking the capability projection.  This closes
        // the most common reconnect window between the list reads and the
        // final immutable object construction.
        if (!catalogFenceMatches(s, fence) || !catalogFenceSettled(s, fence)) {
          if (attempt < MCP_CATALOG_FENCE_ATTEMPTS) {
            yield* Effect.sleep(`${MCP_CATALOG_FENCE_RETRY_DELAY_MS} millis`)
            continue
          }
          return yield* Effect.die(catalogFenceFailure())
        }

        return Object.freeze({
          prompts: Object.freeze({ ...promptEntries }),
          resources: Object.freeze({ ...resourceEntries }),
          resourceTemplates: Object.freeze({ ...resourceTemplateEntries }),
          capabilities: Object.freeze([...capabilities]),
        }) satisfies CatalogSnapshot
      }

      return yield* Effect.die(catalogFenceFailure())
    })

    const withClient = Effect.fnUntraced(function* <A>(
      clientName: string,
      fn: (client: MCPClient, timeout?: number) => Promise<A>,
      label: string,
      meta?: Record<string, unknown>,
      expected?: { readonly id: string; readonly generation: number; readonly kind: McpCapabilityKind },
      options?: { readonly propagateTransportError?: boolean },
    ) {
      const s = yield* InstanceState.get(state)
      const client = s.clients[clientName]
      if (!client) {
        yield* Effect.logWarning(`client not found for ${label}`, { clientName })
        return undefined
      }
      if (expected && !s.capabilities.isCurrent(expected.id, expected.generation, clientName, expected.kind))
        return yield* Effect.fail(new Error(`MCP capability is stale or unavailable: ${clientName}/${expected.id}`))
      const cfg = yield* cfgSvc.get()
      const request = Effect.tryPromise({
        try: () => fn(client, requestTimeout(s, clientName, cfg.mcp?.[clientName], cfg.experimental?.mcp_timeout)),
        catch: (error) => error,
      }).pipe(
        Effect.tapError((error) =>
          Effect.logError(`failed to ${label}`, {
            clientName,
            ...meta,
            error: error instanceof Error ? error.message : String(error),
          }),
        ),
      )
      if (options?.propagateTransportError)
        return yield* request.pipe(
          Effect.mapError(
            () =>
              new TransportOutcomeUnknownError({
                server: clientName,
                key: label,
                operation: label,
              }),
          ),
        )
      return yield* request.pipe(Effect.orElseSucceed(() => undefined))
    })

    const getPrompt = Effect.fn("MCP.getPrompt")(function* (
      clientName: string,
      name: string,
      args?: Record<string, string>,
      generationOrLease?: number | McpCapabilityLease,
    ) {
      // A prompt command may outlive the catalogue read that created it.
      // Accept the historical generation number for compatibility, but also
      // allow callers to carry the complete redacted lease.  In either form
      // the native prompt call is rejected unless the exact prompt entry is
      // still present in the current generation; a sanitized-name collision
      // must never redirect a command to a different prompt.
      const lease = typeof generationOrLease === "object" ? generationOrLease : undefined
      const generation = typeof generationOrLease === "number" ? generationOrLease : lease?.generation
      const capabilityID = `${McpCatalog.sanitize(clientName)}:${McpCatalog.sanitize(name)}`
      if (
        lease &&
        (lease.server !== clientName ||
          lease.kind !== "prompt" ||
          lease.id !== capabilityID ||
          lease.generation !== generation ||
          (lease.reference !== undefined && safeCapabilityReference(lease.reference) !== safeCapabilityReference(name)))
      )
        return undefined
      if (
        lease?.proof !== undefined &&
        lease.proof !==
          sealedDigest(
            capabilityLeaseProofPayload({
              id: lease.id,
              server: lease.server,
              generation: lease.generation,
              kind: lease.kind,
              reference: name,
            }),
          )
      )
        return undefined
      const s = yield* InstanceState.get(state)
      if (generation !== undefined) {
        const capability = s.capabilities.get(capabilityID, clientName)
        if (
          !capability ||
          capability.kind !== "prompt" ||
          capability.generation !== generation ||
          capability.server !== clientName ||
          capability.name !== name
        )
          return undefined
      }
      // Native callers without a lease are kept for compatibility, but they
      // still need an auditable transport scope.  A missing or replaced
      // configuration must not turn the retained client into an unscoped
      // prompt transport; the model-facing projection performs the same
      // check through the shared gateway adapter.
      if (!(yield* declaredScope(clientName))) return undefined
      return yield* withClient(
        clientName,
        (client, timeout) => client.getPrompt({ name, arguments: args }, { timeout }),
        "getPrompt",
        { promptName: name },
        generation === undefined ? undefined : { id: capabilityID, generation, kind: "prompt" },
      ).pipe(Effect.orDie)
    })

    const declaredScope = Effect.fn("MCP.declaredScope")(function* (clientName: string) {
      const mcpConfig = yield* getMcpConfig(clientName)
      if (!mcpConfig) return undefined
      const scope = buildDeclaredScope(mcpConfig)
      if (!scope || mcpConfig.type !== "local") return scope

      // A local MCP tool call is an external side effect performed by the
      // process created from this config. Bind its transport scope to the
      // exact frozen connect intent, including argv, resolved executable and
      // workdir, timeout, and environment values. `configDigest` is a
      // persistent, per-installation HMAC, so it is stable over restart but
      // cannot be used to guess a secret embedded in the configuration.
      // Failing to resolve that frozen intent is deliberately fail-closed:
      // callers receive no auditable scope and must not run the tool.
      const intent = yield* buildConnectIntent(clientName, mcpConfig).pipe(Effect.option)
      if (Option.isNone(intent)) return undefined
      return { ...scope, endpoint: `exec:${intent.value.executable}#${intent.value.configDigest}` }
    })

    const readResource = Effect.fn("MCP.readResource")(function* (
      clientName: string,
      resourceUri: string,
      lease?: McpCapabilityLease,
      options?: { readonly propagateTransportError?: boolean },
    ) {
      // A resource lease is bound to the exact URI that was discovered.  The
      // registry check below proves the generation, but by itself it would
      // still allow a caller to present the lease for another *current*
      // resource and redirect the transport to an arbitrary URI. Template
      // leases carry the exact redacted expanded URI from the projection, so
      // they are fenced just as strictly without trying to parse RFC 6570
      // expressions at this lower transport boundary.
      if (
        lease?.kind === "resource" &&
        (lease.id !== safeCapabilityKey(clientName, resourceUri) ||
          (lease.reference !== undefined &&
            safeCapabilityReference(lease.reference) !== safeCapabilityReference(resourceUri)))
      )
        return undefined
      if (
        lease?.kind === "resource_template" &&
        lease.reference !== undefined &&
        safeCapabilityReference(lease.reference) !== safeCapabilityReference(resourceUri)
      )
        return undefined
      if (lease && lease.kind !== "resource" && lease.kind !== "resource_template") return undefined
      // Native callers without a lease are kept for compatibility, but they
      // must still present auditable transport scope.  Model-facing callers
      // perform this check in the shared gateway adapter; keeping it here
      // closes the direct service API as well and prevents a missing/invalid
      // config from being treated as permission to contact a client.
      if (!(yield* declaredScope(clientName))) return undefined
      if (lease?.proof !== undefined) {
        const expectedProof = sealedDigest(
          capabilityLeaseProofPayload({
            id: lease.id,
            server: lease.server,
            generation: lease.generation,
            kind: lease.kind,
            reference: resourceUri,
            ...(lease.kind === "resource_template" && lease.template !== undefined ? { template: lease.template } : {}),
          }),
        )
        if (!expectedProof || lease.proof !== expectedProof) return undefined
        if (lease.kind === "resource_template" && lease.template === undefined) return undefined
      }
      const expected = lease
        ? {
            id: lease.id,
            generation: lease.generation,
            kind: lease.kind,
          }
        : undefined
      if (lease && lease.server !== clientName) return undefined
      const request = withClient(
        clientName,
        (client, timeout) => client.readResource({ uri: resourceUri }, { timeout }),
        "readResource",
        { resourceUri },
        expected,
        options,
      )
      if (options?.propagateTransportError) return yield* request
      // A stale capability is an expected fail-closed result for this
      // optional reader, not an unhandled defect. The projection turns the
      // missing value into its normal user-visible "resource unavailable"
      // error while no stale client is ever contacted.
      return yield* request.pipe(Effect.orElseSucceed(() => undefined))
    })

    const lookupTask = Effect.fn("MCP.lookupTask")(function* (clientName: string, taskID: string, generation?: number) {
      // The task identifier is persisted in a bounded Action resource before
      // it reaches this method. Rejecting malformed values here keeps the
      // server-side lookup from becoming an arbitrary protocol request.
      if (!isMcpTaskID(taskID)) return undefined
      const s = yield* InstanceState.get(state)
      const expectedClient = s.clients[clientName]
      const expectedGeneration = supervisorFor(s, clientName).snapshot().observedGeneration
      if (!expectedClient || s.status[clientName]?.status !== "connected" || expectedGeneration === null)
        return undefined
      if (generation !== undefined && generation !== expectedGeneration) return undefined

      const task = yield* withClient(
        clientName,
        (client, timeout) =>
          client.experimental.tasks.getTask(taskID, {
            timeout,
          }),
        "tasks/get",
        { operation: "read-only-task-status" },
      )
      const latestGeneration = supervisorFor(s, clientName).snapshot().observedGeneration
      // A reconnect can swap the Client while tasks/get is in flight. Do not
      // project a status read from an obsolete generation into reconciliation.
      if (
        s.clients[clientName] !== expectedClient ||
        s.status[clientName]?.status !== "connected" ||
        latestGeneration !== expectedGeneration
      )
        return undefined
      if (!task) return undefined
      const status = task.status
      const supportedStatuses: ReadonlyArray<McpTaskLookupState["status"]> = [
        "working",
        "input_required",
        "completed",
        "failed",
        "cancelled",
      ]
      if (!supportedStatuses.includes(status)) return undefined
      const observedAt = Date.parse(task.lastUpdatedAt)
      return {
        status,
        ...(Number.isSafeInteger(observedAt) && observedAt >= 0 ? { observedAt } : {}),
      }
    })

    const getMcpConfig = Effect.fnUntraced(function* (mcpName: string) {
      const s = yield* InstanceState.get(state)
      const cfg = yield* cfgSvc.get()
      const mcpConfig = s.config[mcpName] ?? cfg.mcp?.[mcpName]
      if (!mcpConfig || !isMcpConfigured(mcpConfig)) return undefined
      return { ...mcpConfig, timeout: effectiveTimeouts(mcpConfig.timeout, cfg.experimental?.mcp_timeout) }
    })

    const requireMcpConfig = Effect.fnUntraced(function* (mcpName: string) {
      const mcpConfig = yield* getMcpConfig(mcpName)
      if (!mcpConfig) return yield* new NotFoundError({ name: mcpName })
      return mcpConfig
    })

    const pendingOAuthIsCurrent = Effect.fnUntraced(function* (
      s: State,
      mcpName: string,
      pending: PendingOAuthTransport,
    ) {
      if (pendingOAuthTransports.get(oauthMapKey(s, mcpName)) !== pending) return false
      return sameRemoteOAuthConfig(pending.identity, yield* getMcpConfig(mcpName))
    })

    const staleOAuthStatus = (mcpName: string): { readonly status: "failed"; readonly error: string } => ({
      status: "failed",
      error: `MCP 服务 ${mcpName} 的 OAuth 授权已过期：配置已替换、禁用或断开；请重新发起授权`,
    })

    const abandonPendingOAuth = Effect.fnUntraced(function* (
      s: State,
      mcpName: string,
      pending: PendingOAuthTransport,
    ) {
      const detached = detachPendingOAuth(s, mcpName, pending)
      if (!detached) return
      McpOAuthCallback.cancelPending(detached.identity.callbackKey)
      // Closing the transport is deliberately detached from the state lock:
      // third-party transports are allowed to block while closing.
      yield* closeOAuthTransportDetached(detached)
    })

    const startAuth = Effect.fn("MCP.startAuth")(function* (mcpName: string) {
      const s = yield* InstanceState.get(state)
      const prepared = yield* withLocalAttemptTransition(
        s,
        mcpName,
      )(
        Effect.gen(function* () {
          const mcpConfig = yield* requireMcpConfig(mcpName)
          if (mcpConfig.type !== "remote") throw new Error(`MCP server ${mcpName} is not a remote server`)
          if (mcpConfig.enabled === false) throw new Error(`MCP server ${mcpName} is disabled`)
          if (mcpConfig.oauth === false) throw new Error(`MCP server ${mcpName} has OAuth explicitly disabled`)
          const remote = freezeRemoteConfig(mcpConfig)
          const url = remoteURL(remote.url)
          if (!url) throw new Error(`Invalid MCP URL for "${mcpName}"`)
          const identity = remoteOAuthIdentity(s, mcpName, remote)
          const oauthConfig = typeof remote.oauth === "object" ? remote.oauth : undefined
          const effectiveRedirectUri =
            oauthConfig?.redirectUri ??
            (oauthConfig?.callbackPort
              ? `http://127.0.0.1:${oauthConfig.callbackPort}${OAUTH_CALLBACK_PATH}`
              : undefined)
          const oauthState = Array.from(crypto.getRandomValues(new Uint8Array(32)))
            .map((byte) => byte.toString(16).padStart(2, "0"))
            .join("")
          let pending: PendingOAuthTransport | undefined
          const provider = new McpOAuthPendingProvider(
            mcpName,
            remote.url,
            {
              clientId: oauthConfig?.clientId,
              clientSecret: oauthConfig?.clientSecret,
              scope: oauthConfig?.scope,
              redirectUri: effectiveRedirectUri,
            },
            {
              onRedirect: async (url) => {
                if (pending) pending.authorizationUrl = url.toString()
              },
            },
            auth,
            identity.authKey,
          )
          const transport = new StreamableHTTPClientTransport(url, {
            authProvider: provider,
            requestInit: remote.headers ? { headers: remote.headers } : undefined,
          })
          pending = {
            identity,
            remote,
            transport,
            provider,
            authorizationUrl: undefined,
          }
          const previous = installPendingOAuth(s, pending)
          return { pending, previous, oauthState, effectiveRedirectUri }
        }),
      )

      if (prepared.previous) {
        McpOAuthCallback.cancelPending(prepared.previous.identity.callbackKey)
        yield* closeOAuthTransport(prepared.previous)
      }
      // Callback-server setup and remote protocol negotiation intentionally
      // happen without the project/server transition lock held.
      yield* Effect.promise(() => McpOAuthCallback.ensureRunning(prepared.effectiveRedirectUri))
      const registered = yield* withLocalAttemptTransition(
        s,
        mcpName,
      )(
        Effect.gen(function* () {
          if (!(yield* pendingOAuthIsCurrent(s, mcpName, prepared.pending))) return false
          yield* auth.updateOAuthState(prepared.pending.identity.authKey, prepared.oauthState)
          return true
        }),
      )
      if (!registered) {
        yield* withLocalAttemptTransition(s, mcpName)(abandonPendingOAuth(s, mcpName, prepared.pending))
        throw new Error(staleOAuthStatus(mcpName).error)
      }

      const directory = yield* InstanceState.directory
      const client = createClient(directory)
      const timeout = effectiveTimeouts(prepared.pending.remote.timeout).startup
      const connected = yield* Effect.exit(
        Effect.tryPromise({
          try: () =>
            withTimeout(client.connect(prepared.pending.transport, { timeout, maxTotalTimeout: timeout }), timeout),
          catch: (error) => error,
        }),
      )
      if (Exit.isSuccess(connected))
        return {
          authorizationUrl: "",
          oauthState: prepared.oauthState,
          identity: prepared.pending.identity,
          pending: prepared.pending,
          client,
        } satisfies AuthResult

      const connectError = Cause.squash(connected.cause)
      if (connectError instanceof UnauthorizedError && prepared.pending.authorizationUrl) {
        const current = yield* withLocalAttemptTransition(
          s,
          mcpName,
        )(pendingOAuthIsCurrent(s, mcpName, prepared.pending))
        if (current)
          return {
            authorizationUrl: prepared.pending.authorizationUrl,
            oauthState: prepared.oauthState,
            identity: prepared.pending.identity,
            pending: prepared.pending,
          } satisfies AuthResult
      }

      yield* withLocalAttemptTransition(s, mcpName)(abandonPendingOAuth(s, mcpName, prepared.pending))
      yield* Effect.tryPromise(() => client.close()).pipe(Effect.ignore)
      if (connectError instanceof UnauthorizedError) throw new Error(staleOAuthStatus(mcpName).error)
      throw connectError
    })

    const oauthPublishFailureStatus = (mcpName: string, credentialsSaved: boolean): Status => ({
      status: "failed",
      error: credentialsSaved
        ? `MCP 服务 ${mcpName} 的 OAuth 凭据已保存、连接发布失败；可直接重新连接`
        : `MCP 服务 ${mcpName} 的 OAuth 凭据未保存、连接发布失败；请重新发起授权`,
    })

    /**
     * The single commit/publish gate for both OAuth completion paths. The
     * credential write, transient-state cleanup, client publication, and
     * pending detachment are observed as one Exit while the generation lock is
     * held. This is not a transactional rollback: a completed credential
     * commit is deliberately retained when a later publication step fails.
     */
    const publishOAuthClient = Effect.fnUntraced(function* (
      s: State,
      mcpName: string,
      pending: PendingOAuthTransport,
      client: MCPClient,
      listed: MCPToolDef[],
    ) {
      const transition = yield* withLocalAttemptTransition(
        s,
        mcpName,
      )(
        Effect.gen(function* () {
          if (!(yield* pendingOAuthIsCurrent(s, mcpName, pending))) return { kind: "stale" as const }

          const previousClient = s.clients[mcpName]
          let credentialsSaved = false
          const published = yield* Effect.gen(function* () {
            yield* Effect.promise(() => pending.provider?.commit() ?? Promise.resolve())
            credentialsSaved = true
            if (!(yield* pendingOAuthIsCurrent(s, mcpName, pending)))
              return yield* Effect.die(new Error("OAuth identity changed while committing credentials"))
            yield* auth.clearOAuthState(pending.identity.authKey)
            yield* auth.clearCodeVerifier(pending.identity.authKey)
            const status = yield* storeClient(
              s,
              mcpName,
              client,
              listed,
              client.getInstructions()?.trim(),
              effectiveTimeouts(pending.remote.timeout).request,
            )
            if (!detachPendingOAuth(s, mcpName, pending))
              return yield* Effect.die(new Error("OAuth identity changed while publishing the client"))
            return status
          }).pipe(Effect.exit)

          if (Exit.isSuccess(published)) return { kind: "published" as const, status: published.value }

          // Cleanup remains inside the same generation transition, so a fresh
          // start cannot inherit a failed pending entry or have its status
          // overwritten. Credential records are never removed here.
          const detached = detachPendingOAuth(s, mcpName, pending)
          if (detached) McpOAuthCallback.cancelPending(detached.identity.callbackKey)
          delete s.clients[mcpName]
          delete s.defs[mcpName]
          delete s.instructions[mcpName]
          s.localClientConfigDigests.delete(mcpName)
          const status = oauthPublishFailureStatus(mcpName, credentialsSaved)
          s.status[mcpName] = status
          // These are transient authorization fields, not committed tokens.
          // Their cleanup failure must not hide the primary publish failure or
          // leave the pending generation reusable.
          yield* Effect.all(
            [auth.clearOAuthState(pending.identity.authKey), auth.clearCodeVerifier(pending.identity.authKey)],
            { discard: true },
          ).pipe(Effect.exit)
          return { kind: "failed" as const, status, previousClient }
        }),
      )

      if (transition.kind === "published") return transition.status

      // A client is owned by State only after a successful publish. On stale
      // or failed publication, close it outside the transition lock. If
      // storeClient failed after replacing an existing client, that previous
      // client is also no longer owned and must be closed.
      const clientsToClose =
        transition.kind === "failed" && transition.previousClient && transition.previousClient !== client
          ? [client, transition.previousClient]
          : [client]
      yield* Effect.forEach(clientsToClose, (item) => Effect.tryPromise(() => item.close()).pipe(Effect.ignore), {
        concurrency: "unbounded",
        discard: true,
      })
      return transition.kind === "failed" ? transition.status : staleOAuthStatus(mcpName)
    })

    /**
     * Finish a particular frozen OAuth generation. The potentially slow token
     * exchange and remote connection stay outside the transition lock, but
     * both the pre-exchange check and final commit/publish are bound to this
     * exact pending object. Callers must never re-resolve it by server name.
     */
    const finishExpected = Effect.fn("MCP.finishExpected")(function* (
      s: State,
      mcpName: string,
      pending: PendingOAuthTransport,
      authorizationCode: string,
    ) {
      const accepted = yield* withLocalAttemptTransition(s, mcpName)(pendingOAuthIsCurrent(s, mcpName, pending))
      if (!accepted) return staleOAuthStatus(mcpName)

      const error = yield* Effect.tryPromise({
        try: () => pending.transport.finishAuth(authorizationCode),
        catch: (error) => error,
      }).pipe(
        Effect.match({
          onFailure: (error) => (error instanceof Error ? error.message : String(error)),
          onSuccess: () => undefined,
        }),
      )

      if (error) {
        const current = yield* withLocalAttemptTransition(s, mcpName)(pendingOAuthIsCurrent(s, mcpName, pending))
        return current
          ? ({ status: "failed", error: `OAuth completion failed: ${error}` } satisfies Status)
          : staleOAuthStatus(mcpName)
      }

      // The exchange is complete but tokens still live only in the pending
      // provider. Close the obsolete authorization transport before the
      // internal, frozen remote connection; neither operation holds the lock.
      yield* closeOAuthTransport(pending)
      const connected = yield* connectPendingRemote(pending)
      if (!connected.client) {
        yield* withLocalAttemptTransition(s, mcpName)(abandonPendingOAuth(s, mcpName, pending))
        return connected.status
      }
      const client = connected.client
      const listed = client.getServerCapabilities()?.tools
        ? yield* catalogDefs(s, mcpName, client, effectiveTimeouts(pending.remote.timeout).request)
        : []
      if (!listed) {
        yield* Effect.tryPromise(() => client.close()).pipe(Effect.ignore)
        yield* withLocalAttemptTransition(s, mcpName)(abandonPendingOAuth(s, mcpName, pending))
        return { status: "failed", error: "Failed to get tools" } satisfies Status
      }

      return yield* publishOAuthClient(s, mcpName, pending, client, listed)
    })

    const authenticate = Effect.fn("MCP.authenticate")(function* (
      mcpName: string,
      onAuthorization?: (authorizationUrl: string) => void,
    ) {
      const result = yield* startAuth(mcpName)
      if (!result.authorizationUrl) {
        const s = yield* InstanceState.get(state)
        const client = result.client
        const listed = client
          ? client.getServerCapabilities()?.tools
            ? yield* catalogDefs(s, mcpName, client, effectiveTimeouts(result.pending.remote.timeout).request)
            : []
          : undefined
        if (!client || !listed) {
          yield* Effect.tryPromise(() => client?.close() ?? Promise.resolve()).pipe(Effect.ignore)
          yield* withLocalAttemptTransition(s, mcpName)(abandonPendingOAuth(s, mcpName, result.pending))
          return { status: "failed", error: "Failed to get tools" } satisfies Status
        }

        return yield* publishOAuthClient(s, mcpName, result.pending, client, listed)
      }

      const callbackPromise = McpOAuthCallback.waitForCallback(result.oauthState, result.identity.callbackKey)
      onAuthorization?.(result.authorizationUrl)

      yield* browser.open(result.authorizationUrl).pipe(
        Effect.catch(() => {
          return events.publish(BrowserOpenFailed, { mcpName, url: result.authorizationUrl }).pipe(Effect.ignore)
        }),
      )

      const code = yield* Effect.promise(() => callbackPromise)

      const s = yield* InstanceState.get(state)
      const callbackPending = yield* withLocalAttemptTransition(
        s,
        mcpName,
      )(
        Effect.gen(function* () {
          const pending = pendingOAuthTransports.get(oauthMapKey(s, mcpName))
          if (!pending || pending.identity !== result.identity || !(yield* pendingOAuthIsCurrent(s, mcpName, pending)))
            return undefined
          const storedState = yield* auth.getOAuthState(result.identity.authKey)
          if (storedState !== result.oauthState) return undefined
          return pending
        }),
      )
      if (!callbackPending) return staleOAuthStatus(mcpName)
      // Keep the callback-validated pending object rather than looking it up
      // again by name: a replacement generation must never receive this code.
      return yield* finishExpected(s, mcpName, callbackPending, code)
    })

    const finishAuth = Effect.fn("MCP.finishAuth")(function* (
      mcpName: string,
      authorizationCode: string,
      oauthState: string,
    ) {
      // Preserve the public not-found contract before resolving an in-memory
      // pending entry. A callback for a deleted/unknown server is never a
      // successful no-op.
      yield* requireMcpConfig(mcpName)
      const s = yield* InstanceState.get(state)
      const expected = yield* withLocalAttemptTransition(
        s,
        mcpName,
      )(
        Effect.gen(function* () {
          const pending = pendingOAuthTransports.get(oauthMapKey(s, mcpName))
          if (!pending || !(yield* pendingOAuthIsCurrent(s, mcpName, pending))) return undefined
          // `oauthState` is the public capability issued by startAuth. It
          // binds this callback to the captured generation before any token
          // exchange can reach a transport.
          const storedState = yield* auth.getOAuthState(pending.identity.authKey)
          return storedState === oauthState ? pending : undefined
        }),
      )
      if (!expected) return staleOAuthStatus(mcpName)
      return yield* finishExpected(s, mcpName, expected, authorizationCode)
    })

    const removeAuth = Effect.fn("MCP.removeAuth")(function* (mcpName: string) {
      const s = yield* InstanceState.get(state)
      yield* withLocalAttemptTransition(
        s,
        mcpName,
      )(
        Effect.gen(function* () {
          const pending = detachPendingOAuth(s, mcpName)
          if (pending) {
            McpOAuthCallback.cancelPending(pending.identity.callbackKey)
            yield* closeOAuthTransportDetached(pending)
          }
          yield* auth.remove(oauthAuthKeyFor(s.localAttemptPrefix, mcpName))
        }),
      )
    })

    const supportsOAuth = Effect.fn("MCP.supportsOAuth")(function* (mcpName: string) {
      const mcpConfig = yield* requireMcpConfig(mcpName)
      return mcpConfig.type === "remote" && mcpConfig.oauth !== false
    })

    const hasStoredTokens = Effect.fn("MCP.hasStoredTokens")(function* (mcpName: string) {
      const directory = fs.realpathSync(yield* InstanceState.directory)
      const entry = yield* auth.get(oauthAuthKeyFor(directory, mcpName))
      return !!entry?.tokens
    })

    const getAuthStatus = Effect.fn("MCP.getAuthStatus")(function* (mcpName: string) {
      const runtimeConfig = (yield* InstanceState.has(state))
        ? (yield* InstanceState.get(state)).config[mcpName]
        : undefined
      const mcpConfig = runtimeConfig ?? (yield* cfgSvc.get()).mcp?.[mcpName]
      if (!mcpConfig || !isMcpConfigured(mcpConfig) || mcpConfig.type !== "remote") return "not_authenticated"
      const directory = fs.realpathSync(yield* InstanceState.directory)
      const entry = yield* auth.getForUrl(oauthAuthKeyFor(directory, mcpName), mcpConfig.url)
      if (!entry?.tokens) return "not_authenticated"
      if (entry.tokens.expiresAt && entry.tokens.expiresAt < Date.now() / 1000) return "expired"
      return "authenticated"
    })

    return Service.of({
      status,
      health,
      clients,
      capabilities,
      assertCapability,
      leaseForCapability,
      instructions,
      tools,
      prompts,
      resources,
      resourceTemplates,
      catalog,
      add,
      connect,
      disconnect,
      getPrompt,
      readResource,
      lookupTask,
      declaredScope,
      startAuth,
      authenticate,
      finishAuth,
      removeAuth,
      supportsOAuth,
      hasStoredTokens,
      getAuthStatus,
    })
  }),
)

export type AuthStatus = "authenticated" | "expired" | "not_authenticated"

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [
    CrossSpawnSpawner.node,
    McpAuth.node,
    FSUtil.node,
    EffectFlock.node,
    SecretProvider.node,
    Global.node,
    EventV2Bridge.node,
    Config.node,
    McpBrowser.node,
    LocationServiceMap.node,
    SandboxRunner.node,
    RuntimeInvariants.node,
    Database.node,
  ],
})

export * as MCP from "."
export * as McpReconciliation from "./reconciliation"
