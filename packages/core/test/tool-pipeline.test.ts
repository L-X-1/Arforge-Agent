import { describe, expect, it } from "bun:test"
import { Cause, Effect, Exit } from "effect"
import { RuntimeInvariantRegistry } from "../src/runtime/invariants"
import { ToolPipelineError, assertToolPipelineTrace, run as runToolPipeline } from "../src/tool/pipeline"

describe("canonical Tool Pipeline", () => {
  for (const mode of ["fresh", "replay", "duplicate", "late"] as const) {
    it(`keeps the gateway post continuation single-use and scoped (${mode})`, async () => {
      const stages: string[] = []
      let committed = false
      let postCalls = 0
      let savedPost: ((value: string) => Effect.Effect<string, ToolPipelineError>) | undefined
      const result = await Effect.runPromiseExit(
        runToolPipeline<string, string, string, string, string, string, string, string, never>({
          invariants: new RuntimeInvariantRegistry(),
          observeStage: (stage) => stages.push(stage),
          resolve: () => Effect.succeed("raw"),
          visibility: (value) => Effect.succeed(value),
          policy: (value) => Effect.succeed(value),
          pre: (value) => Effect.succeed(value),
          around: (_value, next) => next(),
          postInExecute: true,
          execute: (value: string, post) =>
            Effect.gen(function* () {
              savedPost = post
              committed = true
              if (mode === "replay" || mode === "late") return "stored display"
              const projected = yield* post(value)
              if (mode === "duplicate") return yield* post(value)
              return projected
            }),
          post: (_value, executed: string) =>
            Effect.sync(() => {
              expect(committed).toBe(true)
              postCalls++
              return `${executed}:display`
            }),
          normalize: (value) => Effect.succeed(value),
          finalize: (value) => Effect.succeed(value),
          settle: (value) => Effect.succeed(value),
        }),
      )
      if (mode === "duplicate") {
        expect(String(result)).toContain("post hook was invoked twice")
        expect(stages).not.toContain("normalize")
        expect(postCalls).toBe(1)
        return
      }
      expect(result).toEqual(Exit.succeed(mode === "fresh" ? "raw:display" : "stored display"))
      expect(stages).toEqual([
        "resolve",
        "visibility",
        "policy",
        "pre",
        "around",
        "execute",
        "post",
        "normalize",
        "finalize",
        "settle",
      ])
      if (mode === "late") {
        expect(savedPost).toBeDefined()
        const late = await Effect.runPromiseExit(savedPost!("late"))
        expect(String(late)).toContain("post hook is no longer active")
        expect(stages.at(-1)).toBe("settle")
      }
      expect(postCalls).toBe(mode === "fresh" ? 1 : 0)
    })
  }

  it("runs every stage in the deterministic order and preserves the terminal value", async () => {
    const stages: string[] = []
    const result = await Effect.runPromise(
      runToolPipeline({
        observeStage: (stage) => stages.push(stage),
        resolve: () => Effect.succeed("resolved"),
        visibility: (value) => Effect.succeed(`${value}:visible`),
        policy: (value) => Effect.succeed(`${value}:policy`),
        pre: (value) => Effect.succeed(`${value}:pre`),
        around: (_value, next) => next(),
        execute: (value) => Effect.succeed(`${value}:execute`),
        post: (value, executed) => Effect.succeed(`${value}:${executed}:post`),
        normalize: (value) => Effect.succeed(`${value}:normalize`),
        finalize: (value) => Effect.succeed(`${value}:finalize`),
        settle: (value) => Effect.succeed(`${value}:settle`),
      }),
    )

    expect(result).toBe(
      "resolved:visible:policy:pre:resolved:visible:policy:pre:execute:post:normalize:finalize:settle",
    )
    expect(stages).toEqual([
      "resolve",
      "visibility",
      "policy",
      "pre",
      "around",
      "execute",
      "post",
      "normalize",
      "finalize",
      "settle",
    ])
  })

  it("stops before later stages when preflight policy fails", async () => {
    const stages: string[] = []
    const exit = await Effect.runPromiseExit(
      runToolPipeline({
        observeStage: (stage) => stages.push(stage),
        resolve: () => Effect.succeed("resolved"),
        visibility: (value) => Effect.succeed(value),
        policy: () => Effect.fail(new Error("policy denied")),
        pre: (value) => Effect.succeed(value),
        around: (_value, next) => next(),
        execute: (value) => Effect.succeed(value),
        post: (_value, executed) => Effect.succeed(executed),
        normalize: (value) => Effect.succeed(value),
        finalize: (value) => Effect.succeed(value),
        settle: (value) => Effect.succeed(value),
      }),
    )

    expect(Exit.isFailure(exit)).toBe(true)
    expect(stages).toEqual(["resolve", "visibility", "policy"])
  })

  it("prevents an around hook from invoking the side-effect executor twice", async () => {
    const stages: string[] = []
    const exit = await Effect.runPromiseExit(
      runToolPipeline({
        observeStage: (stage) => stages.push(stage),
        resolve: () => Effect.succeed("resolved"),
        visibility: (value) => Effect.succeed(value),
        policy: (value) => Effect.succeed(value),
        pre: (value) => Effect.succeed(value),
        around: (_value, next) =>
          Effect.gen(function* () {
            yield* next()
            return yield* next()
          }),
        execute: (value) => Effect.succeed(value),
        post: (_value, executed) => Effect.succeed(executed),
        normalize: (value) => Effect.succeed(value),
        finalize: (value) => Effect.succeed(value),
        settle: (value) => Effect.succeed(value),
      }),
    )

    expect(Exit.isFailure(exit)).toBe(true)
    expect(stages).toEqual(["resolve", "visibility", "policy", "pre", "around", "execute"])
  })

  it("uses the shared registry for full and around-short-circuited settlement traces", async () => {
    const invariants = new RuntimeInvariantRegistry()
    const stages: string[] = []
    const result = await Effect.runPromise(
      runToolPipeline({
        invariants,
        observeStage: (stage) => stages.push(stage),
        resolve: () => Effect.succeed("resolved"),
        visibility: (value) => Effect.succeed(value),
        policy: (value) => Effect.succeed(value),
        pre: (value) => Effect.succeed(value),
        around: (value) => Effect.succeed(`${value}:cached`),
        execute: () => Effect.die("short-circuited execute must not run"),
        post: (_value, executed) => Effect.succeed(executed),
        normalize: (value) => Effect.succeed(value),
        finalize: (value) => Effect.succeed(value),
        settle: (value) => Effect.succeed(`${value}:settled`),
      }),
    )

    expect(result).toBe("resolved:cached:settled")
    expect(stages).toEqual([
      "resolve",
      "visibility",
      "policy",
      "pre",
      "around",
      "post",
      "normalize",
      "finalize",
      "settle",
    ])
    expect(invariants.list("tool-pipeline").map((invariant) => invariant.key)).toEqual(["stage-order", "settlement"])
    expect(() => assertToolPipelineTrace(["resolve", "policy"])).toThrow(/out of order/)
  })

  it("fails closed before a stage hook when its exact runtime invariant rejects", async () => {
    const invariants = new RuntimeInvariantRegistry()
    invariants.register({
      owner: "tool-pipeline",
      key: "stage-order",
      version: "1",
      cost: "cheap",
      check: () => Effect.fail(new Error("forced stage rejection")),
    })
    let resolveRan = false
    const exit = await Effect.runPromiseExit(
      runToolPipeline({
        invariants,
        resolve: () =>
          Effect.sync(() => {
            resolveRan = true
            return "resolved"
          }),
        visibility: (value) => Effect.succeed(value),
        policy: (value) => Effect.succeed(value),
        pre: (value) => Effect.succeed(value),
        around: (_value, next) => next(),
        execute: (value) => Effect.succeed(value),
        post: (_value, executed) => Effect.succeed(executed),
        normalize: (value) => Effect.succeed(value),
        finalize: (value) => Effect.succeed(value),
        settle: (value) => Effect.succeed(value),
      }),
    )

    expect(Exit.isFailure(exit)).toBe(true)
    expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toBeInstanceOf(ToolPipelineError)
    expect(resolveRan).toBe(false)
  })
})
