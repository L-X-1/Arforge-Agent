import { Effect } from "effect"
import * as RuntimeInvariants from "../runtime/invariants"

/** The only legal order for a tool call in the canonical execution seam. */
export const ToolPipelineStages = [
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
] as const
export type ToolPipelineStage = (typeof ToolPipelineStages)[number]

export class ToolPipelineError extends Error {
  override readonly name = "Tool.ToolPipelineError"
}

export type ToolPipelineHooks<Resolved, Visible, Policy, Prepared, Executed, Normalized, Final, Settled, Failure> = {
  readonly resolve: () => Effect.Effect<Resolved, Failure>
  readonly visibility: (resolved: Resolved) => Effect.Effect<Visible, Failure>
  readonly policy: (visible: Visible) => Effect.Effect<Policy, Failure>
  readonly pre: (policy: Policy) => Effect.Effect<Prepared, Failure>
  /** `around` may short-circuit with a terminal result, but `next` is single-use. */
  readonly around: (
    prepared: Prepared,
    next: () => Effect.Effect<Executed, Failure | ToolPipelineError>,
  ) => Effect.Effect<Executed, Failure | ToolPipelineError>
  readonly execute: (
    prepared: Prepared,
    post: (executed: Executed) => Effect.Effect<Executed, Failure | ToolPipelineError>,
  ) => Effect.Effect<Executed, Failure | ToolPipelineError>
  /** Gateway owns the durable execute/post boundary, including replay without re-running post. */
  readonly postInExecute?: boolean
  readonly post: (prepared: Prepared, executed: Executed) => Effect.Effect<Executed, Failure>
  readonly normalize: (executed: Executed) => Effect.Effect<Normalized, Failure>
  readonly finalize: (normalized: Normalized) => Effect.Effect<Final, Failure>
  readonly settle: (final: Final) => Effect.Effect<Settled, Failure>
  readonly observeStage?: (stage: ToolPipelineStage) => void
  /** Shared diagnostics only; execution and settlement remain owned by the hooks above. */
  readonly invariants?: RuntimeInvariants.RuntimeInvariantRegistry
}

type ToolPipelineInvariantContext =
  | {
      readonly kind: "stage-order"
      readonly stage: ToolPipelineStage
      readonly trace: ReadonlyArray<ToolPipelineStage>
    }
  | {
      readonly kind: "settlement"
      readonly trace: ReadonlyArray<ToolPipelineStage>
    }

const stageSet: ReadonlySet<string> = new Set(ToolPipelineStages)

/** Validate a legal pipeline prefix; execute may be skipped only by `around`. */
export const assertToolPipelineTrace = (trace: ReadonlyArray<ToolPipelineStage>, complete = false): void => {
  if (!Array.isArray(trace) || trace.length === 0) throw new Error("tool pipeline trace is empty")
  let expectedIndex = 0
  for (const stage of trace) {
    if (!stageSet.has(stage)) throw new Error(`unknown tool pipeline stage: ${String(stage)}`)
    if (ToolPipelineStages[expectedIndex] === stage) {
      expectedIndex += 1
      continue
    }
    if (ToolPipelineStages[expectedIndex] === "execute" && stage === "post") {
      expectedIndex += 2
      continue
    }
    throw new Error(`tool pipeline stage is out of order: ${stage}`)
  }
  if (complete && (trace.at(-1) !== "settle" || expectedIndex !== ToolPipelineStages.length))
    throw new Error("tool pipeline settlement trace is incomplete")
}

/** Register the canonical pipeline checks into the shared package registry. */
export const registerInvariants = (registry: RuntimeInvariants.RuntimeInvariantRegistry): void => {
  if (!registry.get("tool-pipeline", "stage-order", "1"))
    registry.register({
      owner: "tool-pipeline",
      key: "stage-order",
      version: "1",
      cost: "cheap",
      check: (context) =>
        Effect.sync(() => {
          if (
            context === null ||
            typeof context !== "object" ||
            Array.isArray(context) ||
            (context as ToolPipelineInvariantContext).kind !== "stage-order"
          )
            throw new Error("tool pipeline stage invariant context is invalid")
          const value = context as Extract<ToolPipelineInvariantContext, { readonly kind: "stage-order" }>
          if (value.trace.at(-1) !== value.stage) throw new Error("tool pipeline stage does not close its trace")
          assertToolPipelineTrace(value.trace)
        }),
    })
  if (!registry.get("tool-pipeline", "settlement", "1"))
    registry.register({
      owner: "tool-pipeline",
      key: "settlement",
      version: "1",
      cost: "cheap",
      check: (context) =>
        Effect.sync(() => {
          if (
            context === null ||
            typeof context !== "object" ||
            Array.isArray(context) ||
            (context as ToolPipelineInvariantContext).kind !== "settlement"
          )
            throw new Error("tool pipeline settlement invariant context is invalid")
          assertToolPipelineTrace(
            (context as Extract<ToolPipelineInvariantContext, { readonly kind: "settlement" }>).trace,
            true,
          )
        }),
    })
}

