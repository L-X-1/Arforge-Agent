import { describe, expect, test } from "bun:test"
import { DateTime, Effect } from "effect"
import { Credential } from "@arforge-ai/schema/credential"
import { PersonalJob } from "@arforge-ai/schema/personal-job"
import { ScheduledPrompt } from "@arforge-ai/schema/scheduled-prompt"
import { SessionMessage } from "@arforge-ai/schema/session-message"
import { PrimaryDelivery } from "@arforge-ai/schema/primary-delivery"
import { Billing } from "@arforge-ai/schema/billing"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { ModelV2 } from "@arforge-ai/core/model"
import { ProviderV2 } from "@arforge-ai/core/provider"
import { SessionV2 } from "@arforge-ai/core/session"
import { OpaqueArtifact } from "@arforge-ai/core/runtime/artifact-ref"
import { canonicalHash } from "@arforge-ai/core/util/canonical-hash"
import {
  CredentialBindingUnavailableError,
  NotRunnableError,
  type JobRuntime,
  type SessionRuntime,
  dispatchDueWith,
  executeWith,
  interruptWith,
  launchWith,
} from "@arforge-ai/core/personal-job-executor"

const timestamp = DateTime.makeUnsafe(0)
const sessionID = SessionV2.ID.make("ses_personal_job_executor")
const jobID = PersonalJob.ID.make("pjob_personal_job_executor")

const makeJob = (overrides: Partial<PersonalJob.Info> = {}) =>
  PersonalJob.Info.make({
    id: jobID,
    sessionID,
    title: PersonalJob.Title.make("Executor test"),
    prompt: PersonalJob.Prompt.make("Run the test task"),
    status: "queued",
    visibility: { mode: "background", label: "后台自动", userVisible: true },
    schedule: {
      kind: "once",
      label: "one shot",
      nextRunAt: timestamp,
      timezone: "UTC",
    },
    credentialIDs: [],
    budget: {
      maxAttempts: 2,
      maxDurationMs: 60_000,
      maxCostMicros: 10_000,
      attemptsUsed: 0,
      durationMsUsed: 0,
      costMicrosUsed: 0,
    },
    approvalPolicy: { mode: "automatic", rationale: "test" },
    approvalState: "not_required",
    notificationPolicy: { mode: "none", events: [] },
    notifications: [],
    retention: {},
    admissionDigest: "a".repeat(64),
    lastError: "",
    revision: 1,
    time: { created: timestamp, updated: timestamp },
    ...overrides,
  })

const assistant = (text: string, delivery?: PrimaryDelivery.Metadata) =>
  SessionMessage.Assistant.make({
    id: SessionMessage.ID.make("msg_personal_job_executor_assistant"),
    type: "assistant",
    agent: "build",
    model: { id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.make("provider") },
    content: [SessionMessage.AssistantText.make({ type: "text", id: "text", text })],
    ...(delivery === undefined ? {} : { delivery }),
    time: { created: timestamp, completed: timestamp },
  })

const runtime = (
  initial: PersonalJob.Info,
  afterResume: ReadonlyArray<SessionMessage.Message>,
  onResume?: () => void,
  resumeEffect: Effect.Effect<void> = Effect.void,
  settlementCostMicros?: number,
) => {
  let current = initial
  let messages: SessionMessage.Message[] = []
  let promptCount = 0
  let resumeCount = 0
  let interrupted = false
  let recorded: PersonalJob.Result | undefined
  const jobs: JobRuntime = {
    get: () => Effect.succeed(current),
    start: () => {
      const messageID = SessionMessage.ID.make(`msg_personal_job_${current.id}_${current.revision + 1}`)
      const digest = canonicalHash({
        version: 1,
        jobID: current.id,
        sessionID: current.sessionID,
        prompt: current.prompt,
        messageID,
      })
      if (!digest) throw new Error("Fixture occurrence is not canonical")
      current = {
        ...current,
        status: "running",
        occurrence: current.occurrence ?? PersonalJob.Occurrence.make({ version: 1, messageID, digest }),
        revision: current.revision + 1,
        time: { ...current.time, started: timestamp, updated: timestamp },
        budget: { ...current.budget, attemptsUsed: current.budget.attemptsUsed + 1 },
      }
      return Effect.succeed(current)
    },
    recordResult: (input) => {
      recorded = { ...input.result, recordedAt: timestamp }
      current = {
        ...current,
        status: input.result.status,
        result: recorded,
        revision: current.revision + 1,
        time: { ...current.time, finished: timestamp, updated: timestamp },
      }
      return Effect.succeed(current)
    },
  }
  const sessions: SessionRuntime = {
    context: () => Effect.succeed(messages.slice()),
    prompt: () => {
      promptCount++
      return Effect.succeed(undefined as never)
    },
    resume: () => {
      resumeCount++
      onResume?.()
      messages = [...afterResume]
      return resumeEffect
    },
    interrupt: () => {
      interrupted = true
      return Effect.void
    },
    resumeWithCredentials: ({ billing }: { billing?: { onSettlement?: (input: any) => void } }) => {
      resumeCount++
      onResume?.()
      messages = [...afterResume]
      if (settlementCostMicros !== undefined) billing?.onSettlement?.({ costMicros: settlementCostMicros })
      return resumeEffect
    },
  }
  return {
    jobs,
    sessions,
    stop: (status: "paused" | "cancelled") => {
      current = { ...current, status, revision: current.revision + 1 }
    },
    get current() {
      return current
    },
    get promptCount() {
      return promptCount
    },
    get resumeCount() {
      return resumeCount
    },
    get interrupted() {
      return interrupted
    },
    get recorded() {
      return recorded
    },
  }
}

