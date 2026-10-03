import { describe, expect, it } from "bun:test"
import { Effect, Schema } from "effect"
import { Tool } from "../src/tool/tool"
import { automaticRead, majorImpact } from "../src/tool/effect-semantics"

const context = {
  sessionID: "session" as never,
  agent: "agent" as never,
  assistantMessageID: "message" as never,
  toolCallID: "call",
  permission: { assert: () => Effect.void },
  egress: {} as never,
} satisfies Tool.Context

const input = Schema.Struct({ path: Schema.String })
const output = Schema.String

describe("Tool execution metadata", () => {
  it("resolves a dynamic resource key once and derives idempotency from effects", () => {
    let resolverCalls = 0
    const tool = Tool.make({
      description: "read one file",
      input,
      output,
      effects: automaticRead({ filesystemScope: ["workspace"] }),
      metadata: {
        concurrency: "keyed",
        resourceKey: (value) => {
          resolverCalls += 1
          return `file:${value.path}`
        },
        outputPolicy: "both",
      },
      execute: (value) => Effect.succeed(value.path),
    })

    expect(Tool.executionMetadata(tool).resourceKey).toBeTypeOf("function")
    expect(resolverCalls).toBe(0)
    const resolved = Tool.resolveExecutionMetadata(
      tool,
      { path: "src/index.ts" },
      context,
      automaticRead({ filesystemScope: ["workspace"] }),
    )

    expect(resolved).toMatchObject({
      concurrency: "keyed",
      resourceKey: "file:src/index.ts",
      sideEffect: "read",
      idempotency: "idempotent",
      timeoutMode: "derived",
      outputPolicy: "both",
    })
    expect(resolverCalls).toBe(1)
  })

  it("defaults old tools to exclusive, conservative metadata", () => {
    const tool = Tool.make({
      description: "write something",
      input,
      output,
      effects: majorImpact(),
      execute: (value) => Effect.succeed(value.path),
    })

    expect(
      Tool.resolveExecutionMetadata(tool, { path: "x" }, context, majorImpact()),
    ).toMatchObject({
      concurrency: "exclusive",
      sideEffect: "write",
      idempotency: "non_idempotent",
      timeoutMode: "derived",
      outputPolicy: "both",
    })
  })

  it("fails closed for invalid resource keys, resolver failures and semantic conflicts", () => {
    expect(() =>
      Tool.make({
        description: "invalid",
        input,
        output,
        metadata: { resourceKey: "   " },
        execute: (value) => Effect.succeed(value.path),
      }),
    ).toThrow(/resourceKey must not be empty/)

    const throwing = Tool.make({
      description: "throwing resolver",
      input,
      output,
      metadata: { resourceKey: () => { throw new Error("unstable") } },
      execute: (value) => Effect.succeed(value.path),
    })
    expect(() => Tool.resolveExecutionMetadata(throwing, { path: "x" }, context)).toThrow(/resolver failed/)

    const conflicting = Tool.make({
      description: "conflict",
      input,
      output,
      effects: automaticRead(),
      metadata: { idempotency: "non_idempotent" },
      execute: (value) => Effect.succeed(value.path),
    })
    expect(() => Tool.resolveExecutionMetadata(conflicting, { path: "x" }, context, automaticRead())).toThrow(
      /does not match effect semantics/,
    )
  })
})
