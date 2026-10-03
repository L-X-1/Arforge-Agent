import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { ActionGateway } from "@arforge-ai/core/action-gateway"
import { SessionV1 } from "@arforge-ai/core/v1/session"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { MCP } from "../../src/mcp"
import { McpToolProjection } from "../../src/mcp/tool-projection"
import { MessageID, SessionID } from "../../src/session/schema"
import type { Agent } from "../../src/agent/agent"
import type { Truncate } from "../../src/tool/truncate"

const entry = {
  def: {
    name: "current",
    description: "current weather",
    inputSchema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
  },
  client: {
    callTool: async () => ({
      content: [{ type: "text" as const, text: "sunny" }],
    }),
  },
  generation: 4,
} as unknown as MCP.McpTool

const plugin = {
  trigger: () => Effect.void,
} as unknown as import("../../src/plugin").Plugin.Interface

const agents = {
  get: () => Effect.succeed({ name: "build", mode: "primary", permission: [], options: {} }),
} as unknown as Agent.Interface

const truncate = {
  output: (text: string) => Effect.succeed({ content: text, truncated: false }),
} as unknown as Truncate.Interface

const baseContext = {
  sessionID: SessionID.make("ses_projection"),
  messageID: MessageID.make("msg_projection"),
  agent: "build",
  abort: new AbortController().signal,
  callID: "call_projection",
  messages: [] as SessionV1.WithParts[],
  metadata: () => Effect.void,
  ask: (_input: unknown) => Effect.void,
  gateway: undefined,
  parentAction: {
    actionID: AgentRuntime.ActionID.make("act_projection"),
  },
} as const

describe("MCP ToolRegistry projection", () => {
  test("executes a generation-bound MCP tool through the shared child gateway", async () => {
    let gatewayCalls = 0
    let transportCalls = 0
    let asserted: unknown
    let asked: unknown
    const mcp = {
      assertCapability: (input: unknown) =>
        Effect.sync(() => {
          asserted = input
        }),
      declaredScope: () =>
        Effect.succeed({
          endpoint: "https://weather.example/mcp",
          networkScope: ["https://weather.example"],
          secretScope: [],
          externalServices: [],
        }),
    } as unknown as MCP.Interface
    const client = {
      callTool: async () => {
        transportCalls++
        return { content: [{ type: "text" as const, text: "sunny" }] }
      },
    }
    const def = McpToolProjection.make({
      key: "weather_current",
      server: "weather",
      entry: { ...entry, client } as unknown as MCP.McpTool,
      mcp,
      plugin,
      agents,
      truncate,
    })
    const gateway = {
      execute: (_request: unknown, options: { execute: () => Effect.Effect<unknown> }) => {
        gatewayCalls++
        return options.execute()
      },
    } as unknown as ActionGateway.Interface

    const result = await Effect.runPromise(
      def.execute(
        { city: "Paris" },
        {
          ...baseContext,
          gateway,
          ask: (input: unknown) =>
            Effect.sync(() => {
              asked = input
            }),
        },
      ),
    )

    expect(gatewayCalls).toBe(1)
    expect(transportCalls).toBe(1)
    expect(asserted).toEqual({ id: "weather_current", server: "weather", generation: 4, kind: "tool" })
    expect(asked).toMatchObject({ permission: "weather_current", patterns: ["*"] })
    expect(result.output).toContain("sunny")
    expect(result.output).toContain('source="remote_instruction"')
    expect(result.metadata).toMatchObject({ source: "mcp-capability-registry", generation: 4 })
  })

  test("fails closed before transport when the protected MCP scope is unavailable", async () => {
    let transportCalls = 0
    let asked: unknown
    const mcp = {
      assertCapability: () => Effect.void,
      declaredScope: () => Effect.succeed(undefined),
    } as unknown as MCP.Interface
    const def = McpToolProjection.make({
      key: "weather_current",
      server: "weather",
      entry: {
        ...entry,
        client: {
          callTool: async () => {
            transportCalls++
            return { content: [{ type: "text" as const, text: "must not run" }] }
          },
        },
      } as unknown as MCP.McpTool,
      mcp,
      plugin,
      agents,
      truncate,
    })
    const gateway = {
      execute: (_request: unknown, options: { execute: () => Effect.Effect<unknown> }) => options.execute(),
    } as unknown as ActionGateway.Interface

    const exit = await Effect.runPromiseExit(
      def.execute(
        {},
        {
          ...baseContext,
          gateway,
          ask: (input: unknown) =>
            Effect.sync(() => {
              asked = input
            }),
        },
      ),
    )
    expect(exit._tag).toBe("Failure")
    expect(asked).toBeUndefined()
    expect(transportCalls).toBe(0)
  })

  test("rechecks the capability generation inside the child action before transport", async () => {
    let assertions = 0
    let transportCalls = 0
    let asked = 0
    const mcp = {
      assertCapability: () => {
        assertions++
        return assertions === 1 ? Effect.void : Effect.fail(new Error("stale MCP generation"))
      },
      declaredScope: () =>
        Effect.succeed({
          endpoint: "https://weather.example/mcp",
          networkScope: ["https://weather.example"],
          secretScope: [],
          externalServices: [],
        }),
    } as unknown as MCP.Interface
    const def = McpToolProjection.make({
      key: "weather_current",
      server: "weather",
      entry: {
        ...entry,
        client: {
          callTool: async () => {
            transportCalls++
            return { content: [{ type: "text" as const, text: "must not run" }] }
          },
        },
      } as unknown as MCP.McpTool,
      mcp,
      plugin,
      agents,
      truncate,
    })
    const gateway = {
      execute: (_request: unknown, options: { execute: () => Effect.Effect<unknown> }) => options.execute(),
    } as unknown as ActionGateway.Interface

    const exit = await Effect.runPromiseExit(
      def.execute(
        { city: "Paris" },
        {
          ...baseContext,
          gateway,
          ask: () =>
            Effect.sync(() => {
              asked++
            }),
        },
      ),
    )

    expect(exit._tag).toBe("Failure")
    expect(assertions).toBe(2)
    expect(asked).toBe(1)
    expect(transportCalls).toBe(0)
  })
})
