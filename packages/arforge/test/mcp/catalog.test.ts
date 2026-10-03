import { describe, expect, test } from "bun:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { McpCatalog } from "@/mcp/catalog"
import { Effect } from "effect"
import { setTimeout as delay } from "node:timers/promises"

const options = { toolCallId: "call_mcp", abortSignal: new AbortController().signal } as any

describe("McpCatalog traversal budgets", () => {
  test("shares one bounded aggregate budget and releases a failed server reservation", async () => {
    const aggregate = new McpCatalog.CatalogBudget({
      timeout: 1_000,
      limits: { pages: 4, items: 3, bytes: 1_000 },
    })
    try {
      let page = 0
      await expect(
        McpCatalog.paginate(
          async () => ({ items: ++page === 1 ? [1, 2] : [3, 4], nextCursor: page === 1 ? "next" : undefined }),
          (response) => response.items,
          { budget: aggregate },
        ),
      ).rejects.toThrow("MCP catalog total item limit exceeded")
      expect(aggregate.snapshot()).toMatchObject({
        committedItems: 0,
        reservedItems: 0,
        committedBytes: 0,
        reservedBytes: 0,
      })

      await expect(
        McpCatalog.paginate(
          async () => ({ items: ["healthy"] }),
          (response) => response.items,
          { budget: aggregate },
        ),
      ).resolves.toEqual(["healthy"])
      expect(aggregate.snapshot()).toMatchObject({ committedItems: 1, reservedItems: 0 })
    } finally {
      aggregate.close()
    }
  })

  test("enforces the aggregate deadline and aborts the active list request", async () => {
    const aggregate = new McpCatalog.CatalogBudget({ timeout: 50 })
    let requestSignal: AbortSignal | undefined
    try {
      await expect(
        McpCatalog.paginate(
          (_cursor, request) => {
            requestSignal = request.signal
            return new Promise<{ items: string[] }>(() => {})
          },
          (response) => response.items,
          { timeout: 1_000, budget: aggregate },
        ),
      ).rejects.toThrow()
      expect(requestSignal?.aborted).toBe(true)
      expect(aggregate.snapshot()).toMatchObject({ reservedPages: 0, reservedItems: 0, reservedBytes: 0 })
    } finally {
      aggregate.close()
    }
  })

  test("marks catalog requests as non-extending progress with a hard total timeout", async () => {
    let request: any
    const aggregate = new McpCatalog.CatalogBudget({ timeout: 1_000 })
    try {
      await expect(
        McpCatalog.paginate(
          async (_cursor, options) => {
            request = options
            return { items: ["ok"] }
          },
          (response) => response.items,
          { budget: aggregate, timeout: 100 },
        ),
      ).resolves.toEqual(["ok"])
      expect(request.resetTimeoutOnProgress).toBe(false)
      expect(request.maxTotalTimeout).toBeLessThanOrEqual(100)
      expect(request.signal).toBeInstanceOf(AbortSignal)
    } finally {
      aggregate.close()
    }
  })

  test("slow pages share one deadline instead of receiving a fresh timeout per page", async () => {
    let calls = 0
    let requestSignal: AbortSignal | undefined
    const result = McpCatalog.paginate(
      async (_cursor, request) => {
        calls++
        requestSignal = request?.signal
        await Bun.sleep(60)
        return { items: [calls], nextCursor: calls < 8 ? String(calls) : undefined }
      },
      (page) => page.items,
      { timeout: 150 },
    )
    await expect(result).rejects.toThrow("MCP catalog deadline exceeded")
    expect(calls).toBeLessThan(8)
    expect(requestSignal?.aborted).toBe(true)
  })

  for (const paged of [false, true])
    test(`the item limit counts the complete catalog, not individual pages: paged=${paged}`, async () => {
      let calls = 0
      const result = McpCatalog.paginate(
        async () => {
          calls++
          return {
            items: Array.from({ length: paged ? 6000 : 10001 }, (_, id) => ({ name: `entry-${calls}-${id}` })),
            nextCursor: paged && calls === 1 ? "second" : undefined,
          }
        },
        (page) => page.items,
      )
      await expect(result).rejects.toThrow("MCP catalog item limit exceeded")
      expect(calls).toBe(paged ? 2 : 1)
    })

  test("the byte limit counts UTF-8 response metadata and cursors, not only catalog items", async () => {
    const result = McpCatalog.paginate(
      async () => ({ items: ["small"], nextCursor: undefined, _meta: { description: "中".repeat(4 * 1024 * 1024) } }),
      (page) => page.items,
    )
    await expect(result).rejects.toThrow("MCP catalog byte limit exceeded")
  })

  test("the byte budget is cumulative across individually valid pages", async () => {
    let calls = 0
    const result = McpCatalog.paginate(
      async () => ({
        items: ["x".repeat(6 * 1024 * 1024)],
        nextCursor: ++calls === 1 ? "next" : undefined,
      }),
      (page) => page.items,
    )
    await expect(result).rejects.toThrow("MCP catalog byte limit exceeded")
    expect(calls).toBe(2)
  })

  test("accepts exactly the item limit without reducing the original 1000-page bound", async () => {
    let calls = 0
    const result = await McpCatalog.paginate(
      async () => ({
        items: Array.from({ length: 10 }, () => calls),
        nextCursor: ++calls < 1000 ? String(calls) : undefined,
      }),
      (page) => page.items,
    )
    expect(result).toHaveLength(10000)
    expect(calls).toBe(1000)
  })

  test("the page bound stops empty pages with unique cursors", async () => {
    let calls = 0
    await expect(
      McpCatalog.paginate(
        async () => ({ items: [], nextCursor: String(++calls) }),
        (page) => page.items,
      ),
    ).rejects.toThrow("MCP list exceeded 1000 pages")
    expect(calls).toBe(1000)
  })

  test("duplicate cursors are rejected without including their arbitrary content in the error", async () => {
    const result = McpCatalog.paginate(
      async () => ({ items: [], nextCursor: "fixture-private-cursor" }),
      (page) => page.items,
    )
    await expect(result).rejects.toThrow("MCP catalog returned a repeated cursor")
    await expect(result).rejects.not.toThrow("fixture-private-cursor")
  })

  test("rejects a non-string cursor at the MCP response boundary", async () => {
    const result = McpCatalog.paginate(
      async () => ({ items: [], nextCursor: 42 }),
      (page) => page.items,
    )
    await expect(result).rejects.toThrow("MCP catalog returned an invalid cursor")
  })

  test("a caller abort stops a hanging list and prevents later pages", async () => {
    const abort = new AbortController()
    let begin: (() => void) | undefined
    const started = new Promise<void>((resolve) => {
      begin = resolve
    })
    let signal: AbortSignal | undefined
    let calls = 0
    const result = McpCatalog.paginate(
      (_cursor, request) => {
        calls++
        signal = request?.signal
        begin?.()
        return new Promise<{ items: string[]; nextCursor?: string }>(() => {})
      },
      (page) => page.items,
      { timeout: 1000, signal: abort.signal },
    )
    await started
    abort.abort(new Error("fixture abort"))
    await expect(result).rejects.toThrow("fixture abort")
    expect(signal?.aborted).toBe(true)
    expect(calls).toBe(1)
  })
})