const runtimeInvariantMode = (): RuntimeInvariants.InvariantMode =>
  process.env.NODE_ENV === "production" ? "production" : process.env.NODE_ENV === "test" ? "test" : "development"

const assertPipelineInvariant = (
  registry: RuntimeInvariants.RuntimeInvariantRegistry,
  key: "stage-order" | "settlement",
  context: ToolPipelineInvariantContext,
): Effect.Effect<void, ToolPipelineError> =>
  registry.assert(context, { owner: "tool-pipeline", key, mode: runtimeInvariantMode() }).pipe(
    Effect.mapError((error) => new ToolPipelineError(`Tool pipeline runtime invariant failed (${error.code})`)),
    Effect.asVoid,
  )

const observe = (
  hooks: {
    readonly observeStage?: (stage: ToolPipelineStage) => void
    readonly invariants?: RuntimeInvariants.RuntimeInvariantRegistry
  },
  stage: ToolPipelineStage,
  trace: ToolPipelineStage[],
) =>
  Effect.gen(function* () {
    trace.push(stage)
    try {
      hooks.observeStage?.(stage)
    } catch (error) {
      throw new ToolPipelineError(
        `Tool pipeline observer failed at ${stage}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    if (hooks.invariants)
      yield* assertPipelineInvariant(hooks.invariants, "stage-order", {
        kind: "stage-order",
        stage,
        trace: Object.freeze([...trace]),
      })
  })

/**
 * Run one tool call through the canonical stage order. This function is a
 * composition seam, not a second executor: the `execute` hook remains owned
 * by ToolRegistry/ActionGateway and `settle` remains the durable terminal
 * projection. A stage failure stops all later stages.
 */
export const run = <Resolved, Visible, Policy, Prepared, Executed, Normalized, Final, Settled, Failure>(
  hooks: ToolPipelineHooks<Resolved, Visible, Policy, Prepared, Executed, Normalized, Final, Settled, Failure>,
): Effect.Effect<Settled, Failure | ToolPipelineError> =>
  Effect.gen(function* () {
    const trace: ToolPipelineStage[] = []
    if (hooks.invariants) registerInvariants(hooks.invariants)
    yield* observe(hooks, "resolve", trace)
    const resolved = yield* hooks.resolve()
    yield* observe(hooks, "visibility", trace)
    const visible = yield* hooks.visibility(resolved)
    yield* observe(hooks, "policy", trace)
    const policy = yield* hooks.policy(visible)
    yield* observe(hooks, "pre", trace)
    const prepared = yield* hooks.pre(policy)
    yield* observe(hooks, "around", trace)
    let nextCalled = false
    let postCalled = false
    let postActive = false
    const post = (executed: Executed) =>
      Effect.gen(function* () {
        if (hooks.postInExecute && !postActive)
          return yield* Effect.fail(new ToolPipelineError("Tool pipeline post hook is no longer active"))
        if (postCalled) return yield* Effect.fail(new ToolPipelineError("Tool pipeline post hook was invoked twice"))
        postCalled = true
        yield* observe(hooks, "post", trace)
        return yield* hooks.post(prepared, executed)
      })
    const executed = yield* hooks.around(prepared, () => {
      if (nextCalled) return Effect.fail(new ToolPipelineError("Tool pipeline execute hook was invoked twice"))
      nextCalled = true
      return Effect.gen(function* () {
        yield* observe(hooks, "execute", trace)
        postActive = true
        return yield* Effect.suspend(() => hooks.execute(prepared, post)).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              postActive = false
            }),
          ),
        )
      })
    })
    // A replay or rejected execution can close the stage without invoking
    // post again. A fresh execution enters the same stage inside the durable
    // Gateway boundary; no second postprocessing pipeline exists.
    if (hooks.postInExecute && !postCalled) yield* observe(hooks, "post", trace)
    const posted = postCalled || hooks.postInExecute ? executed : yield* post(executed)
    yield* observe(hooks, "normalize", trace)
    const normalized = yield* hooks.normalize(posted)
    yield* observe(hooks, "finalize", trace)
    const finalized = yield* hooks.finalize(normalized)
    yield* observe(hooks, "settle", trace)
    const settled = yield* hooks.settle(finalized)
    if (hooks.invariants)
      yield* assertPipelineInvariant(hooks.invariants, "settlement", {
        kind: "settlement",
        trace: Object.freeze([...trace]),
      })
    return settled
  })
