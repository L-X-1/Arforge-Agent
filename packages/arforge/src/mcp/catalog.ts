import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js"
import {
  CallToolResultSchema,
  ListToolsResultSchema,
  ToolSchema,
  type CallToolResult,
  type Tool as MCPToolDef,
} from "@modelcontextprotocol/sdk/types.js"
import { dynamicTool, jsonSchema, type JSONSchema7, type Tool } from "ai"
import { canonicalHash } from "@arforge-ai/core/util/canonical-hash"
import { ConfigMCP } from "@arforge-ai/core/config/mcp"
import { Effect } from "effect"

const DEFAULT_TIMEOUT = ConfigMCP.DefaultTimeout
/** Bounds for a complete catalog traversal, shared by all four list kinds. */
export const Limits = Object.freeze({ pages: 1_000, items: 10_000, bytes: 10 * 1024 * 1024, concurrency: 4 })

/**
 * Bounds for one aggregate catalog read (all connected servers of one
 * capability kind).  Per-server traversal limits remain intentionally
 * unchanged; the aggregate window prevents a fleet of otherwise-valid MCP
 * servers from multiplying memory/CPU without a finite ceiling.
 */
export const AggregateLimits = Object.freeze({
  pages: Limits.pages * Limits.concurrency,
  items: Limits.items * Limits.concurrency,
  bytes: Limits.bytes * Limits.concurrency,
  timeout: DEFAULT_TIMEOUT,
})

/**
 * Bounds for one complete user-facing catalogue snapshot.  `MCP.catalog()`
 * refreshes prompts, resources and resource templates together; keeping a
 * separate aggregate budget for each kind would let the three traversals
 * multiply the intended memory and deadline ceiling.  The per-kind limits
 * remain unchanged, while this larger shared envelope is consumed by all
 * three traversals in one snapshot attempt.
 */
export const FullCatalogLimits = Object.freeze({
  pages: AggregateLimits.pages * 3,
  items: AggregateLimits.items * 3,
  bytes: AggregateLimits.bytes * 3,
  timeout: AggregateLimits.timeout,
})

/** A single MCP operation deadline, including cancellation of active SDK requests.
 * This does not close the shared Client or authorize a retry. */
export function openDeadline(
  timeout: number,
  signal: AbortSignal | undefined,
  message = "MCP request deadline exceeded",
) {
  // Host timers overflow above this value and would otherwise expire near 1 ms.
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 2_147_483_647)
    throw new Error("Invalid MCP request deadline")
  const controller = new AbortController()
  const deadline = performance.now() + timeout
  const expire = () => controller.abort(new Error(message))
  const forwardAbort = () => controller.abort(signal?.reason)
  let rejectAbort: () => void = () => {}
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = () => reject(controller.signal.reason)
    controller.signal.addEventListener("abort", rejectAbort, { once: true })
  })
  // A scoped consumer may be persisting a task reference when this expires.
  // Keep the rejection observed even before its next protocol read.
  void aborted.catch(() => {})
  const timer = setTimeout(expire, timeout)
  signal?.addEventListener("abort", forwardAbort, { once: true })
  if (signal?.aborted) forwardAbort()
  const remaining = () => {
    if (performance.now() >= deadline) expire()
    controller.signal.throwIfAborted()
    return Math.max(1, Math.ceil(deadline - performance.now()))
  }
  return {
    signal: controller.signal,
    remaining,
    async run<T>(operation: () => Promise<T>, interruption?: AbortSignal): Promise<T> {
      const interrupt = () => controller.abort(interruption?.reason)
      interruption?.addEventListener("abort", interrupt, { once: true })
      if (interruption?.aborted) interrupt()
      try {
        const result = await Promise.race([
          aborted,
          Promise.resolve().then(() => {
            remaining()
            return operation()
          }),
        ])
        remaining()
        return result
      } finally {
        interruption?.removeEventListener("abort", interrupt)
      }
    },
    close() {
      controller.abort(new Error("MCP request scope closed"))
      clearTimeout(timer)
      signal?.removeEventListener("abort", forwardAbort)
      controller.signal.removeEventListener("abort", rejectAbort)
    },
  }
}

export async function withDeadline<T>(
  timeout: number,
  signal: AbortSignal | undefined,
  operation: (budget: { signal: AbortSignal; remaining: () => number }) => Promise<T>,
  message = "MCP request deadline exceeded",
) {
  const budget = openDeadline(timeout, signal, message)
  try {
    return await budget.run(() => operation(budget))
  } finally {
    budget.close()
  }
}

export type CatalogBudgetSnapshot = Readonly<{
  committedPages: number
  committedItems: number
  committedBytes: number
  reservedPages: number
  reservedItems: number
  reservedBytes: number
  limits: Readonly<{
    pages: number
    items: number
    bytes: number
  }>
}>

