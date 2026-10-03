export * as PersonalJobExecutor from "./personal-job-executor"

import { PersonalJob } from "@arforge-ai/schema/personal-job"
import { Billing } from "@arforge-ai/schema/billing"
import { PromptInput } from "@arforge-ai/schema/prompt-input"
import { SessionMessage } from "@arforge-ai/schema/session-message"
import { Cause, Context, DateTime, Effect, Exit, Fiber, Layer, Schedule, Schema } from "effect"
import { makeGlobalNode } from "./effect/app-node"
import { Database } from "./database/database"
import { Catalog } from "./catalog"
import { LocationServiceMap } from "./location-service-map"
import { PersonalJobV2 } from "./personal-job"
import { SessionV2 } from "./session"
import * as RuntimeBilling from "./runtime/billing"
import { redact } from "./redact"
import { artifactsFromAssistant, summaryFromAssistant, truncateSummary, resultDigest } from "./personal-job-result"

/**
 * The executor is intentionally a small trusted adapter around the existing
 * Personal Job and Session services. It does not create a second job state
 * store, expose credentials, or bypass the Session Runner.
 */

export class NotRunnableError extends Schema.TaggedErrorClass<NotRunnableError>()(
  "PersonalJobExecutor.NotRunnableError",
  {
    jobID: PersonalJob.ID,
    reason: Schema.String,
  },
) {
  override get message() {
    return this.reason
  }
}

export class CredentialBindingUnavailableError extends Schema.TaggedErrorClass<CredentialBindingUnavailableError>()(
  "PersonalJobExecutor.CredentialBindingUnavailableError",
  {
    jobID: PersonalJob.ID,
    credentialIDs: Schema.Array(Schema.String),
  },
) {}

export type JobRuntime = Pick<PersonalJobV2.Interface, "get" | "start" | "recordResult"> &
  Partial<Pick<PersonalJobV2.Interface, "heartbeat" | "recover" | "reconcileResult">>
export type SessionRuntime = Pick<SessionV2.Interface, "context" | "prompt" | "resume" | "interrupt"> &
  Partial<Pick<SessionV2.Interface, "resumeWithCredentials">>
export type BillingRuntime = (input: {
  readonly job: PersonalJob.Info
  readonly onSettlement: RuntimeBilling.SettlementObserver
}) => Effect.Effect<RuntimeBilling.RunConfig | undefined, NotRunnableError>
export type ExecuteError = PersonalJobV2.DomainError | NotRunnableError | CredentialBindingUnavailableError

export interface ExecuteInput {
  readonly jobID: PersonalJob.ID
  readonly expectedRevision: number
  /** Explicit user action may execute before the saved schedule is due. */
  readonly allowEarly?: boolean
}

export interface DispatchInput {
  readonly now?: number
  readonly limit?: number
  readonly sessionID?: PersonalJob.Info["sessionID"]
}

export interface DispatchResult {
  /** Number of stale worker leases requeued or durably failed before dispatch. */
  readonly recovered: number
  /** Number of recurring schedules durably advanced before dispatch. */
  readonly advanced: number
  /** Number of due jobs selected for an execution attempt. */
  readonly attempted: number
  /** Number of selected jobs whose durable result completed successfully. */
  readonly completed: number
  /** Number of selected jobs whose durable result settled as failed. */
  readonly failed: number
  /** Number of selected jobs that were skipped because the execution contract was not runnable. */
  readonly skipped: number
}

export type DispatchError = ExecuteError