function clientReturning(result: unknown) {
  return {
    callTool: async () => result,
  } as unknown as Client
}

function mcpTool() {
  return {
    name: "screenshot",
    description: "Take a screenshot",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  } as any
}

describe("McpCatalog.convertTool", () => {
  test("invalid or already-cancelled request budgets never dispatch a tool", async () => {
    let calls = 0
    const client = {
      callTool: async () => {
        calls++
        return { content: [] }
      },
    } as unknown as Client
    for (const timeout of [0, -1, 1.5, Number.NaN, 2_147_483_648]) {
      const converted = McpCatalog.convertTool(mcpTool(), client, timeout)
      await expect(converted.execute!({}, options)).rejects.toThrow("Invalid MCP request deadline")
    }
    const abort = new AbortController()
    abort.abort(new Error("fixture cancelled before dispatch"))
    const converted = McpCatalog.convertTool(mcpTool(), client, 100)
    await expect(converted.execute!({}, { ...options, abortSignal: abort.signal })).rejects.toThrow("fixture cancelled")
    expect(calls).toBe(0)
  })

  test("real SDK progress cannot extend the complete tool request deadline", async () => {
    const server = new Server({ name: "progress", version: "1" }, { capabilities: { tools: {} } })
    let calls = 0
    let progress = 0
    let cancelled = false
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      calls++
      try {
        for (let index = 0; index < 15; index++) {
          await delay(20, undefined, { signal: extra.signal })
          await extra.sendNotification({
            method: "notifications/progress",
            params: { progressToken: request.params._meta!.progressToken!, progress: ++progress },
          })
        }
        return { content: [{ type: "text", text: "late success" }] }
      } catch (error) {
        cancelled = extra.signal.aborted
        throw error
      }
    })
    const client = new Client({ name: "progress-client", version: "1" })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)])
    try {
      const converted = McpCatalog.convertTool(mcpTool(), client, 100)
      await expect(converted.execute!({}, options)).rejects.toThrow()
      expect(calls).toBe(1)
      expect(progress).toBeGreaterThan(0)
      expect(progress).toBeLessThan(15)
      expect(cancelled).toBe(true)
    } finally {
      await Promise.all([client.close(), server.close()])
    }
  })

  test("preserves the server's additionalProperties contract", () => {
    expect(
      McpCatalog.inputSchemaFor({
        name: "dynamic",
        inputSchema: {
          type: "object",
          properties: { labels: { type: "object" } },
          additionalProperties: true,
        },
      } as any),
    ).toMatchObject({
      type: "object",
      properties: { labels: { type: "object" } },
      additionalProperties: true,
    })
  })

  test("preserves content when structuredContent is also present", async () => {
    const content = [{ type: "image" as const, mimeType: "image/png", data: "AAAA" }]
    const structuredContent = { image: { mimeType: "image/png", data: "AAAA" } }
    const converted = McpCatalog.convertTool(mcpTool(), clientReturning({ content, structuredContent }))

    const output = await converted.execute?.({}, options)

    expect(output).toMatchObject({ content, structuredContent })
  })

  test("falls back to structuredContent only when content is absent", async () => {
    const structuredContent = { results: [{ title: "one" }] }
    const converted = McpCatalog.convertTool(mcpTool(), clientReturning({ content: [], structuredContent }))

    const output = await converted.execute?.({}, options)

    expect(output).toMatchObject({
      structuredContent,
      content: [{ type: "text", text: JSON.stringify(structuredContent) }],
    })
  })
})