describe("PersonalJobExecutor", () => {
  test("preserves the job and returns an actionable billing rejection before starting", async () => {
    const initial = makeJob()
    const state = runtime(initial, [assistant("must not execute")])
    const reason = "No effective verified price catalog; configure current pricing and retry."
    const error = await Effect.runPromise(
      executeWith(
        {
          jobs: state.jobs,
          sessions: state.sessions,
          billing: () => Effect.fail(new NotRunnableError({ jobID, reason })),
        },
        { jobID, expectedRevision: initial.revision },
      ).pipe(Effect.flip),
    )
    expect(error).toBeInstanceOf(NotRunnableError)
    expect(error.message).toBe(reason)
    expect(state.current).toEqual(initial)
    expect(state.promptCount).toBe(0)
    expect(state.resumeCount).toBe(0)
  })

  test("executes a queued job through the session boundary and settles a durable result", async () => {
    const state = runtime(makeJob(), [assistant("Verified background result")])
    const result = await Effect.runPromise(
      executeWith({ jobs: state.jobs, sessions: state.sessions }, { jobID, expectedRevision: 1 }),
    )

    expect(state.promptCount).toBe(1)
    expect(state.resumeCount).toBe(1)
    expect(state.recorded?.status).toBe("completed")
    expect(state.recorded?.summary).toBe("Verified background result")
    expect(state.recorded?.digest).toMatch(/^[a-f0-9]{64}$/)
    expect(result.status).toBe("completed")
  })

  test("returns a running snapshot while detached execution settles in the background", async () => {
    const state = runtime(makeJob(), [assistant("Detached background result")], undefined, Effect.sleep("10 millis"))
    const active = new Map<PersonalJob.ID, PersonalJob.Info["sessionID"]>()
    const launched = await Effect.runPromise(
      launchWith({ jobs: state.jobs, sessions: state.sessions, active }, { jobID, expectedRevision: 1 }),
    )

    expect(launched.status).toBe("running")
    expect(active.get(jobID)).toBe(sessionID)
    await Effect.runPromise(Effect.sleep("30 millis"))
    expect(state.current.status).toBe("completed")
    expect(state.recorded?.summary).toBe("Detached background result")
    expect(active.has(jobID)).toBe(false)
  })

  test("rejects credential-bearing jobs before changing lifecycle state", async () => {
    const credentialID = Credential.ID.make("cred_personal_job_executor")
    const state = runtime(makeJob({ credentialIDs: [credentialID] }), [assistant("should not run")])
    const error = await Effect.runPromise(
      executeWith(
        { jobs: state.jobs, sessions: { ...state.sessions, resumeWithCredentials: undefined } },
        { jobID, expectedRevision: 1 },
      ).pipe(Effect.flip),
    )

    expect(error).toBeInstanceOf(CredentialBindingUnavailableError)
    expect(state.current.status).toBe("queued")
    expect(state.promptCount).toBe(0)
  })

  test("persists inspected primary-delivery attachments as durable artifact receipts", async () => {
    const sha256 = "b".repeat(64)
    const delivery = PrimaryDelivery.Metadata.make({
      status: "proactive",
      sentAt: timestamp,
      attachmentCount: 1,
      attachments: [
        PrimaryDelivery.Artifact.make({
          artifactID: `msg-${sha256.slice(0, 16)}`,
          path: "C:/workspace/report.md",
          displayName: "report.md",
          mime: "text/markdown",
          sizeBytes: 128,
          createdAt: timestamp,
          sha256,
          source: "user_message",
          isImage: false,
        }),
      ],
      localOnly: true,
      uploaded: false,
    })
    const state = runtime(makeJob(), [assistant("Verified report", delivery)])
    await Effect.runPromise(executeWith({ jobs: state.jobs, sessions: state.sessions }, { jobID, expectedRevision: 1 }))

    const artifactID = AgentRuntime.ArtifactID.make(`art_${sha256.slice(0, 32)}`)
    expect(state.recorded?.artifactRefs).toEqual([artifactID])
    expect(state.recorded?.artifacts).toMatchObject([
      {
        id: artifactID,
        kind: "primary_delivery",
        uri: "C:/workspace/report.md",
        name: "report.md",
        digest: sha256,
      },
    ])
  })

  test("carries a validated session-owned primary-delivery receipt into the durable result", async () => {
    const digest = "c".repeat(64)
    const artifactRef = OpaqueArtifact.make({
      version: 1,
      kind: "primary_delivery",
      digest,
      mime: "text/markdown",
      sizeBytes: 128,
      owner: { scope: "session", id: sessionID },
      retention: { mode: "session" },
      retrievalHint: { kind: "managed", handle: "artifact_personal_job" },
      createdAt: timestamp,
    })
    const delivery = PrimaryDelivery.Metadata.make({
      status: "normal",
      sentAt: timestamp,
      attachmentCount: 1,
      attachments: [
        PrimaryDelivery.Artifact.make({
          artifactID: `msg-${digest.slice(0, 16)}`,
          artifactRef,
          path: "C:/workspace/receipt.md",
          displayName: "receipt.md",
          mime: "text/markdown",
          sizeBytes: 128,
          createdAt: timestamp,
          sha256: digest,
          source: "user_message",
          isImage: false,
        }),
      ],
      localOnly: true,
      uploaded: false,
    })
    const state = runtime(makeJob(), [assistant("Receipt result", delivery)])
    await Effect.runPromise(executeWith({ jobs: state.jobs, sessions: state.sessions }, { jobID, expectedRevision: 1 }))

    expect(state.recorded?.artifactRefs).toEqual([artifactRef.artifactID])
    expect(state.recorded?.artifacts).toMatchObject([
      {
        id: artifactRef.artifactID,
        artifactRef,
        kind: "primary_delivery",
        digest,
      },
    ])
  })

  test("settles a failed result when the runner produces no assistant message", async () => {
    const state = runtime(makeJob(), [])
    const result = await Effect.runPromise(
      executeWith({ jobs: state.jobs, sessions: state.sessions }, { jobID, expectedRevision: 1 }),
    )

    expect(result.status).toBe("failed")
    expect(state.recorded?.status).toBe("failed")
    expect(state.recorded?.summary).toContain("No assistant result")
  })

  test("closes the job as failed when actual settled cost exceeds its budget", async () => {
    const state = runtime(makeJob(), [assistant("Provider result")], undefined, Effect.void, 20_000)
    const result = await Effect.runPromise(
      executeWith(
        {
          jobs: state.jobs,
          sessions: state.sessions,
          billing: ({ onSettlement }) =>
            Effect.succeed({
              budget: Billing.Budget.make({ currency: "USD", limitMinor: 10 }),
              resolveCatalog: () => undefined,
              onSettlement,
            }),
        },
        { jobID, expectedRevision: 1 },
      ),
    )

    expect(result.status).toBe("failed")
    expect(state.recorded?.status).toBe("failed")
    expect(state.recorded?.summary).toContain("cost budget")
    expect(state.recorded?.usage.costMicros).toBe(20_000)
  })

  test("does not resurrect a job paused while the runner was in flight", async () => {
    let state: ReturnType<typeof runtime>
    state = runtime(makeJob(), [assistant("late result")], () => state.stop("paused"))
    const result = await Effect.runPromise(
      executeWith({ jobs: state.jobs, sessions: state.sessions }, { jobID, expectedRevision: 1 }),
    )

    expect(result.status).toBe("paused")
    expect(state.recorded).toBeUndefined()
    expect(state.current.status).toBe("paused")
  })

  test("interrupts a runner that exceeds the remaining duration budget", async () => {
    const job = makeJob()
    const state = runtime({ ...job, budget: { ...job.budget, maxDurationMs: 1 } }, [], undefined, Effect.never)
    const result = await Effect.runPromise(
      executeWith({ jobs: state.jobs, sessions: state.sessions }, { jobID, expectedRevision: 1 }),
    )

    expect(result.status).toBe("failed")
    expect(state.recorded?.status).toBe("failed")
    expect(state.recorded?.summary).toContain("duration budget")
    expect(state.current.status).toBe("failed")
    expect(state.interrupted).toBe(true)
  })

  test("interrupts only the active session bound to the matching job", async () => {
    const state = runtime(makeJob(), [])
    const active = new Map([[jobID, sessionID]])

    await Effect.runPromise(
      interruptWith(
        { sessions: state.sessions, active },
        { jobID, sessionID: SessionV2.ID.make("ses_personal_job_executor") },
      ),
    )
    expect(state.interrupted).toBe(true)

    const other = runtime(makeJob({ id: PersonalJob.ID.make("pjob_interrupt_other") }), [])
    await Effect.runPromise(
      interruptWith({ sessions: other.sessions, active }, { jobID, sessionID: SessionV2.ID.make("ses_other_session") }),
    )
    expect(other.interrupted).toBe(false)
  })

  test("dispatches only due jobs after advancing recurring schedules", async () => {
    const first = makeJob({ id: PersonalJob.ID.make("pjob_dispatch_first") })
    const second = makeJob({ id: PersonalJob.ID.make("pjob_dispatch_second") })
    const calls: string[] = []
    const result = await Effect.runPromise(
      dispatchDueWith(
        {
          jobs: {
            tick: () => Effect.succeed(1),
            list: () => Effect.succeed([first, second]),
          },
          execute: ({ jobID }) => {
            calls.push(jobID)
            const job = jobID === first.id ? first : second
            return Effect.succeed({ ...job, status: jobID === first.id ? ("completed" as const) : ("failed" as const) })
          },
        },
        { now: 1, limit: 2, sessionID },
      ),
    )

    expect(result).toEqual({ recovered: 0, advanced: 1, attempted: 2, completed: 1, failed: 1, skipped: 0 })
    expect(calls).toEqual([first.id, second.id])
  })

  test("keeps non-runnable dispatches fail-closed and reports them as skipped", async () => {
    const job = makeJob({ id: PersonalJob.ID.make("pjob_dispatch_skipped") })
    const result = await Effect.runPromise(
      dispatchDueWith(
        {
          jobs: {
            tick: () => Effect.succeed(0),
            list: () => Effect.succeed([job]),
          },
          execute: () =>
            Effect.fail(
              new CredentialBindingUnavailableError({
                jobID: job.id,
                credentialIDs: [Credential.ID.make("cred_dispatch_skipped")],
              }),
            ),
        },
        { now: 1 },
      ),
    )

    expect(result).toEqual({ recovered: 0, advanced: 0, attempted: 1, completed: 0, failed: 0, skipped: 1 })
  })

  test("counts a detached running dispatch as admitted rather than skipped", async () => {
    const job = makeJob({ id: PersonalJob.ID.make("pjob_dispatch_running") })
    const result = await Effect.runPromise(
      dispatchDueWith(
        {
          jobs: {
            tick: () => Effect.succeed(0),
            list: () => Effect.succeed([job]),
          },
          execute: () => Effect.succeed({ ...job, status: "running" as const }),
        },
        { now: 1 },
      ),
    )

    expect(result).toEqual({ recovered: 0, advanced: 0, attempted: 1, completed: 0, failed: 0, skipped: 0 })
  })

  test("executes the recurring occurrence that tick just advanced", async () => {
    const recurring = makeJob({
      id: PersonalJob.ID.make("pjob_dispatch_recurring"),
      status: "completed",
      time: { created: timestamp, updated: timestamp, started: timestamp, finished: timestamp },
      schedule: {
        kind: "cron",
        label: "recurring",
        cron: ScheduledPrompt.Cron.make("* * * * *"),
        nextRunAt: timestamp,
        timezone: "UTC",
      },
    })
    let current = recurring
    const queued = {
      ...recurring,
      status: "queued" as const,
      revision: recurring.revision + 1,
      schedule: { ...recurring.schedule, nextRunAt: DateTime.makeUnsafe(60_000) },
    }
    const result = await Effect.runPromise(
      dispatchDueWith(
        {
          jobs: {
            list: () => Effect.succeed([current]),
            tick: () => {
              current = queued
              return Effect.succeed(1)
            },
          },
          execute: ({ jobID }) => Effect.succeed({ ...current, id: jobID, status: "completed" as const }),
        },
        { now: 1, limit: 1, sessionID },
      ),
    )

    expect(result).toEqual({ recovered: 0, advanced: 1, attempted: 1, completed: 1, failed: 0, skipped: 0 })
  })
})