export interface Interface {
  /** Execute one queued job through the real Session Runner and settle its durable result. */
  readonly execute: (input: ExecuteInput) => Effect.Effect<PersonalJob.Info, ExecuteError>
  /** Admit one job and continue execution in a detached local fiber. */
  readonly launch: (input: ExecuteInput) => Effect.Effect<PersonalJob.Info, ExecuteError>
  /** Advance and execute a bounded set of due jobs for the current principal. */
  readonly dispatchDue: (input?: DispatchInput) => Effect.Effect<DispatchResult, DispatchError>
  /** Interrupt the local Session Runner for an actively executing job. */
  readonly interrupt: (input: {
    readonly jobID: PersonalJob.ID
    readonly sessionID: PersonalJob.Info["sessionID"]
  }) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@arforge/v2/PersonalJobExecutor") {}

const maximumDispatchLimit = 32

const publicFailure = (error: Exit.Exit<unknown, unknown>) => {
  if (Exit.isFailure(error)) return redact(Cause.pretty(error.cause)).slice(0, 2_000)
  return "Personal background execution failed."
}

const latestFreshAssistant = (
  before: ReadonlySet<SessionMessage.ID>,
  messages: ReadonlyArray<SessionMessage.Message>,
) => {
  for (const message of messages.toReversed()) {
    if (!before.has(message.id) && message.type === "assistant") return message
  }
  return undefined
}

/**
 * Execute through injected services so the lifecycle can be tested without a
 * live provider. Production wiring below supplies the real Session service.
 */
type ExecutionRuntime = {
  readonly jobs: JobRuntime
  readonly sessions: SessionRuntime
  readonly billing?: BillingRuntime
}

type PreparedExecution = {
  readonly started: PersonalJob.Info
  readonly messageID: SessionMessage.ID
  readonly billing: RuntimeBilling.RunConfig | undefined
  readonly observedCostMicros: () => number
}

const prepareWith = (
  runtime: ExecutionRuntime,
  input: ExecuteInput,
): Effect.Effect<PreparedExecution | { readonly settled: PersonalJob.Info }, ExecuteError> =>
  Effect.gen(function* () {
    const current = yield* runtime.jobs.get(input.jobID)
    if (current.revision !== input.expectedRevision)
      return yield* new NotRunnableError({
        jobID: current.id,
        reason: "The job changed before execution started; refresh and retry.",
      })
    if (runtime.jobs.reconcileResult) {
      const reconciled = yield* runtime.jobs.reconcileResult({ jobID: current.id, expectedRevision: current.revision })
      if (["completed", "failed"].includes(reconciled.status) && reconciled.result) return { settled: reconciled }
    }
    if (current.credentialIDs.length > 0 && runtime.sessions.resumeWithCredentials === undefined)
      return yield* new CredentialBindingUnavailableError({
        jobID: current.id,
        credentialIDs: [...current.credentialIDs],
      })
    if (runtime.sessions.resumeWithCredentials === undefined)
      return yield* new NotRunnableError({
        jobID: current.id,
        reason: "This session runtime cannot bind the original PersonalJob occurrence to its execution.",
      })
    if (current.status !== "queued") {
      const reason =
        current.status === "awaiting_approval"
          ? "The job requires approval before it can run."
          : `The job is ${current.status} and is not queued for execution.`
      return yield* new NotRunnableError({ jobID: current.id, reason })
    }

    let observedCostMicros = 0
    const billing = runtime.billing
      ? yield* runtime.billing({
          job: current,
          onSettlement: ({ costMicros }) => {
            observedCostMicros = Number.isSafeInteger(observedCostMicros + costMicros)
              ? observedCostMicros + costMicros
              : Number.MAX_SAFE_INTEGER
          },
        })
      : undefined
    if (billing !== undefined && runtime.sessions.resumeWithCredentials === undefined)
      return yield* new NotRunnableError({
        jobID: current.id,
        reason: "The verified billing contract cannot be attached to this session runtime.",
      })

    const started = yield* runtime.jobs.start({
      jobID: current.id,
      expectedRevision: current.revision,
      allowEarly: input.allowEarly,
    })
    if (started.occurrence === undefined)
      return yield* new NotRunnableError({
        jobID: started.id,
        reason: "The job runtime did not retain the original execution input identity.",
      })
    return { started, messageID: started.occurrence.messageID, billing, observedCostMicros: () => observedCostMicros }
  })

const runPreparedWith = (
  runtime: Pick<ExecutionRuntime, "jobs" | "sessions">,
  prepared: PreparedExecution,
): Effect.Effect<PersonalJob.Info, ExecuteError> =>
  Effect.gen(function* () {
    const { billing, started } = prepared
    const startedAt = Date.now()
    const settle = (result: Omit<PersonalJob.Result, "recordedAt" | "digest">) =>
      Effect.gen(function* () {
        const latest = yield* runtime.jobs.get(started.id)
        // A user pause/cancel wins over a late provider result. The executor
        // never resurrects a job that the user has already stopped.
        if (latest.status !== "running" || latest.execution?.leaseID !== started.execution?.leaseID) return latest
        return yield* runtime.jobs.recordResult({
          jobID: started.id,
          expectedRevision: latest.revision,
          result: { ...result, digest: resultDigest(result) },
        })
      })

    const reconcileCurrent = runtime.jobs.reconcileResult
      ? () =>
          Effect.gen(function* () {
            const latest = yield* runtime.jobs.get(started.id)
            if (latest.status !== "running" || latest.execution?.leaseID !== started.execution?.leaseID) return latest
            return yield* runtime.jobs.reconcileResult!({ jobID: latest.id, expectedRevision: latest.revision })
          })
      : undefined
    const restored = reconcileCurrent ? yield* reconcileCurrent() : undefined
    if (restored && restored.status !== "running") return restored

    const beforeExit = yield* runtime.sessions.context(started.sessionID).pipe(Effect.exit)
    if (Exit.isFailure(beforeExit))
      return yield* settle({
        status: "failed",
        summary: truncateSummary(publicFailure(beforeExit), "Unable to read the session before execution."),
        artifactRefs: [],
        usage: { durationMs: 0, costMicros: 0 },
      })

    const before = new Set(beforeExit.value.map((message) => message.id))
    const messageID = prepared.messageID
    const admitted = yield* runtime.sessions
      .prompt({
        id: messageID,
        sessionID: started.sessionID,
        prompt: PromptInput.Prompt.make({ text: started.prompt }),
        delivery: "queue",
        resume: false,
      })
      .pipe(Effect.exit)
    if (Exit.isFailure(admitted))
      return yield* settle({
        status: "failed",
        summary: truncateSummary(publicFailure(admitted), "The background prompt could not be admitted."),
        artifactRefs: [],
        usage: { durationMs: 0, costMicros: 0 },
      })

    const remainingDuration = Math.max(0, started.budget.maxDurationMs - started.budget.durationMsUsed)
    // The timeout is applied around the actual Session Runner effect so a
    // provider that never settles cannot leave the durable Personal Job in
    // `running` forever. Effect.timeout interrupts the runner fiber when the
    // budget window closes; the normal settlement guard below still prevents
    // any late result from resurrecting a user-paused/cancelled job.
    const resume = runtime.sessions.resumeWithCredentials!({
      sessionID: started.sessionID,
      credentialIDs: started.credentialIDs,
      billing,
      personalJob: { jobID: started.id, occurrence: started.occurrence! },
    })
    const heartbeatFiber = runtime.jobs.heartbeat
      ? yield* Effect.gen(function* () {
          while (true) {
            yield* Effect.sleep("15 seconds")
            yield* runtime.jobs.heartbeat!({
              jobID: started.id,
              expectedRevision: (yield* runtime.jobs.get(started.id)).revision,
            })
          }
        }).pipe(
          Effect.catch(() => Effect.void),
          Effect.forkChild,
        )
      : undefined
    const run = heartbeatFiber === undefined ? resume : resume.pipe(Effect.ensuring(Fiber.interrupt(heartbeatFiber)))
    const execution = yield* run.pipe(
      Effect.exit,
      Effect.timeoutOrElse({
        duration: remainingDuration,
        orElse: () => Effect.succeed(undefined),
      }),
    )
    if (execution === undefined)
      yield* runtime.sessions.interrupt(started.sessionID).pipe(Effect.catch(() => Effect.void))
    const recorded = reconcileCurrent ? yield* reconcileCurrent() : undefined
    if (recorded && recorded.status !== "running") return recorded
    const afterExit = yield* runtime.sessions.context(started.sessionID).pipe(Effect.exit)
    const after = Exit.isSuccess(afterExit) ? afterExit.value : []
    const assistant = runtime.jobs.reconcileResult ? undefined : latestFreshAssistant(before, after)
    const elapsed = Math.max(0, Date.now() - startedAt)
    const durationMs = Math.min(elapsed, remainingDuration)
    const timedOut = execution === undefined
    const executionFailure = timedOut
      ? "The job exceeded its duration budget."
      : Exit.isFailure(execution)
        ? publicFailure(execution)
        : Exit.isFailure(afterExit)
          ? publicFailure(afterExit)
          : undefined
    const assistantFailure = assistant?.error?.message
    const overDuration = timedOut || elapsed > remainingDuration
    const remainingCost = Math.max(0, started.budget.maxCostMicros - started.budget.costMicrosUsed)
    const observedCostMicros = prepared.observedCostMicros()
    const overCost = observedCostMicros > remainingCost
    const failed =
      executionFailure !== undefined ||
      assistantFailure !== undefined ||
      assistant === undefined ||
      overDuration ||
      overCost
    const summary = failed
      ? truncateSummary(
          assistantFailure ??
            executionFailure ??
            (overDuration
              ? "The job exceeded its duration budget."
              : overCost
                ? "The job exceeded its cost budget."
                : "No assistant result was recorded."),
          "The background job did not produce a usable result.",
        )
      : truncateSummary(summaryFromAssistant(assistant), "The background job completed without a text summary.")

    // Without an explicit currency-bound catalog, keep cost at zero rather
    // than inventing a billing value. When one is configured, the Session
    // runner's settlement observer has already accumulated the real charge.
    const artifacts = artifactsFromAssistant(assistant, started.sessionID)
    return yield* settle({
      status: failed ? "failed" : "completed",
      summary,
      artifactRefs: artifacts.map((artifact) => artifact.id),
      ...(artifacts.length > 0 ? { artifacts } : {}),
      usage: { durationMs, costMicros: observedCostMicros },
    })
  })

export const executeWith = (
  runtime: ExecutionRuntime,
  input: ExecuteInput,
): Effect.Effect<PersonalJob.Info, ExecuteError> =>
  prepareWith(runtime, input).pipe(
    Effect.flatMap((prepared) =>
      "settled" in prepared ? Effect.succeed(prepared.settled) : runPreparedWith(runtime, prepared),
    ),
  )

export const launchWith = (
  runtime: ExecutionRuntime & {
    readonly active?: Map<PersonalJob.ID, PersonalJob.Info["sessionID"]>
  },
  input: ExecuteInput,
): Effect.Effect<PersonalJob.Info, ExecuteError> =>
  Effect.gen(function* () {
    const prepared = yield* prepareWith(runtime, input)
    if ("settled" in prepared) return prepared.settled
    runtime.active?.set(prepared.started.id, prepared.started.sessionID)
    yield* runPreparedWith(runtime, prepared).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Detached Personal Job execution failed before durable settlement", {
          jobID: prepared.started.id,
          cause,
        }),
      ),
      Effect.ensuring(Effect.sync(() => runtime.active?.delete(prepared.started.id))),
      Effect.forkDetach({ startImmediately: true }),
    )
    return prepared.started
  })

