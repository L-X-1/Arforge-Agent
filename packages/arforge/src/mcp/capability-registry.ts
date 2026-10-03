/**
 * The MCP capability registry is deliberately transport-free.  It is the
 * single, generation-scoped projection used by the MCP service and by
 * user-facing catalogues; it never stores a Client, URL, header, token or raw
 * provider error.  A connection may be replaced while a list response is in
 * flight, so every write is guarded by the server generation.
 */

export type McpCapabilityKind = "tool" | "prompt" | "resource" | "resource_template"

export type McpCapability = Readonly<{
  id: string
  server: string
  kind: McpCapabilityKind
  generation: number
  name: string
  /** Present for resources.  Query strings and fragments are removed. */
  reference?: string
  /** Permission model used by the existing session/tool boundary. */
  permission: string
  patterns: readonly string[]
}>

export type McpCapabilityInput = Readonly<{
  id: string
  server: string
  kind: McpCapabilityKind
  generation: number
  name: string
  reference?: string
  permission: string
  patterns: readonly string[]
}>

export type McpCapabilityRegistrySnapshot = Readonly<{
  currentGeneration: number
  capabilities: readonly McpCapability[]
}>

type ServerState = {
  generation: number
  entries: Map<string, McpCapability>
}

const KINDS: readonly McpCapabilityKind[] = ["tool", "prompt", "resource", "resource_template"]

/**
 * Keep catalog metadata safe and deterministic.  MCP names are identifiers,
 * while resource URIs are untrusted references and may contain credentials in
 * a query or fragment.  The registry keeps only a bounded, printable,
 * query/fragment-free representation.
 */
export function safeCapabilityReference(value: string): string {
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim()
  if (!normalized) return ""
  // Do not round-trip through URL: WHATWG serialization percent-encodes MCP
  // template braces and drops the authority for custom schemes such as
  // `test://one`.  Keep the provider's printable scheme/path stable while
  // removing credentials, query and fragment data.
  const withoutSuffix = normalized.split(/[?#]/, 1)[0]!
  const authority = withoutSuffix.match(/^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/]*)(.*)$/)
  if (authority) {
    const userInfoEnd = authority[2]!.lastIndexOf("@")
    const host = userInfoEnd < 0 ? authority[2]! : authority[2]!.slice(userInfoEnd + 1)
    return `${authority[1]}://${host}${authority[3]}`.slice(0, 512)
  }
  return withoutSuffix.slice(0, 512)
}

function safeName(value: string) {
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 256)
}

function safeServer(value: string) {
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 128)
}

function safePermission(value: string) {
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 256)
}

/** Stable, redacted ID for URI-backed capabilities. */
export function safeCapabilityKey(server: string, reference: string) {
  const client = safeServer(server).replaceAll("%", "%25").replaceAll(":", "%3A")
  return `${client}:${safeCapabilityReference(reference)}`.slice(0, 768)
}

function normalize(input: McpCapabilityInput): McpCapability {
  const server = safeServer(input.server)
  const name = safeName(input.name)
  const reference = input.reference === undefined ? undefined : safeCapabilityReference(input.reference)
  const id =
    reference !== undefined && (input.kind === "resource" || input.kind === "resource_template")
      ? safeCapabilityKey(server, reference)
      : safeName(input.id)
  const patterns = [...new Set(input.patterns.map((pattern) => safeCapabilityReference(pattern)).filter(Boolean))].sort(
    (a, b) => a.localeCompare(b),
  )
  return Object.freeze({
    id,
    server,
    kind: input.kind,
    generation: input.generation,
    name,
    ...(reference === undefined ? {} : { reference }),
    permission: safePermission(input.permission),
    patterns: Object.freeze(patterns),
  })
}

function compare(a: McpCapability, b: McpCapability) {
  return (
    a.server.localeCompare(b.server) ||
    a.kind.localeCompare(b.kind) ||
    a.id.localeCompare(b.id) ||
    a.generation - b.generation
  )
}

/**
 * In-memory registry with explicit generation fences.  `replace` is the only
 * bulk write used by list responses; a stale response can never reintroduce a
 * capability from an older Client.  The registry is intentionally small and
 * synchronous so it can be unit tested without an Effect runtime.
 */
export class McpCapabilityRegistry {
  private readonly servers = new Map<string, ServerState>()