test("preserves output schema validation across paginated tool discovery", async () => {
  const server = new Server({ name: "pagination", version: "1.0.0" }, { capabilities: { tools: {} } })
  server.setRequestHandler(ListToolsRequestSchema, ({ params }) =>
    Promise.resolve(
      params?.cursor === "page-2"
        ? {
            tools: [
              {
                name: "second",
                inputSchema: { type: "object" },
                outputSchema: {
                  type: "object",
                  properties: { value: { type: "number" } },
                  required: ["value"],
                },
              },
            ],
          }
        : {
            tools: [
              {
                name: "first",
                inputSchema: { type: "object" },
                outputSchema: {
                  type: "object",
                  properties: { value: { type: "string" } },
                  required: ["value"],
                },
              },
            ],
            nextCursor: "page-2",
          },
    ),
  )
  server.setRequestHandler(CallToolRequestSchema, ({ params }) =>
    Promise.resolve({
      content: [],
      structuredContent: { value: params.name === "first" ? 42 : 1 },
    }),
  )

  const client = new Client({ name: "pagination-test", version: "1.0.0" })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)])

  try {
    const tools = await Effect.runPromise(McpCatalog.defs(client))
    expect(tools?.map((tool) => tool.name)).toEqual(["first", "second"])
    await expect(client.callTool({ name: "first", arguments: {} })).rejects.toThrow(
      "Structured content does not match the tool's output schema",
    )
  } finally {
    await Promise.all([client.close(), server.close()])
  }
})