export const dispatchDueWith = (
  runtime: {
    readonly jobs: Pick<PersonalJobV2.Interface, "tick" | "list"> & Partial<Pick<PersonalJobV2.Interface, "recover">>
    readonly execute: Interface["execute"]
  },
  input: DispatchInput = {},
): Effect.Effect<DispatchResult, DispatchError> =>
  Effect.gen(function* () {
    const limit = input.limit ?? 8
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > maximumDispatchLimit)
      return yield* new PersonalJobV2.InvalidInputError({
        message: `dispatch.limit must be a positive safe integer no greater than ${maximumDispatchLimit}.`,
      })
    const now = input.now ?? Date.now()
    if (!Number.isSafeInteger(now) || now < 0)
      return yield* new PersonalJobV2.InvalidInputError({
        message: "dispatch.now must be a non-negative safe integer.",
      })

    const recovered = runtime.jobs.recover ? yield* runtime.jobs.recover({ now, limit, sessionID: input.sessionID }) : 0
    const advanced = yield* runtime.jobs.tick({ now, limit, sessionID: input.sessionID })
    const jobs = yield* runtime.jobs.list({ sessionID: input.sessionID })
    const due = jobs
      .filter(
        (job) =>
          job.status === "queued" &&
          // `tick`, pause/resume, and stale-worker recovery preserve
          // `time.started` for an occurrence that has already been admitted.
          // This closes the crash gap after a recurring schedule advances its
          // nextRunAt to the following future occurrence.
          (DateTime.toEpochMillis(job.schedule.nextRunAt) <= now || job.time.started !== undefined),
      )
      .slice(0, limit)

    let completed = 0
    let failed = 0
    let skipped = 0
    for (const job of due) {
      const outcome = yield* runtime.execute({ jobID: job.id, expectedRevision: job.revision }).pipe(Effect.exit)
      if (Exit.isFailure(outcome)) {
        skipped++
        continue
      }
      if (outcome.value.status === "completed") completed++
      else if (outcome.value.status === "failed") failed++
      else if (outcome.value.status !== "running") skipped++
    }
    return { recovered, advanced, attempted: due.length, completed, failed, skipped }
  })