  /** Advance the current generation and remove all capabilities. */
  activate(server: string, generation: number) {
    const key = safeServer(server)
    const current = this.servers.get(key)
    if (current && generation < current.generation) return false
    if (current && generation === current.generation) return true
    this.servers.set(key, { generation, entries: new Map() })
    return true
  }

  /** Replace one capability kind, rejecting stale generations. */
  replace(server: string, generation: number, kind: McpCapabilityKind, entries: readonly McpCapabilityInput[]) {
    const key = safeServer(server)
    const current = this.servers.get(key)
    if (current && generation < current.generation) return false
    if (!current || generation > current.generation) this.servers.set(key, { generation, entries: new Map() })
    const state = this.servers.get(key)!
    if (state.generation !== generation) return false

    for (const [id, item] of state.entries) if (item.kind === kind) state.entries.delete(id)
    const seen = new Set<string>()
    for (const input of entries) {
      if (input.kind !== kind || input.generation !== generation) continue
      const item = normalize(input)
      if (!item.id || seen.has(item.id)) continue
      // Tool IDs are also the public permission keys.  A sanitized collision
      // across servers would otherwise make one server overwrite another in
      // the model-facing object, so keep the first deterministic owner.
      const ownedByOtherServer = [...this.servers.entries()].some(
        ([owner, ownerState]) => owner !== key && ownerState.entries.has(item.id),
      )
      if (ownedByOtherServer) continue
      seen.add(item.id)
      state.entries.set(item.id, item)
    }
    return true
  }

  /** Invalidate all entries for a generation, retaining the fence. */
  invalidate(server: string, generation?: number) {
    const key = safeServer(server)
    const current = this.servers.get(key)
    if (!current) {
      if (generation !== undefined) this.servers.set(key, { generation, entries: new Map() })
      return true
    }
    if (generation !== undefined && generation < current.generation) return false
    if (generation !== undefined && generation > current.generation)
      this.servers.set(key, { generation, entries: new Map() })
    else current.entries.clear()
    return true
  }

  remove(server: string) {
    return this.servers.delete(safeServer(server))
  }

  currentGeneration(server: string) {
    return this.servers.get(safeServer(server))?.generation
  }

  get(id: string, server?: string) {
    const key = safeName(id)
    if (server !== undefined) return this.servers.get(safeServer(server))?.entries.get(key)
    for (const state of this.servers.values()) {
      const item = state.entries.get(key)
      if (item) return item
    }
    return undefined
  }

  /** True only when the ID belongs to the current server generation. */
  isCurrent(id: string, generation: number, server?: string, kind?: McpCapabilityKind) {
    const item = this.get(id, server)
    return !!item && item.generation === generation && (kind === undefined || item.kind === kind)
  }

  snapshot(kind?: McpCapabilityKind): readonly McpCapability[] {
    const values: McpCapability[] = []
    for (const state of this.servers.values()) {
      for (const item of state.entries.values()) if (kind === undefined || item.kind === kind) values.push(item)
    }
    return values.sort(compare)
  }

  serverSnapshot(server: string): McpCapabilityRegistrySnapshot | undefined {
    const state = this.servers.get(safeServer(server))
    if (!state) return undefined
    return Object.freeze({
      currentGeneration: state.generation,
      capabilities: Object.freeze([...state.entries.values()].sort(compare)),
    })
  }

  assertInvariants() {
    const globalIDs = new Set<string>()
    for (const [server, state] of this.servers) {
      if (!Number.isSafeInteger(state.generation) || state.generation < 0) {
        throw new Error(`invalid MCP capability generation for ${server}`)
      }
      const ids = new Set<string>()
      for (const item of state.entries.values()) {
        if (item.server !== server) throw new Error(`MCP capability server mismatch for ${item.id}`)
        if (item.generation !== state.generation) throw new Error(`stale MCP capability ${item.id}`)
        if (ids.has(item.id) || globalIDs.has(item.id)) throw new Error(`duplicate MCP capability ${item.id}`)
        ids.add(item.id)
        globalIDs.add(item.id)
        if (!KINDS.includes(item.kind)) throw new Error(`invalid MCP capability kind for ${item.id}`)
      }
    }
  }
}

export function capabilityPermission(kind: McpCapabilityKind, id: string, server: string, reference?: string) {
  if (kind === "tool") return { permission: id, patterns: ["*"] }
  const suffix = reference ? safeCapabilityReference(reference) : safeName(id)
  return { permission: "read", patterns: [`mcp:${safeServer(server)}:${suffix}`] }
}