export type CatalogBudgetLease = Readonly<{
  reserve: (usage: { readonly pages: number; readonly items: number; readonly bytes: number }) => void
  commit: () => void
  release: () => void
}>

type CatalogBudgetLimits = Readonly<Partial<CatalogBudgetSnapshot["limits"]>>

const validateBudgetLimit = (name: string, value: number) => {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid MCP catalog ${name} limit`)
  return value
}

/**
 * A transaction-like aggregate budget for concurrent catalog traversals.
 * Each server reserves decoded page usage while it is in flight and commits
 * only after its complete traversal succeeds.  A malformed/oversized server
 * therefore cannot consume the budget permanently and starve a healthy one.
 */
export class CatalogBudget {
  private readonly deadline: ReturnType<typeof openDeadline>
  private readonly pageLimit: number
  private readonly itemLimit: number
  private readonly byteLimit: number
  private committedPages = 0
  private committedItems = 0
  private committedBytes = 0
  private reservedPages = 0
  private reservedItems = 0
  private reservedBytes = 0

  constructor(options?: {
    readonly timeout?: number
    readonly signal?: AbortSignal
    readonly limits?: CatalogBudgetLimits
  }) {
    const limits = options?.limits ?? {}
    this.pageLimit = validateBudgetLimit("page", limits.pages ?? AggregateLimits.pages)
    this.itemLimit = validateBudgetLimit("item", limits.items ?? AggregateLimits.items)
    this.byteLimit = validateBudgetLimit("byte", limits.bytes ?? AggregateLimits.bytes)
    this.deadline = openDeadline(
      options?.timeout ?? AggregateLimits.timeout,
      options?.signal,
      "MCP catalog total deadline exceeded",
    )
  }

  get signal() {
    return this.deadline.signal
  }

  remaining() {
    return this.deadline.remaining()
  }

  snapshot(): CatalogBudgetSnapshot {
    return {
      committedPages: this.committedPages,
      committedItems: this.committedItems,
      committedBytes: this.committedBytes,
      reservedPages: this.reservedPages,
      reservedItems: this.reservedItems,
      reservedBytes: this.reservedBytes,
      limits: { pages: this.pageLimit, items: this.itemLimit, bytes: this.byteLimit },
    }
  }

  begin(): CatalogBudgetLease {
    let pages = 0
    let items = 0
    let bytes = 0
    let settled = false
    const releaseReservation = () => {
      this.reservedPages -= pages
      this.reservedItems -= items
      this.reservedBytes -= bytes
      pages = 0
      items = 0
      bytes = 0
    }
    return {
      reserve: (usage) => {
        if (settled) throw new Error("MCP catalog budget transaction is closed")
        for (const [name, value] of Object.entries(usage))
          if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid MCP catalog ${name} usage`)
        this.remaining()
        const nextPages = this.committedPages + this.reservedPages + usage.pages
        const nextItems = this.committedItems + this.reservedItems + usage.items
        const nextBytes = this.committedBytes + this.reservedBytes + usage.bytes
        if (nextPages > this.pageLimit) throw new Error("MCP catalog total page limit exceeded")
        if (nextItems > this.itemLimit) throw new Error("MCP catalog total item limit exceeded")
        if (nextBytes > this.byteLimit) throw new Error("MCP catalog total byte limit exceeded")
        pages += usage.pages
        items += usage.items
        bytes += usage.bytes
        this.reservedPages += usage.pages
        this.reservedItems += usage.items
        this.reservedBytes += usage.bytes
      },
      commit: () => {
        if (settled) return
        settled = true
        this.reservedPages -= pages
        this.reservedItems -= items
        this.reservedBytes -= bytes
        this.committedPages += pages
        this.committedItems += items
        this.committedBytes += bytes
        pages = 0
        items = 0
        bytes = 0
      },
      release: () => {
        if (settled) return
        settled = true
        releaseReservation()
      },
    }
  }

  close() {
    this.deadline.close()
  }
}

const linkSignals = (first: AbortSignal | undefined, second: AbortSignal | undefined) => {
  if (!first) return { signal: second, close: () => {} }
  if (!second) return { signal: first, close: () => {} }
  const controller = new AbortController()
  const abort = (source: AbortSignal) => controller.abort(source.reason)
  const onFirst = () => abort(first)
  const onSecond = () => abort(second)
  first.addEventListener("abort", onFirst, { once: true })
  second.addEventListener("abort", onSecond, { once: true })
  if (first.aborted) onFirst()
  else if (second.aborted) onSecond()
  return {
    signal: controller.signal,
    close: () => {
      first.removeEventListener("abort", onFirst)
      second.removeEventListener("abort", onSecond)
    },
  }
}