export const interruptWith = (
  runtime: {
    readonly sessions: Pick<SessionRuntime, "interrupt">
    readonly active: ReadonlyMap<PersonalJob.ID, PersonalJob.Info["sessionID"]>
  },
  input: {
    readonly jobID: PersonalJob.ID
    readonly sessionID: PersonalJob.Info["sessionID"]
  },
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const sessionID = runtime.active.get(input.jobID)
    if (sessionID === undefined || sessionID !== input.sessionID) return
    yield* runtime.sessions.interrupt(sessionID)
  })

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const jobs = yield* PersonalJobV2.Service
    const sessions = yield* SessionV2.Service
    const locations = yield* LocationServiceMap.Service
    const active = new Map<PersonalJob.ID, PersonalJob.Info["sessionID"]>()
    const billing: BillingRuntime = ({ job, onSettlement }) =>
      Effect.gen(function* () {
        const session = yield* sessions.get(job.sessionID).pipe(Effect.orDie)
        const model = yield* Effect.gen(function* () {
          const catalog = yield* Catalog.Service
          return session.model
            ? yield* catalog.model.get(session.model.providerID, session.model.id)
            : yield* catalog.model.default()
        }).pipe(Effect.provide(locations.get(session.location)), Effect.orDie)
        const priceCatalog = model?.priceCatalog
        if (priceCatalog === undefined || DateTime.toEpochMillis(priceCatalog.effectiveFrom) > Date.now()) {
          const selected = model ?? session.model
          const identity = selected ? `${selected.providerID}/${selected.id}` : "the selected model"
          const setting = selected
            ? `providers[${JSON.stringify(selected.providerID)}].models[${JSON.stringify(selected.id)}].priceCatalog`
            : "providers.<providerID>.models.<modelID>.priceCatalog"
          return yield* new NotRunnableError({
            jobID: job.id,
            reason: `No effective verified price catalog is available for ${identity}. Set ${setting} in arforge.json or arforge.jsonc to a current price catalog (including explicit zero rates for a free model), reopen the workspace or restart Arforge to load the saved configuration, then retry this job. The job has not started and its attempt budget is unchanged.`,
          })
        }
        const microsPerMinor = 10 ** (6 - priceCatalog.minorUnit)
        const remainingMicros = Math.max(0, job.budget.maxCostMicros - job.budget.costMicrosUsed)
        return {
          budget: Billing.Budget.make({
            currency: priceCatalog.currency,
            limitMinor: Math.floor(remainingMicros / microsPerMinor),
          }),
          resolveCatalog: ({ providerID, modelID }) =>
            providerID === String(model?.providerID) && modelID === String(model?.id) ? priceCatalog : undefined,
          onSettlement,
        } satisfies RuntimeBilling.RunConfig
      })
    const execute: Interface["execute"] = (input) =>
      Effect.gen(function* () {
        const current = yield* jobs.get(input.jobID)
        active.set(current.id, current.sessionID)
        return yield* executeWith({ jobs, sessions, billing }, input).pipe(
          Effect.ensuring(Effect.sync(() => active.delete(current.id))),
        )
      })
    const launch: Interface["launch"] = (input) => launchWith({ jobs, sessions, billing, active }, input)
    const interrupt: Interface["interrupt"] = Effect.fn("PersonalJobExecutor.interrupt")((input) =>
      interruptWith({ sessions, active }, input),
    )
    const service = Service.of({
      execute,
      launch,
      dispatchDue: (input) => dispatchDueWith({ jobs, execute: launch }, input),
      interrupt,
    })
    // The desktop/local runtime has one implicit principal. Keep a small
    // process-local poller for that principal so a closed task panel does not
    // silently disable scheduled Personal Jobs. Authenticated/multi-tenant
    // requests always dispatch through their explicit scoped API call instead.
    if ((yield* Database.CurrentPrincipal) === undefined) {
      yield* Effect.sleep("15 seconds").pipe(
        Effect.andThen(dispatchDueWith({ jobs, execute }, { limit: 8 })),
        Effect.catchCause((cause) => Effect.logWarning("Personal Job local dispatcher tick failed", { cause })),
        Effect.repeat(Schedule.spaced("15 seconds")),
        Effect.forkScoped({ startImmediately: true }),
      )
    }
    return service
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [Database.node, LocationServiceMap.node, PersonalJobV2.node, SessionV2.node],
})
