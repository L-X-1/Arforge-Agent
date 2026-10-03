import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { ActionGateway } from "@arforge-ai/core/action-gateway"
import { SessionV1 } from "@arforge-ai/core/v1/session"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { MCP } from "../../src/mcp"
import { McpResourceProjection } from "../../src/mcp/resource-projection"
import { MessageID, SessionID } from "../../src/session/schema"
import type { Agent } from "../../src/agent/agent"
import type { Truncate } from "../../src/tool/truncate"

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
  sessionID: SessionID.make("ses_resource_projection"),
  messageID: MessageID.make("msg_resource_projection"),
  agent: "build",
  abort: new AbortController().signal,
  callID: "call_resource_projection",
  messages: [] as SessionV1.WithParts[],
  metadata: () => Effect.void,
  ask: (_input: unknown) => Effect.void,
  gateway: undefined,
  parentAction: {
    actionID: AgentRuntime.ActionID.make("act_resource_projection"),
  },
} as const

const scope = {
  endpoint: "https://docs.example/mcp",
  networkScope: ["https://docs.example"],
  secretScope: [],
  externalServices: [],
}

describe("MCP prompt/resource ToolRegistry projections", () => {
  test("executes a prompt through the shared child gateway and preserves trust boundaries", async () => {
    let gatewayCalls = 0
    let promptCalls = 0
    let asked: unknown
    let asserted: unknown
    const mcp = {
      assertCapability: (input: unknown) =>
        Effect.sync(() => {
          asserted = input
        }),
      declaredScope: () => Effect.succeed(scope),
      getPrompt: (_server: string, _name: string, args?: Record<string, string>) =>
        Effect.sync(() => {
          promptCalls++
          return { messages: [{ role: "user", content: { type: "text" as const, text: `city=${args?.city}` } }] }
        }),
    } as unknown as MCP.Interface
    const def = McpResourceProjection.makePrompt({
      key: "mcp_prompt_weather_brief_abc",
      capabilityID: "weather:brief",
      server: "weather",
      generation: 6,
      entry: {
        name: "brief",
        description: "Build a weather brief",
        arguments: [{ name: "city", description: "City", required: true }],
        client: "weather",
        generation: 6,
      },
      mcp,
      plugin,
      agents,
      truncate,
    })
    const gateway = {
      execute: (_request: unknown, options: { execute: () => Effect.Effect<unknown, unknown, never> }) => {
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
    expect(promptCalls).toBe(1)
    expect(asserted).toEqual({ id: "weather:brief", server: "weather", generation: 6, kind: "prompt" })
    expect(asked).toMatchObject({ permission: "read", patterns: ["mcp:weather:brief"] })
    expect(result.output).toContain("user: city=Paris")
    expect(result.output).toContain('source="remote_instruction"')
    expect(result.metadata).toMatchObject({ kind: "prompt", generation: 6 })
  })

  test("expands a resource template with encoded arguments and keeps the raw URI only for transport", async () => {
    let readURI = ""
    let gatewayCalls = 0
    const mcp = {
      assertCapability: () => Effect.void,
      declaredScope: () => Effect.succeed(scope),
      readResource: (_server: string, uri: string) =>
        Effect.sync(() => {
          readURI = uri
          return { contents: [{ uri, text: "documentation" }] }
        }),
    } as unknown as MCP.Interface
    const def = McpResourceProjection.makeResourceTemplate({
      key: "mcp_resource_template_docs_item_abc",
      capabilityID: "docs:docs://item/{id}",
      server: "docs",
      generation: 3,
      entry: {
        name: "item",
        uriTemplate: "docs://item/{id}",
        client: "docs",
        generation: 3,
      },
      mcp,
      plugin,
      agents,
      truncate,
    })
    const gateway = {
      execute: (_request: unknown, options: { execute: () => Effect.Effect<unknown, unknown, never> }) => {
        gatewayCalls++
        return options.execute()
      },
    } as unknown as ActionGateway.Interface

    const result = await Effect.runPromise(
      def.execute(
        { id: "a/b" },
        {
          ...baseContext,
          gateway,
        },
      ),
    )

    expect(gatewayCalls).toBe(1)
    expect(readURI).toBe("docs://item/a%2Fb")
    expect(result.output).toContain("documentation")
    expect(result.metadata).toMatchObject({ kind: "resource", uri: "docs://item/a%2Fb" })
  })

  test("generic URI reader resolves the current capability before using a caller-supplied URI", async () => {
    let readURI = ""
    let asserted: unknown
    let asked: unknown
    const mcp = {
      assertCapability: (input: unknown) =>
        Effect.sync(() => {
          asserted = input
        }),
      declaredScope: () => Effect.succeed(scope),
      resources: () =>
        Effect.succeed({
          "docs:docs://readme": {
            name: "readme",
            uri: "docs://readme",
            client: "docs",
            generation: 8,
          },
        }),
      readResource: (_server: string, uri: string) =>
        Effect.sync(() => {
          readURI = uri
          return { contents: [{ uri, text: "readme" }] }
        }),
    } as unknown as MCP.Interface
    const def = McpResourceProjection.makeResourceRead({
      key: "read_mcp_resource",
      server: "mcp",
      mcp,
      plugin,
      agents,
      truncate,
    })
    const gateway = {
      execute: (_request: unknown, options: { execute: () => Effect.Effect<unknown, unknown, never> }) =>
        options.execute(),
    } as unknown as ActionGateway.Interface

    const result = await Effect.runPromise(
      def.execute(
        { server: "docs", uri: "docs://readme" },
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

    expect(readURI).toBe("docs://readme")
    expect(asserted).toEqual({ id: "docs:docs://readme", server: "docs", generation: 8, kind: "resource" })
    expect(asked).toMatchObject({ permission: "read", patterns: ["mcp:docs:docs://readme"] })
    expect(result.output).toContain("readme")
  })

  test("lists a server catalog through the shared child gateway with a replay-safe projection", async () => {
    let gatewayCalls = 0
    let sourceCalls = 0
    let gatewayRequest: unknown
    const mcp = {
      clients: () => Effect.succeed({ docs: {} }),
      health: () => Effect.succeed({ docs: { observedGeneration: 4 } }),
      declaredScope: () => Effect.succeed(scope),
      resources: (server?: string) =>
        Effect.sync(() => {
          sourceCalls++
          expect(server).toBe("docs")
          return {
            "docs:docs://readme": {
              name: "readme",
              uri: "docs://readme",
              description: "Project docs",
              client: "docs",
              generation: 4,
            },
          }
        }),
    } as unknown as MCP.Interface
    const def = McpResourceProjection.makeResourceList({
      key: "list_mcp_resources",
      server: "mcp",
      kind: "resource",
      mcp,
      plugin,
      agents,
      truncate,
    })
    const gateway = {
      execute: (request: unknown, options: { execute: () => Effect.Effect<unknown, unknown, never> }) => {
        gatewayCalls++
        gatewayRequest = request
        return options.execute()
      },
    } as unknown as ActionGateway.Interface

    const result = await Effect.runPromise(
      def.execute(
        {},
        {
          ...baseContext,
          gateway,
          ask: () => Effect.void,
        },
      ),
    )

    expect(gatewayCalls).toBe(1)
    expect(sourceCalls).toBe(1)
    expect(result.output).toContain('"uri": "docs://readme"')
    expect(result.output).toContain('"server": "docs"')
    expect(JSON.stringify(gatewayRequest)).not.toContain("Client")
  })

  test("blocks a catalog when the supervisor generation changes before transport", async () => {
    let sourceCalls = 0
    let healthCalls = 0
    const mcp = {
      clients: () => Effect.succeed({ docs: {} }),
      health: () =>
        Effect.sync(() => {
          healthCalls++
          return { docs: { observedGeneration: healthCalls === 1 ? 4 : 5 } }
        }),
      declaredScope: () => Effect.succeed(scope),
      resources: () =>
        Effect.sync(() => {
          sourceCalls++
          return { "docs:docs://readme": { name: "readme", uri: "docs://readme", client: "docs" } }
        }),
    } as unknown as MCP.Interface
    const def = McpResourceProjection.makeResourceList({
      key: "list_mcp_resources",
      server: "mcp",
      kind: "resource",
      mcp,
      plugin,
      agents,
      truncate,
    })
    const gateway = {
      execute: (_request: unknown, options: { execute: () => Effect.Effect<unknown, unknown, never> }) =>
        options.execute(),
    } as unknown as ActionGateway.Interface

    const exit = await Effect.runPromiseExit(
      def.execute(
        {},
        {
          ...baseContext,
          gateway,
          ask: () => Effect.void,
        },
      ),
    )
    expect(exit._tag).toBe("Failure")
    expect(sourceCalls).toBe(0)
    expect(healthCalls).toBe(2)
  })

  test("blocks before permission and transport when scope evidence is unavailable", async () => {
    let asked = false
    let reads = 0
    const mcp = {
      assertCapability: () => Effect.void,
      declaredScope: () => Effect.succeed(undefined),
      readResource: () =>
        Effect.sync(() => {
          reads++
          return { contents: [{ uri: "docs://readme", text: "must not run" }] }
        }),
    } as unknown as MCP.Interface
    const def = McpResourceProjection.makeResource({
      key: "mcp_resource_docs_readme_abc",
      capabilityID: "docs:docs://readme",
      server: "docs",
      generation: 2,
      entry: { name: "readme", uri: "docs://readme", client: "docs", generation: 2 },
      mcp,
      plugin,
      agents,
      truncate,
    })
    const gateway = {
      execute: (_request: unknown, options: { execute: () => Effect.Effect<unknown, unknown, never> }) =>
        options.execute(),
    } as unknown as ActionGateway.Interface

    const exit = await Effect.runPromiseExit(
      def.execute(
        {},
        {
          ...baseContext,
          gateway,
          ask: () =>
            Effect.sync(() => {
              asked = true
            }),
        },
      ),
    )
    expect(exit._tag).toBe("Failure")
    expect(asked).toBe(false)
    expect(reads).toBe(0)
  })

  test("does not expose unsupported prompt images as executable attachments", async () => {
    const mcp = {
      assertCapability: () => Effect.void,
      declaredScope: () => Effect.succeed(scope),
      getPrompt: () =>
        Effect.succeed({
          messages: [
            {
              role: "assistant",
              content: { type: "image" as const, mimeType: "image/svg+xml", data: "c3Zn" },
            },
          ],
        }),
    } as unknown as MCP.Interface
    const def = McpResourceProjection.makePrompt({
      key: "mcp_prompt_docs_image_abc",
      capabilityID: "docs:image",
      server: "docs",
      entry: { name: "image", client: "docs" },
      mcp,
      plugin,
      agents,
      truncate,
    })
    const gateway = {
      execute: (_request: unknown, options: { execute: () => Effect.Effect<unknown, unknown, never> }) =>
        options.execute(),
    } as unknown as ActionGateway.Interface

    const result = await Effect.runPromise(
      def.execute(
        {},
        {
          ...baseContext,
          gateway,
        },
      ),
    )

    expect(result.attachments).toEqual([])
    expect(result.output).toContain("not a supported attachment type")
  })
})

describe("RFC 6570 resource template expansion", () => {
  const variables = {
    var: "value",
    hello: "Hello World!",
    path: "/foo/bar",
    empty: "",
    list: ["red", "green", "blue"],
    keys: { semi: ";", dot: ".", comma: "," },
  } as const

  test("expands scalar operators with RFC prefixes and reserved encoding", () => {
    expect(McpResourceProjection.expandUriTemplate("{var}", variables)).toBe("value")
    expect(McpResourceProjection.expandUriTemplate("{hello}", variables)).toBe("Hello%20World%21")
    expect(McpResourceProjection.expandUriTemplate("{+path}/here", variables)).toBe("/foo/bar/here")
    expect(McpResourceProjection.expandUriTemplate("{#path}", variables)).toBe("#/foo/bar")
    expect(McpResourceProjection.expandUriTemplate("X{.var}", variables)).toBe("X.value")
    expect(McpResourceProjection.expandUriTemplate("X{.empty}", variables)).toBe("X")
    expect(McpResourceProjection.expandUriTemplate("{/var}", variables)).toBe("/value")
    expect(McpResourceProjection.expandUriTemplate("{var:3}", variables)).toBe("val")
  })

  test("expands list and map values with explode and named operators", () => {
    expect(McpResourceProjection.expandUriTemplate("{/list}", variables)).toBe("/red,green,blue")
    expect(McpResourceProjection.expandUriTemplate("{/list*}", variables)).toBe("/red/green/blue")
    expect(McpResourceProjection.expandUriTemplate("{;list}", variables)).toBe(";list=red,green,blue")
    expect(McpResourceProjection.expandUriTemplate("{;list*}", variables)).toBe(";list=red;list=green;list=blue")
    expect(McpResourceProjection.expandUriTemplate("{?keys}", variables)).toBe("?keys=semi,%3B,dot,.,comma,%2C")
    expect(McpResourceProjection.expandUriTemplate("{?keys*}", variables)).toBe("?semi=%3B&dot=.&comma=%2C")
  })

  test("omits missing variables without creating an unsafe literal expression", () => {
    expect(McpResourceProjection.expandUriTemplate("docs://{id}{?version}", { id: "readme" })).toBe("docs://readme")
    expect(McpResourceProjection.expandUriTemplate("/search{?q}", { q: "a&b" })).toBe("/search?q=a%26b")
  })

  test("rejects malformed expressions and invalid modifiers before transport", () => {
    expect(() => McpResourceProjection.expandUriTemplate("/docs/{", {})).toThrow("unmatched brace")
    expect(() => McpResourceProjection.expandUriTemplate("/docs/{id:0}", { id: "readme" })).toThrow("positive integer")
    expect(() => McpResourceProjection.expandUriTemplate("/docs/{id:3*}", { id: "readme" })).toThrow(
      "combine explode and prefix",
    )
  })
})