const TolerantListToolsResultSchema = ListToolsResultSchema.extend({
  tools: ToolSchema.omit({ outputSchema: true }).array(),
})

export async function paginate<T, R>(
  list: (cursor: string | undefined, options: RequestOptions) => Promise<R>,
  items: (result: R) => T[],
  options?: { timeout?: number; signal?: AbortSignal; budget?: CatalogBudget },
) {
  const aggregate = options?.budget
  const lease = aggregate?.begin()
  const linked = linkSignals(options?.signal, aggregate?.signal)
  const timeout = Math.min(options?.timeout ?? DEFAULT_TIMEOUT, aggregate?.remaining() ?? Number.MAX_SAFE_INTEGER)
  try {
    const result = await withDeadline(
      timeout,
      linked.signal,
      async (deadline) => {
        const output: T[] = []
        const cursors = new Set<string>()
        let cursor: string | undefined
        let bytes = 0
        for (let pageIndex = 0; pageIndex < Limits.pages; pageIndex++) {
          const requestTimeout = Math.min(deadline.remaining(), aggregate?.remaining() ?? Number.MAX_SAFE_INTEGER)
          const page = await list(cursor, {
            timeout: requestTimeout,
            maxTotalTimeout: requestTimeout,
            // Listing is a bounded traversal. Progress may be observed by the
            // SDK but must never extend either the page request or the shared
            // aggregate deadline.
            resetTimeoutOnProgress: false,
            signal: deadline.signal,
          })
          deadline.remaining()
          aggregate?.remaining()
          const entries = items(page)
          if (output.length + entries.length > Limits.items) throw new Error("MCP catalog item limit exceeded")
          // Count the complete decoded JSON page, including cursor and _meta.
          // Transport framing limits are a separate boundary before SDK decoding.
          const pageBytes = Buffer.byteLength(JSON.stringify(page), "utf8")
          bytes += pageBytes
          if (bytes > Limits.bytes) throw new Error("MCP catalog byte limit exceeded")
          lease?.reserve({ pages: 1, items: entries.length, bytes: pageBytes })
          for (const item of entries) output.push(item)
          // MCP list responses conventionally expose an optional string cursor,
          // but keep the page generic so callers whose final page omits the
          // field entirely remain type-safe. Validate the wire value at the
          // boundary instead of forcing a structural constraint into inference.
          const nextCursor = (page as { readonly nextCursor?: unknown }).nextCursor
          if (nextCursor === undefined) return output
          if (typeof nextCursor !== "string") throw new Error("MCP catalog returned an invalid cursor")
          if (cursors.has(nextCursor)) throw new Error("MCP catalog returned a repeated cursor")
          cursors.add(nextCursor)
          cursor = nextCursor
        }
        throw new Error(`MCP list exceeded ${Limits.pages} pages`)
      },
      "MCP catalog deadline exceeded",
    )
    lease?.commit()
    return result
  } catch (error) {
    lease?.release()
    throw error
  } finally {
    linked.close()
  }
}

export function defs(client: Client, timeout?: number, budget?: CatalogBudget) {
  return listTools(client, timeout ?? DEFAULT_TIMEOUT, budget).pipe(Effect.catch(() => Effect.void))
}

export function convertTool(mcpTool: MCPToolDef, client: Client, timeout?: number): Tool {
  const inputSchema = inputSchemaFor(mcpTool)

  return dynamicTool({
    description: mcpTool.description ?? "",
    inputSchema: jsonSchema(inputSchema),
    execute: async (args: unknown, options) => {
      const result = await withDeadline(timeout ?? DEFAULT_TIMEOUT, options.abortSignal, (budget) =>
        client.callTool(
          {
            name: mcpTool.name,
            arguments: (args || {}) as Record<string, unknown>,
          },
          CallToolResultSchema,
          {
            resetTimeoutOnProgress: true,
            signal: budget.signal,
            timeout: budget.remaining(),
            maxTotalTimeout: budget.remaining(),
            // The MCP SDK only sends a progress token when this hook is present, enabling timeout resets.
            onprogress: () => {},
          },
        ),
      )
      if (result.isError)
        throw new Error(
          result.content
            .flatMap((item) => (item.type === "text" ? [item.text] : []))
            .filter((text) => text.trim())
            .join("\n\n") || "MCP tool returned an error",
        )
      return normalizeCallToolResult(result)
    },
  })
}

/** The single provider-facing input schema projection for an MCP tool. */
export function inputSchemaFor(mcpTool: MCPToolDef): JSONSchema7 {
  const schema = mcpTool.inputSchema as JSONSchema7
  return {
    ...schema,
    type: "object",
    properties: (schema.properties ?? {}) as JSONSchema7["properties"],
  }
}

/** Preserve structured MCP output while making an empty content result readable. */
export function normalizeCallToolResult(result: CallToolResult): CallToolResult {
  if (result.content.length > 0 || result.structuredContent === undefined || result.structuredContent === null)
    return result
  return {
    ...result,
    content: [{ type: "text" as const, text: JSON.stringify(result.structuredContent) }],
  }
}

export function fetch<T extends { name: string }>(
  clientName: string,
  client: Client,
  list: (client: Client, signal: AbortSignal, budget?: CatalogBudget) => Promise<T[]>,
  label: string,
  key?: (item: T) => string,
  budget?: CatalogBudget,
) {
  return Effect.tryPromise({
    try: (signal) => list(client, signal, budget),
    catch: (error) => error,
  }).pipe(
    Effect.tapError((error) =>
      Effect.logWarning(`failed to get ${label}`, {
        clientName,
        error: error instanceof Error ? error.message : String(error),
      }),
    ),
    Effect.map((items) => {
      const sanitizedClient = sanitize(clientName)
      return Object.fromEntries(
        items.map((item) => [
          key ? resourceKey(clientName, key(item)) : sanitizedClient + ":" + sanitize(item.name),
          { ...item, client: clientName },
        ]),
      )
    }),
    Effect.orElseSucceed(() => undefined),
  )
}

/** Stable key used for URI-backed capability records and permission checks. */
export const resourceKey = (clientName: string, uri: string) => {
  // Escape both the separator and escape marker so `server:uri` keys remain unambiguous.
  const resourceClient = clientName.replaceAll("%", "%25").replaceAll(":", "%3A")
  return `${resourceClient}:${uri}`
}

export const sanitize = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, "_")

export const toolName = (clientName: string, name: string) => sanitize(clientName) + "_" + sanitize(name)

/**
 * Stable, readable native Tool ID for a non-tool MCP capability. The short
 * digest prevents URI/name sanitization collisions while the readable prefix
 * keeps the model-facing tool list understandable.
 */
export function nativeCapabilityName(
  kind: "prompt" | "resource" | "resource_template",
  server: string,
  reference: string,
) {
  const digest = canonicalHash([kind, server, reference])!.slice(0, 12)
  const readable = sanitize(reference).slice(0, 72) || "capability"
  return `mcp_${kind}_${sanitize(server)}_${readable}_${digest}`
}

/** Resolve the native server for a sanitized tool key deterministically. */
export function serverForToolKey(key: string, clientNames: ReadonlyArray<string>): string {
  const byLongest = [...clientNames]
    .map((name) => ({ name, sanitized: sanitize(name) }))
    .sort((a, b) => b.sanitized.length - a.sanitized.length || a.name.localeCompare(b.name))
  return (
    byLongest.find((item) => key.startsWith(item.sanitized + "_"))?.name ??
    (key.includes("_") ? key.split("_")[0]! : key)
  )
}

export function prompts(client: Client, timeout?: number, signal?: AbortSignal, budget?: CatalogBudget) {
  if (!client.getServerCapabilities()?.prompts) return Promise.resolve([])
  return paginate(
    (cursor, options) => client.listPrompts(cursor === undefined ? undefined : { cursor }, options),
    (result) => result.prompts,
    { timeout, signal, budget },
  )
}

export function resources(client: Client, timeout?: number, signal?: AbortSignal, budget?: CatalogBudget) {
  if (!client.getServerCapabilities()?.resources) return Promise.resolve([])
  return paginate(
    (cursor, options) => client.listResources(cursor === undefined ? undefined : { cursor }, options),
    (result) => result.resources,
    { timeout, signal, budget },
  )
}

export function resourceTemplates(client: Client, timeout?: number, signal?: AbortSignal, budget?: CatalogBudget) {
  if (!client.getServerCapabilities()?.resources) return Promise.resolve([])
  return paginate(
    (cursor, options) => client.listResourceTemplates(cursor === undefined ? undefined : { cursor }, options),
    (result) => result.resourceTemplates,
    { timeout, signal, budget },
  )
}

function listTools(client: Client, timeout: number, budget?: CatalogBudget) {
  return Effect.tryPromise({
    try: (signal) =>
      paginate(
        async (cursor, options) => {
          const params = cursor === undefined ? undefined : { cursor }
          try {
            return await client.listTools(params, options)
          } catch (error) {
            if (!(error instanceof Error) || !isOutputSchemaValidationError(error)) throw error
            return client.request({ method: "tools/list", params }, TolerantListToolsResultSchema, options)
          }
        },
        (result) => result.tools,
        { timeout, signal, budget },
      ),
    catch: (error) => (error instanceof Error ? error : new Error(String(error))),
  })
}

function isOutputSchemaValidationError(error: Error) {
  return /can't resolve reference|resolves to more than one schema|outputSchema|schema.*reference|reference.*schema/i.test(
    error.message,
  )
}

export * as McpCatalog from "./catalog"
