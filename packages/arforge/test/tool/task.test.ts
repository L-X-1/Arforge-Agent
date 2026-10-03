import { afterEach, describe, expect } from "bun:test"
import { SessionV1 } from "@arforge-ai/core/v1/session"
import { Database } from "@arforge-ai/core/database/database"
import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { AppNodeBuilder } from "@arforge-ai/core/effect/app-node-builder"
import { SessionProjector } from "@arforge-ai/core/session/projector"
import { DurableRun } from "@arforge-ai/core/runtime/durable-run"
import { AbsolutePath } from "@arforge-ai/core/schema"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { ProjectID } from "@arforge-ai/schema/project-id"
import { Cause, DateTime, Deferred, Effect, Exit, Fiber } from "effect"
import { Agent } from "../../src/agent/agent"
import { BackgroundJob } from "@/background/job"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Config } from "@/config/config"
import { CrossSpawnSpawner } from "@arforge-ai/core/cross-spawn-spawner"
import { Ripgrep } from "@arforge-ai/core/ripgrep"
import { Session } from "@/session/session"
import type { SessionPrompt } from "../../src/session/prompt"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionStatus } from "@/session/status"
import { Permission } from "@/permission"

import { boundChildBudgetForCustomAgent, TaskRuntime, TaskTool, type TaskPromptOps } from "../../src/tool/task"
import { Truncate } from "@/tool/truncate"
import { ToolRegistry } from "@/tool/registry"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { ProviderV2 } from "@arforge-ai/core/provider"
import { ModelV2 } from "@arforge-ai/core/model"
import { SubagentProvider } from "@arforge-ai/core/runtime/subagent-provider"
import { SubagentChildExecutor } from "@arforge-ai/core/runtime/subagent-child-executor"

afterEach(async () => {
  await disposeAllInstances()
})

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

const layer = (flags: Partial<RuntimeFlags.Info> = {}) =>
  AppNodeBuilder.build(
    LayerNode.group([
      Agent.node,
      BackgroundJob.node,
      EventV2Bridge.node,
      Config.node,
      CrossSpawnSpawner.node,
      Session.node,
      SessionProjector.node,
      SessionStatus.node,
      DurableRun.node,
      SubagentProvider.node,
      SubagentChildExecutor.node,
      Truncate.node,
      ToolRegistry.node,
      Database.node,
      RuntimeFlags.node,
      Ripgrep.node,
    ]),
    [[RuntimeFlags.node, RuntimeFlags.layer(flags)]],
  )

const it = testEffect(layer())
const background = testEffect(layer({ experimentalBackgroundSubagents: true }))

function defer<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const seed = Effect.fn("TaskToolTest.seed")(function* (title = "Pinned") {
  const session = yield* Session.Service
  const chat = yield* session.create({ title })
  const user = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID: chat.id,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  const assistant: SessionV1.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    parentID: user.id,
    sessionID: chat.id,
    mode: "build",
    agent: "build",
    cost: 0,
    path: { cwd: "/tmp", root: "/tmp" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    variant: "xhigh",
    time: { created: Date.now() },
  }
  yield* session.updateMessage(assistant)
  return { chat, assistant }
})

function stubOps(opts?: { onPrompt?: (input: SessionPrompt.PromptInput) => void; text?: string }): TaskPromptOps {
  return {
    cancel: () => Effect.void,
    resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
    prompt: (input) =>
      Effect.sync(() => {
        opts?.onPrompt?.(input)
        return reply(input, opts?.text ?? "done")
      }),
  }
}

function reply(input: SessionPrompt.PromptInput, text: string): SessionV1.WithParts {
  const id = MessageID.ascending()
  return {
    info: {
      id,
      role: "assistant",
      parentID: input.messageID ?? MessageID.ascending(),
      sessionID: input.sessionID,
      mode: input.agent ?? "general",
      agent: input.agent ?? "general",
      cost: 0,
      path: { cwd: "/tmp", root: "/tmp" },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: input.model?.modelID ?? ref.modelID,
      providerID: input.model?.providerID ?? ref.providerID,
      time: { created: Date.now() },
      finish: "stop",
    },
    parts: [
      {
        id: PartID.ascending(),
        messageID: id,
        sessionID: input.sessionID,
        type: "text",
        text,
      },
    ],
  }
}

describe("tool.task", () => {
  it.effect("caps a durable child budget to the admitted custom profile limits", () =>
    Effect.sync(() => {
      const bounded = boundChildBudgetForCustomAgent(
        AgentRuntime.Budget.make({
          maxAttempts: 2,
          maxDurationMs: 15 * 60 * 1_000,
          maxCostMicros: 1_000_000,
          maxTokens: 250_000,
          attemptsUsed: 0,
          durationMsUsed: 0,
          costMicrosUsed: 0,
          tokensUsed: 0,
        }),
        {
          schema_version: 1,
          provider: "in-process",
          role: "CustomAgent.reviewer",
          profile_path: "C:/workspace/.arforge/agents/reviewer.json",
          descriptor_digest: "a".repeat(64),
          declared_tools: ["read_file"],
          canonical_tools: ["read"],
          capabilities: ["code_review"],
          max_steps: 8,
          max_tokens: 4_096,
          timeout_seconds: 45,
        },
      )
      expect(bounded.maxAttempts).toBe(2)
      expect(bounded.maxDurationMs).toBe(45_000)
      expect(bounded.maxCostMicros).toBe(1_000_000)
      expect(bounded.maxTokens).toBe(4_096)
    }),
  )

  it.instance(
    "description sorts subagents by name and is stable across calls",
    () =>
      Effect.gen(function* () {
        const agent = yield* Agent.Service
        const build = yield* agent.get("build")
        const registry = yield* ToolRegistry.Service
        const get = Effect.fnUntraced(function* () {
          const tools = yield* registry.tools({ ...ref, agent: build })
          return tools.find((tool) => tool.id === TaskTool.id)?.description ?? ""
        })
        const first = yield* get()
        const second = yield* get()

        expect(first).toBe(second)

        const alpha = first.indexOf("- alpha: Alpha agent")
        const explore = first.indexOf("- explore:")
        const general = first.indexOf("- general:")
        const zebra = first.indexOf("- zebra: Zebra agent")

        expect(alpha).toBeGreaterThan(-1)
        expect(explore).toBeGreaterThan(alpha)
        expect(general).toBeGreaterThan(explore)
        expect(zebra).toBeGreaterThan(general)
      }),
    {
      config: {
        agent: {
          zebra: {
            description: "Zebra agent",
            mode: "subagent",
          },
          alpha: {
            description: "Alpha agent",
            mode: "subagent",
          },
        },
      },
    },
  )

  it.instance(
    "description hides denied subagents for the caller",
    () =>
      Effect.gen(function* () {
        const agent = yield* Agent.Service
        const build = yield* agent.get("build")
        const registry = yield* ToolRegistry.Service
        const description =
          (yield* registry.tools({ ...ref, agent: build })).find((tool) => tool.id === TaskTool.id)?.description ?? ""

        expect(description).toContain("- alpha: Alpha agent")
        expect(description).not.toContain("- zebra: Zebra agent")
      }),
    {
      config: {
        permission: {
          task: {
            "*": "allow",
            zebra: "deny",
          },
        },
        agent: {
          zebra: {
            description: "Zebra agent",
            mode: "subagent",
          },
          alpha: {
            description: "Alpha agent",
            mode: "subagent",
          },
        },
      },
    },
  )

  it.instance("execute resumes an existing task session from task_id", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const child = yield* sessions.create({
        parentID: chat.id,
        title: "Existing child",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let seen: SessionPrompt.PromptInput | undefined
      const promptOps = stubOps({ text: "resumed", onPrompt: (input) => (seen = input) })

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          task_id: child.id,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const kids = yield* sessions.children(chat.id)
      expect(kids).toHaveLength(1)
      expect(kids[0]?.id).toBe(child.id)
      expect(result.metadata.sessionId).toBe(child.id)
      expect(result.metadata.reasoningLevel).toBe("max")
      expect(result.metadata).not.toHaveProperty("maxParallelSubagents")
      expect(result.output).toContain(`<task id="${child.id}" state="completed">`)
      expect(seen?.sessionID).toBe(child.id)
      expect(seen?.variant).toBe("xhigh")
      const resumed = yield* sessions.get(child.id)
      expect(resumed.permission).not.toContainEqual({ permission: "*", pattern: "*", action: "allow" })
      expect(Permission.evaluate("read", "src/a.ts", resumed.permission ?? []).action).toBe("allow")
      expect(Permission.evaluate("edit", "src/a.ts", resumed.permission ?? []).action).toBe("deny")
      expect(Permission.evaluate("bash", "git status", resumed.permission ?? []).action).toBe("deny")

      yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          task_id: child.id,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )
      expect((yield* sessions.get(child.id)).permission).toEqual(resumed.permission)
    }),
  )

  for (const target of ["parent", "foreign-child"] as const)
    it.instance(`rejects followup to ${target} before mutating its session`, () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const { chat, assistant } = yield* seed()
        const foreign = yield* sessions.create({ title: "Other owner" })
        const victim =
          target === "parent"
            ? chat
            : yield* sessions.create({
                parentID: foreign.id,
                title: "Other child",
                permission: [{ permission: "*", pattern: "*", action: "allow" }],
              })
        const before = yield* sessions.get(victim.id)
        const def = yield* (yield* TaskTool).init()
        let prompts = 0
        const result = yield* def
          .execute(
            {
              description: "followup",
              prompt: "continue",
              subagent_type: "general",
              task_id: victim.id,
            },
            {
              sessionID: chat.id,
              messageID: assistant.id,
              agent: "build",
              abort: new AbortController().signal,
              extra: {
                promptOps: stubOps({
                  text: "unexpected",
                  onPrompt: () => {
                    prompts++
                  },
                }),
              },
              messages: [],
              metadata: () => Effect.void,
              ask: () => Effect.void,
            },
          )
          .pipe(Effect.exit)
        expect(Exit.isFailure(result)).toBe(true)
        expect(prompts).toBe(0)
        expect(yield* sessions.get(victim.id)).toEqual(before)
        expect(yield* sessions.children(chat.id)).toHaveLength(0)
      }),
    )

  it.instance("executes a TaskTool delegation as a durable child run", () =>
    Effect.gen(function* () {
      const durableRuns = yield* DurableRun.Service
      const subagentProvider = yield* SubagentProvider.Service
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed("Durable parent")
      const parent = yield* durableRuns.create({
        sessionID: chat.id,
        initiator: "agent",
        authority: "automatic",
        riskTier: "L1",
        reasonSummary: "task vertical integration parent",
        budget: AgentRuntime.Budget.make({
          maxAttempts: 3,
          maxDurationMs: 30 * 60 * 1_000,
          maxCostMicros: 3_000_000,
          maxTokens: 1_000_000,
          attemptsUsed: 0,
          durationMsUsed: 0,
          costMicrosUsed: 0,
          tokensUsed: 0,
        }),
        traceID: "task-parent",
        visibility: "details",
        project: ProjectID.global,
        location: AbsolutePath.make(chat.directory),
        delegableCapabilities: [{ action: "*", resources: ["*"], access: "read" }],
      })
      yield* durableRuns.transition({ runID: parent.run.id, to: "preflight", reason: "task parent preflight" })
      yield* durableRuns.transition({ runID: parent.run.id, to: "queued", reason: "task parent queued" })
      yield* durableRuns.transition({ runID: parent.run.id, to: "running", reason: "task parent running" })

      const tool = yield* TaskTool
      const def = yield* tool.init()
      let seen: SessionPrompt.PromptInput | undefined
      const requests: unknown[] = []
      let observedChildCost = 0.25
      const promptOps: TaskPromptOps = {
        ...stubOps({ text: "child result", onPrompt: (input) => (seen = input) }),
        prompt: (input) =>
          Effect.gen(function* () {
            seen = input
            const result = reply(input, "child result")
            const info = {
              ...result.info,
              cost: observedChildCost,
              tokens: { input: 2, output: 3, reasoning: 0, cache: { read: 0, write: 0 } },
            }
            yield* sessions.updateMessage(info)
            yield* sessions.updatePart({
              id: PartID.ascending(),
              messageID: result.info.id,
              sessionID: input.sessionID,
              type: "step-finish",
              reason: "stop",
              cost: observedChildCost,
              tokens: { input: 2, output: 3, reasoning: 0, cache: { read: 0, write: 0 } },
            })
            return { ...result, info }
          }),
      }
      const result = yield* def.execute(
        {
          description: "delegate inspection",
          prompt: "inspect the durable child contract",
          subagent_type: "general",
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          callID: "call_task_durable_child",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: (input) => Effect.sync(() => requests.push(input)),
          parentAction: {
            actionID: AgentRuntime.ActionID.make("act_task_durable_parent"),
            runID: parent.run.id,
          },
        },
      )

      const children = yield* durableRuns.listChildren({ parentRunID: parent.run.id, includeTerminal: true })
      const child = children[0]
      expect(child?.run.status).toBe("completed")
      expect(child?.run.childResult?.summary).toBe("child result")
      expect(child?.run.child?.parentRunID).toBe(parent.run.id)
      expect(seen?.runID).toBe(child?.run.id)
      expect(result.output).toContain(`state="completed"`)
      expect(child?.run.budget.maxTokens).toBe(250_000)
      expect(requests[0]).toMatchObject({
        permission: "task",
        metadata: {
          budget_mode: "durable",
          budget: {
            maxAttempts: 2,
            maxDurationMs: 15 * 60 * 1_000,
            maxCostMicros: 1_000_000,
            maxTokens: 250_000,
          },
        },
      })
      expect(child?.run.budget.costMicrosUsed).toBe(250_000)
      expect(child?.run.budget.tokensUsed).toBe(5)
      expect(child?.run.childResult?.usage.costMicros).toBe(250_000)
      expect(child?.run.childResult?.usage.tokens).toBe(5)
      const providerProjection = yield* subagentProvider.inspect({
        executionID: child!.run.id,
        provider: "in-process",
      })
      expect(providerProjection).toMatchObject({
        executionID: child!.run.id,
        epoch: 1,
        phase: "completed",
        active: false,
        nextSequence: 2,
        continuation: { nextSequence: 2 },
      })
      const checkpointContinuation = child?.checkpoint?.state[SubagentProvider.CONTINUATION_CHECKPOINT_KEY]
      expect(checkpointContinuation).toMatchObject({
        schemaVersion: 1,
        provider: "in-process",
        executionID: child!.run.id,
        epoch: 1,
        nextSequence: 2,
      })
      expect(JSON.stringify(checkpointContinuation)).not.toContain("child result")

      const replayContext = {
        sessionID: chat.id,
        messageID: assistant.id,
        agent: "build",
        callID: "call_task_durable_child",
        abort: new AbortController().signal,
        extra: { promptOps: { ...promptOps, prompt: () => Effect.die("terminal replay must not prompt") } },
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.void,
        parentAction: {
          actionID: AgentRuntime.ActionID.make("act_task_durable_parent"),
          runID: parent.run.id,
        },
      }
      const replayParameters = {
        description: "delegate inspection",
        prompt: "inspect the durable child contract",
        subagent_type: "general",
      }
      const replayed = yield* def.execute(replayParameters, replayContext)
      expect(replayed.metadata.sessionId).toBe(result.metadata.sessionId)
      expect(replayed.output).toContain("child result")
      expect(yield* sessions.children(chat.id)).toHaveLength(1)
      expect(yield* durableRuns.load(child!.run.id)).toEqual(child)

      for (const mismatch of ["prompt", "action", "message"] as const) {
        const rejected = yield* def
          .execute(mismatch === "prompt" ? { ...replayParameters, prompt: "different objective" } : replayParameters, {
            ...replayContext,
            ...(mismatch === "action"
              ? { parentAction: { ...replayContext.parentAction, actionID: AgentRuntime.ActionID.make("act_other") } }
              : {}),
            ...(mismatch === "message" ? { messageID: MessageID.ascending() } : {}),
          })
          .pipe(Effect.exit)
        expect(Exit.isFailure(rejected)).toBe(true)
        expect(yield* sessions.children(chat.id)).toHaveLength(1)
        expect(yield* durableRuns.load(child!.run.id)).toEqual(child)
      }

      const originalSession = yield* sessions.get(result.metadata.sessionId)
      yield* sessions.setPermission({
        sessionID: originalSession.id,
        permission: [{ permission: "*", pattern: "*", action: "deny" }],
      })
      const restricted = yield* sessions.get(originalSession.id)
      expect(Exit.isFailure(yield* def.execute(replayParameters, replayContext).pipe(Effect.exit))).toBe(true)
      expect(yield* sessions.get(originalSession.id)).toEqual(restricted)
      yield* sessions.setPermission({ sessionID: originalSession.id, permission: originalSession.permission ?? [] })
      yield* sessions.setSandboxProfile({ sessionID: originalSession.id, profile: "read-only" })
      const changedSandbox = yield* sessions.get(originalSession.id)
      expect(Exit.isFailure(yield* def.execute(replayParameters, replayContext).pipe(Effect.exit))).toBe(true)
      expect(yield* sessions.get(originalSession.id)).toEqual(changedSandbox)
      yield* sessions.setSandboxProfile({ sessionID: originalSession.id, profile: "workspace-write" })
      yield* durableRuns.checkpoint({
        runID: child!.run.id,
        state: { ...child!.checkpoint!.state, taskRecovery: null },
      })
      expect(Exit.isFailure(yield* def.execute(replayParameters, replayContext).pipe(Effect.exit))).toBe(true)
      expect(yield* sessions.children(chat.id)).toHaveLength(1)
      yield* durableRuns.checkpoint({ runID: child!.run.id, state: child!.checkpoint!.state })

      yield* def.execute(
        {
          description: "delegate follow-up",
          prompt: "inspect a second bounded child",
          subagent_type: "general",
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          callID: "call_task_durable_child_2",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
          parentAction: {
            actionID: AgentRuntime.ActionID.make("act_task_durable_parent_2"),
            runID: parent.run.id,
          },
        },
      )

      const parentAfter = (yield* durableRuns.load(parent.run.id)).run as AgentRuntime.SessionRun
      expect(parentAfter.budget).toMatchObject({ attemptsUsed: 2, costMicrosUsed: 500_000, tokensUsed: 10 })
      expect(parentAfter.childBudgetReserved).toEqual({
        attempts: 0,
        durationMs: 0,
        costMicros: 0,
        tokens: 0,
      })
      expect(yield* durableRuns.listChildren({ parentRunID: parent.run.id, includeTerminal: true })).toHaveLength(2)

      observedChildCost = 1.25
      const overBudget = yield* def
        .execute(
          {
            description: "delegate over-budget probe",
            prompt: "prove post-provider cost settlement fails closed",
            subagent_type: "general",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            callID: "call_task_durable_child_over_budget",
            abort: new AbortController().signal,
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
            parentAction: {
              actionID: AgentRuntime.ActionID.make("act_task_durable_parent_over_budget"),
              runID: parent.run.id,
            },
          },
        )
        .pipe(Effect.exit)
      expect(Exit.isFailure(overBudget)).toBe(true)
      expect(String(overBudget)).toContain("Child provider usage exceeded its durable budget")
      const afterOverBudget = (yield* durableRuns.load(parent.run.id)).run as AgentRuntime.SessionRun
      expect(afterOverBudget.budget).toMatchObject({ attemptsUsed: 3, costMicrosUsed: 1_500_000, tokensUsed: 15 })
      expect(afterOverBudget.childBudgetReserved).toEqual({
        attempts: 0,
        durationMs: 0,
        costMicros: 0,
        tokens: 0,
      })
      const failedChild = (yield* durableRuns.listChildren({ parentRunID: parent.run.id, includeTerminal: true })).find(
        (candidate) => candidate.run.status === "failed",
      )
      expect(failedChild?.run.childResult?.summary).toContain("observed 1250000 cost micros")
    }),
  )

  it.instance("recovers a frozen child contract and settles usage from the interrupted attempt", () =>
    Effect.gen(function* () {
      const durableRuns = yield* DurableRun.Service
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed("Recoverable durable parent")
      const parent = yield* durableRuns.create({
        sessionID: chat.id,
        initiator: "agent",
        authority: "automatic",
        riskTier: "L1",
        reasonSummary: "task recovery parent",
        budget: AgentRuntime.Budget.make({
          maxAttempts: 3,
          maxDurationMs: 30 * 60 * 1_000,
          maxCostMicros: 3_000_000,
          maxTokens: 1_000_000,
          attemptsUsed: 0,
          durationMsUsed: 0,
          costMicrosUsed: 0,
          tokensUsed: 0,
        }),
        traceID: "task-recovery-parent",
        visibility: "details",
        project: ProjectID.global,
        location: AbsolutePath.make(chat.directory),
        delegableCapabilities: [{ action: "*", resources: ["*"], access: "read" }],
      })
      yield* durableRuns.transition({ runID: parent.run.id, to: "preflight", reason: "parent preflight" })
      yield* durableRuns.transition({ runID: parent.run.id, to: "queued", reason: "parent queued" })
      yield* durableRuns.transition({ runID: parent.run.id, to: "running", reason: "parent running" })

      const childSession = yield* sessions.create({
        parentID: chat.id,
        title: "Recover delegated inspection (@general subagent)",
        agent: "general",
      })
      const callID = "call_task_recover_frozen_child"
      const now = yield* DateTime.now
      const child = yield* durableRuns.createChild({
        parentRunID: parent.run.id,
        sessionID: childSession.id,
        idempotencyKey: callID,
        delegatedObjective: "resume durable child",
        allowedCapabilities: [{ action: "*", resources: ["*"], access: "read" }],
        project: ProjectID.global,
        location: AbsolutePath.make(chat.directory),
        expectedDeliverable: {
          summaryRequired: true,
          artifactKinds: [],
          evidenceKinds: [],
          verifier: "parent-run",
        },
        deadlineAt: DateTime.makeUnsafe(DateTime.toEpochMillis(now) + 15 * 60 * 1_000),
        initiator: "agent",
        authority: "automatic",
        riskTier: "L0",
        reasonSummary: "Task tool delegation: Recover delegated inspection",
        budget: AgentRuntime.Budget.make({
          maxAttempts: 2,
          maxDurationMs: 15 * 60 * 1_000,
          maxCostMicros: 1_000_000,
          maxTokens: 250_000,
          attemptsUsed: 0,
          durationMsUsed: 0,
          costMicrosUsed: 0,
          tokensUsed: 0,
        }),
        traceID: `${callID}:child`,
        parentTraceID: parent.run.id,
        visibility: "details",
      })
      yield* durableRuns.transition({ runID: child.run.id, to: "preflight", reason: "child preflight" })
      yield* durableRuns.transition({ runID: child.run.id, to: "queued", reason: "child queued" })
      yield* durableRuns.transition({ runID: child.run.id, to: "running", reason: "crashed child running" })
      yield* durableRuns.beginAttempt({
        runID: child.run.id,
        usageBaseline: AgentRuntime.RunUsageBaseline.make({ costMicros: 0, tokens: 0 }),
      })

      const crashed = reply(
        {
          sessionID: childSession.id,
          runID: child.run.id,
          agent: "general",
          model: ref,
          parts: [{ type: "text", text: "resume durable child" }],
        },
        "partial",
      )
      const crashedInfo = {
        ...crashed.info,
        cost: 0.1,
        tokens: { input: 3, output: 4, reasoning: 0, cache: { read: 0, write: 0 } },
      }
      yield* sessions.updateMessage(crashedInfo)
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: crashed.info.id,
        sessionID: childSession.id,
        type: "step-finish",
        reason: "stop",
        cost: 0.1,
        tokens: crashedInfo.tokens,
      })

      const promptOps: TaskPromptOps = {
        ...stubOps(),
        prompt: (input) =>
          Effect.gen(function* () {
            const result = reply(input, "recovered child result")
            const info = {
              ...result.info,
              cost: 0.25,
              tokens: { input: 2, output: 3, reasoning: 0, cache: { read: 0, write: 0 } },
            }
            yield* sessions.updateMessage(info)
            yield* sessions.updatePart({
              id: PartID.ascending(),
              messageID: info.id,
              sessionID: input.sessionID,
              type: "step-finish",
              reason: "stop",
              cost: info.cost,
              tokens: info.tokens,
            })
            return { ...result, info }
          }),
      }
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const result = yield* def.execute(
        {
          description: "Recover delegated inspection",
          prompt: "resume durable child",
          subagent_type: "general",
          task_id: childSession.id,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          callID,
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
          parentAction: {
            actionID: AgentRuntime.ActionID.make("act_task_recover_frozen_child"),
            runID: parent.run.id,
          },
        },
      )

      expect(result.output).toContain("recovered child result")
      const recovered = (yield* durableRuns.load(child.run.id)) as DurableRun.ChildSnapshot
      expect(recovered.run.status).toBe("completed")
      expect(recovered.run.budget).toMatchObject({ attemptsUsed: 2, costMicrosUsed: 350_000, tokensUsed: 12 })
      expect(recovered.run.childResult?.usage).toMatchObject({ attempts: 2, costMicros: 350_000, tokens: 12 })
      expect(recovered.checkpoint?.state[SubagentProvider.CONTINUATION_CHECKPOINT_KEY]).toMatchObject({
        provider: "in-process",
        executionID: child.run.id,
        epoch: 2,
        nextSequence: 2,
      })
      const parentAfter = (yield* durableRuns.load(parent.run.id)).run as AgentRuntime.SessionRun
      expect(parentAfter.budget).toMatchObject({ attemptsUsed: 2, costMicrosUsed: 350_000, tokensUsed: 12 })
      expect(parentAfter.childBudgetReserved).toEqual({
        attempts: 0,
        durationMs: 0,
        costMicros: 0,
        tokens: 0,
      })
    }),
  )

  it.instance("execute asks by default and skips checks when bypassed", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const calls: unknown[] = []
      const promptOps = stubOps()

      const exec = (extra?: Record<string, any>) =>
        def.execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps, ...extra },
            messages: [],
            metadata: () => Effect.void,
            ask: (input) =>
              Effect.sync(() => {
                calls.push(input)
              }),
          },
        )

      yield* exec()
      yield* exec({ bypassAgentCheck: true })

      expect(calls).toHaveLength(1)
      expect(calls[0]).toEqual({
        permission: "task",
        patterns: ["general"],
        always: ["*"],
        metadata: {
          description: "inspect bug",
          subagent_type: "general",
          capability_mode: "default-read-only",
          capabilities: [{ action: "*", resources: ["*"], access: "read" }],
          budget_mode: "legacy-unmetered",
        },
      })
    }),
  )

  it.instance("rejects an unbounded child capability contract before asking or creating a session", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const calls: unknown[] = []

      const exit = yield* def
        .execute(
          {
            description: "oversized delegation",
            prompt: "inspect the workspace",
            subagent_type: "general",
            capabilities: Array.from({ length: 65 }, (_, index) => ({
              action: `read-${index}`,
              resources: ["workspace"],
              access: "read" as const,
            })),
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps: stubOps() },
            messages: [],
            metadata: () => Effect.void,
            ask: (input) => Effect.sync(() => calls.push(input)),
          },
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      expect(String(exit)).toContain("bounded admission contract")
      expect(calls).toEqual([])
      expect(yield* sessions.children(chat.id)).toEqual([])

      const emptyScope = yield* def
        .execute(
          {
            description: "empty delegation",
            prompt: "inspect the workspace",
            subagent_type: "general",
            capabilities: [{ action: "read", resources: [], access: "read" }],
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps: stubOps() },
            messages: [],
            metadata: () => Effect.void,
            ask: (input) => Effect.sync(() => calls.push(input)),
          },
        )
        .pipe(Effect.exit)
      expect(String(emptyScope)).toContain("bounded admission contract")
      expect(calls).toEqual([])
      expect(yield* sessions.children(chat.id)).toEqual([])
    }),
  )

  it.instance("execute cancels child session when abort signal fires", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const ready = defer<SessionPrompt.PromptInput>()
      const cancelled = defer<SessionID>()
      const abort = new AbortController()
      const promptOps: TaskPromptOps = {
        cancel: (sessionID) =>
          Effect.sync(() => {
            cancelled.resolve(sessionID)
          }),
        resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
        prompt: (input) =>
          Effect.sync(() => {
            ready.resolve(input)
          }).pipe(Effect.andThen(Effect.never)),
      }

      const fiber = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: abort.signal,
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.forkChild)

      const input = yield* Effect.promise(() => ready.promise)
      abort.abort()
      expect(yield* Effect.promise(() => cancelled.promise)).toBe(input.sessionID)

      const exit = yield* Fiber.await(fiber)
      expect(Exit.isFailure(exit)).toBe(true)
    }),
  )

  for (const failure of ["defect", "interrupt"] as const)
    it.instance(`task continuation lookup preserves ${failure} without creating a replacement`, () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const { chat, assistant } = yield* seed()
        const target = SessionID.make("ses_unreadable")
        const problem = new Error("fixture session storage unavailable")
        let prompts = 0
        let metadata = 0
        const runtime = yield* TaskRuntime.pipe(
          Effect.provideService(Session.Service, {
            ...sessions,
            get: (id) =>
              id === target ? (failure === "defect" ? Effect.die(problem) : Effect.interrupt) : sessions.get(id),
          }),
        )
        const result = yield* runtime
          .execute(
            { description: "resume", prompt: "continue", subagent_type: "general", task_id: target },
            {
              sessionID: chat.id,
              messageID: assistant.id,
              agent: "build",
              abort: new AbortController().signal,
              promptOps: stubOps({ onPrompt: () => prompts++ }),
              metadata: () =>
                Effect.sync(() => {
                  metadata++
                }),
              ask: () => Effect.void,
            },
          )
          .pipe(Effect.exit)
        expect(Exit.isFailure(result)).toBe(true)
        if (failure === "interrupt") expect(Exit.hasInterrupts(result)).toBe(true)
        else if (Exit.isFailure(result)) expect(Cause.pretty(result.cause)).toContain(problem.message)
        expect(prompts).toBe(0)
        expect(metadata).toBe(0)
        expect(yield* sessions.children(chat.id)).toHaveLength(0)
      }),
    )

  it.instance("replays a frozen draft in the original session and model after admission interruption", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const runs = yield* DurableRun.Service
      const { chat, assistant } = yield* seed()
      const parent = yield* runs.create({
        sessionID: chat.id,
        initiator: "agent",
        authority: "automatic",
        riskTier: "L0",
        reasonSummary: "draft replay fixture",
        budget: AgentRuntime.Budget.make({
          maxAttempts: 3,
          maxDurationMs: 1_800_000,
          maxCostMicros: 3_000_000,
          maxTokens: 1_000_000,
          attemptsUsed: 0,
          durationMsUsed: 0,
          costMicrosUsed: 0,
          tokensUsed: 0,
        }),
        traceID: "draft-replay",
        visibility: "details",
        project: ProjectID.global,
        location: AbsolutePath.make(chat.directory),
        delegableCapabilities: [{ action: "*", resources: ["*"], access: "read" }],
      })
      for (const to of ["preflight", "queued", "running"] as const)
        yield* runs.transition({ runID: parent.run.id, to, reason: "fixture" })
      const runtime = yield* TaskRuntime
      const parameters = { description: "draft", prompt: "frozen prompt", subagent_type: "general" }
      let seen: SessionPrompt.PromptInput | undefined
      const context = {
        sessionID: chat.id,
        messageID: assistant.id,
        agent: "build",
        callID: "draft-replay-call",
        abort: new AbortController().signal,
        nativeParent: { modelID: "original-model", providerID: "test", variant: "high" },
        parentAction: { actionID: AgentRuntime.ActionID.make("act_draft_replay"), runID: parent.run.id },
        promptOps: stubOps({
          onPrompt: (input) => {
            seen = input
          },
        }),
        ask: () => Effect.void,
        metadata: () => Effect.die(new Error("fixture: admission stopped before queue start")),
      }
      expect(Exit.isFailure(yield* runtime.execute(parameters, context).pipe(Effect.exit))).toBe(true)
      const before = (yield* runs.listChildren({ parentRunID: parent.run.id }))[0]
      expect(before.run.status).toBe("draft")
      expect(before.run.budget.attemptsUsed).toBe(0)
      expect(seen).toBeUndefined()
      // A new semantic runtime instance receives a changed current route. This
      // is a draft replay test, not a process restart or scanner acceptance.
      const replacement = yield* TaskRuntime
      const result = yield* replacement.execute(parameters, {
        ...context,
        nativeParent: { modelID: "changed-model", providerID: "other", variant: "low" },
        metadata: () => Effect.void,
      })
      expect(result.metadata.sessionId).toBe(before.run.sessionID)
      expect(seen?.model).toEqual({
        modelID: ModelV2.ID.make("original-model"),
        providerID: ProviderV2.ID.make("test"),
      })
      expect(seen?.variant).toBe("high")
      expect(yield* sessions.children(chat.id)).toHaveLength(1)
      const after = yield* runs.load(before.run.id)
      expect(after.run.status).toBe("completed")
      expect(after.run.budget.attemptsUsed).toBe(1)
      expect(after.lease).toBeUndefined()
    }),
  )

  it.instance("execute creates a child when task_id does not exist", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let seen: SessionPrompt.PromptInput | undefined
      const promptOps = stubOps({ text: "created", onPrompt: (input) => (seen = input) })

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          task_id: "ses_missing",
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const kids = yield* sessions.children(chat.id)
      expect(kids).toHaveLength(1)
      expect(kids[0]?.id).toBe(result.metadata.sessionId)
      expect(result.metadata.sessionId).not.toBe("ses_missing")
      expect(result.output).toContain(`<task id="${result.metadata.sessionId}" state="completed">`)
      expect(seen?.sessionID).toBe(result.metadata.sessionId)
    }),
  )

  it.instance("prevents subagents from launching subagents by default", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const child = yield* sessions.create({ parentID: chat.id, title: "child" })
      const nestedAssistant = yield* sessions.updateMessage({
        ...assistant,
        id: MessageID.ascending(),
        parentID: MessageID.ascending(),
        sessionID: child.id,
      })
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let asked = false

      const exit = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
          },
          {
            sessionID: child.id,
            messageID: nestedAssistant.id,
            agent: "general",
            abort: new AbortController().signal,
            extra: { promptOps: stubOps() },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.sync(() => (asked = true)),
          },
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      expect(asked).toBe(false)
      expect(yield* sessions.children(child.id)).toHaveLength(0)
    }),
  )

  it.instance(
    "allows nested subagents up to the configured depth",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const { chat, assistant } = yield* seed()
        const child = yield* sessions.create({ parentID: chat.id, title: "child" })
        const nestedAssistant = yield* sessions.updateMessage({
          ...assistant,
          id: MessageID.ascending(),
          parentID: MessageID.ascending(),
          sessionID: child.id,
        })
        const tool = yield* TaskTool
        const def = yield* tool.init()

        const result = yield* def.execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
          },
          {
            sessionID: child.id,
            messageID: nestedAssistant.id,
            agent: "general",
            abort: new AbortController().signal,
            extra: { promptOps: stubOps() },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )

        expect((yield* sessions.get(result.metadata.sessionId)).parentID).toBe(child.id)
      }),
    { config: { subagent_depth: 2 } },
  )

  it.instance(
    "execute shapes child permissions for task, todowrite, and primary tools",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* tool.init()
        let seen: SessionPrompt.PromptInput | undefined
        const promptOps = stubOps({ onPrompt: (input) => (seen = input) })

        const result = yield* def.execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "reviewer",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )

        const child = yield* sessions.get(result.metadata.sessionId)
        expect(child.parentID).toBe(chat.id)
        expect(child.agent).toBe("reviewer")
        expect(child.permission?.[0]).toEqual({ permission: "*", pattern: "*", action: "deny" })
        expect(Permission.evaluate("grep", "src/a.ts", child.permission ?? []).action).toBe("allow")
        expect(Permission.evaluate("edit", "src/a.ts", child.permission ?? []).action).toBe("deny")
        expect(Permission.evaluate("task", "general", child.permission ?? []).action).toBe("deny")
        expect(Permission.evaluate("todowrite", "*", child.permission ?? []).action).toBe("deny")
        expect(Permission.evaluate("bash", "git status", child.permission ?? []).action).toBe("deny")
        // primary_tools remains a hard local policy even when the default
        // read-only contract would otherwise expose the read tool.
        expect(Permission.evaluate("read", "src/a.ts", child.permission ?? []).action).toBe("deny")
        expect(seen?.tools).toBeUndefined()
      }),
    {
      config: {
        agent: {
          reviewer: {
            mode: "subagent",
            permission: {
              task: "allow",
            },
          },
        },
        experimental: {
          primary_tools: ["bash", "read"],
        },
      },
    },
  )

  it.instance(
    "execute materializes only the explicitly delegated write capability",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* tool.init()
        const requests: unknown[] = []

        const result = yield* def.execute(
          {
            description: "edit one file",
            prompt: "update the requested file",
            subagent_type: "reviewer",
            capabilities: [{ action: "edit", resources: ["workspace"], access: "write" }],
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps: stubOps() },
            messages: [],
            metadata: () => Effect.void,
            ask: (input) => Effect.sync(() => requests.push(input)),
          },
        )

        const child = yield* sessions.get(result.metadata.sessionId)
        expect(requests[0]).toMatchObject({
          permission: "task",
          metadata: {
            capability_mode: "explicit",
            capabilities: [{ action: "edit", resources: ["workspace"], access: "write" }],
          },
        })
        expect(Permission.evaluate("edit", "src/a.ts", child.permission ?? []).action).toBe("allow")
        expect(Permission.evaluate("read", "src/a.ts", child.permission ?? []).action).toBe("deny")
        expect(Permission.evaluate("bash", "git status", child.permission ?? []).action).toBe("deny")
        expect(Permission.evaluate("task", "reviewer", child.permission ?? []).action).toBe("deny")
      }),
    {
      config: {
        agent: {
          reviewer: {
            mode: "subagent",
            permission: { "*": "allow" },
          },
        },
      },
    },
  )

  it.instance(
    "execute keeps a parent ask rule above an explicit child write capability",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* tool.init()

        const result = yield* def.execute(
          {
            description: "edit one file",
            prompt: "update the requested file",
            subagent_type: "reviewer",
            capabilities: [{ action: "edit", resources: ["workspace"], access: "write" }],
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps: stubOps() },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )

        const child = yield* sessions.get(result.metadata.sessionId)
        expect(Permission.evaluate("edit", "src/a.ts", child.permission ?? []).action).toBe("ask")
        expect(Permission.evaluate("bash", "git status", child.permission ?? []).action).toBe("deny")
      }),
    {
      config: {
        permission: { edit: "ask" },
        agent: {
          reviewer: {
            mode: "subagent",
            permission: { "*": "allow" },
          },
        },
      },
    },
  )

  it.instance("rejects background execution when the experiment is disabled", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const exit = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
            background: true,
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps: stubOps() },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
    }),
  )

  it.instance("promotes a running foreground task without restarting it", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const ready = yield* Deferred.make<void>()
      const done = yield* Deferred.make<void>()
      const injected = yield* Deferred.make<SessionPrompt.PromptInput>()
      let runs = 0
      const promptOps: TaskPromptOps = {
        cancel: () => Effect.void,
        resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
        prompt: (input) => {
          if (input.sessionID === chat.id) {
            return Deferred.succeed(injected, input).pipe(Effect.as(reply(input, "injected")))
          }
          return Effect.gen(function* () {
            runs += 1
            yield* Deferred.succeed(ready, undefined)
            yield* Deferred.await(done)
            return reply(input, "background done")
          })
        },
      }

      const fiber = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.forkChild)

      yield* Deferred.await(ready)
      const job = (yield* jobs.list())[0]
      expect(job).toBeDefined()
      if (!job) throw new Error("task job not found")
      expect(job.metadata?.parentSessionId).toBe(chat.id)
      yield* jobs.promote(job.id)

      const result = yield* Fiber.join(fiber)
      expect(result.metadata.background).toBe(true)
      expect(result.output).toContain(`state="running"`)
      expect((yield* jobs.get(result.metadata.sessionId))?.status).toBe("running")
      expect(runs).toBe(1)

      yield* Deferred.succeed(done, undefined)
      expect((yield* jobs.wait({ id: result.metadata.sessionId })).info?.output).toBe("background done")
      expect((yield* Deferred.await(injected)).parts[0]?.type).toBe("text")
      expect(runs).toBe(1)
    }),
  )

  background.instance("execute launches background tasks without waiting for completion", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps(),
              prompt: () => Effect.never,
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const job = yield* jobs.get(result.metadata.sessionId)
      expect(result.metadata.background).toBe(true)
      expect(result.output).toContain(`state="running"`)
      expect(job?.status).toBe("running")
    }),
  )

  background.instance("background task completion waits for running updates", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const first = defer<void>()
      const second = defer<void>()
      const updated = defer<SessionPrompt.PromptInput>()
      const injected = defer<SessionPrompt.PromptInput>()
      let prompts = 0
      const promptOps: TaskPromptOps = {
        ...stubOps(),
        prompt: (input) => {
          if (input.sessionID === chat.id) {
            injected.resolve(input)
            return Effect.succeed(reply(input, "done"))
          }
          prompts++
          if (prompts === 1) return Effect.promise(() => first.promise).pipe(Effect.as(reply(input, "first done")))
          updated.resolve(input)
          return Effect.promise(() => second.promise).pipe(Effect.as(reply(input, "second done")))
        },
      }
      const context = {
        sessionID: chat.id,
        messageID: assistant.id,
        agent: "build",
        abort: new AbortController().signal,
        extra: { promptOps },
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.void,
      }

      const started = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        context,
      )
      const result = yield* def.execute(
        {
          description: "add investigation scope",
          prompt: "also inspect cancellation",
          subagent_type: "general",
          task_id: started.metadata.sessionId,
        },
        context,
      )

      expect(result.metadata.sessionId).toBe(started.metadata.sessionId)
      expect(result.metadata.background).toBe(true)
      expect(result.output).toContain("Background task updated")
      first.resolve()
      expect((yield* jobs.get(started.metadata.sessionId))?.status).toBe("running")
      expect((yield* Effect.promise(() => updated.promise)).parts).toEqual([
        { type: "text", text: "also inspect cancellation" },
      ])

      second.resolve()
      const waited = yield* jobs.wait({ id: started.metadata.sessionId, timeout: 1_000 })
      expect(waited.info?.status).toBe("completed")
      expect(waited.info?.output).toBe("second done")
      const notification = yield* Effect.promise(() => injected.promise)
      expect(notification.variant).toBe("xhigh")
      expect(notification.parts[0]?.type).toBe("text")
      if (notification.parts[0]?.type === "text") expect(notification.parts[0].text).toContain("second done")
    }),
  )

  background.instance("background tasks complete through the background job service", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps: stubOps({ text: "background done" }) },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const waited = yield* jobs.wait({ id: result.metadata.sessionId, timeout: 1_000 })
      expect(waited.timedOut).toBe(false)
      expect(waited.info?.status).toBe("completed")
      expect(waited.info?.output).toBe("background done")
    }),
  )

  background.instance("background task completion does not wait for the parent async prompt", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps({ text: "background done" }),
              prompt: (input) =>
                input.sessionID === chat.id ? Effect.never : Effect.succeed(reply(input, "background done")),
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const waited = yield* jobs.wait({ id: result.metadata.sessionId, timeout: 1_000 })
      expect(waited.timedOut).toBe(false)
      expect(waited.info?.status).toBe("completed")
    }),
  )

  background.instance("removing the parent session cancels running background tasks", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps(),
              prompt: () => Effect.never,
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      yield* sessions.remove(chat.id)
      const waited = yield* jobs.wait({ id: result.metadata.sessionId, timeout: 1_000 })
      expect(waited.timedOut).toBe(false)
      expect(waited.info?.status).toBe("cancelled")
    }),
  )

  background.instance("removing the child task session cancels its running background task", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps(),
              prompt: () => Effect.never,
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      yield* sessions.remove(result.metadata.sessionId)
      const waited = yield* jobs.wait({ id: result.metadata.sessionId, timeout: 1_000 })
      expect(waited.timedOut).toBe(false)
      expect(waited.info?.status).toBe("cancelled")
    }),
  )

  background.instance("cancelling the parent run cancels running background tasks", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps(),
              prompt: () => Effect.never,
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      yield* jobs.cancelSession(chat.id)
      const waited = yield* jobs.wait({ id: result.metadata.sessionId, timeout: 1_000 })
      expect(waited.timedOut).toBe(false)
      expect(waited.info?.status).toBe("cancelled")
    }),
  )

  it.instance("cancelling a child run cancels its own pre-runner task job", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const sessions = yield* Session.Service
      const { chat } = yield* seed()
      const child = yield* sessions.create({ parentID: chat.id, title: "child" })

      yield* jobs.start({
        id: child.id,
        type: "task",
        metadata: { parentSessionId: chat.id, sessionId: child.id },
        run: Effect.never,
      })

      yield* jobs.cancelSession(child.id)

      expect((yield* jobs.get(child.id))?.status).toBe("cancelled")
    }),
  )

  it.instance("cancelling a parent run recursively cancels descendant background tasks", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const sessions = yield* Session.Service
      const { chat } = yield* seed()
      const child = yield* sessions.create({ parentID: chat.id, title: "child" })
      const grandchild = yield* sessions.create({ parentID: child.id, title: "grandchild" })
      const unrelatedParent = yield* sessions.create({ title: "unrelated-parent" })
      const sibling = yield* sessions.create({ parentID: unrelatedParent.id, title: "sibling" })
      const interruptionOrder: string[] = []

      yield* jobs.start({
        id: child.id,
        type: "task",
        metadata: { parentSessionId: chat.id, sessionId: child.id },
        run: Effect.never.pipe(Effect.onInterrupt(() => Effect.sync(() => interruptionOrder.push("child")))),
      })
      yield* jobs.start({
        id: grandchild.id,
        type: "task",
        metadata: { parentSessionId: child.id, sessionId: grandchild.id },
        run: Effect.never.pipe(Effect.onInterrupt(() => Effect.sync(() => interruptionOrder.push("grandchild")))),
      })
      yield* jobs.start({
        id: sibling.id,
        type: "task",
        metadata: { parentSessionId: unrelatedParent.id, sessionId: sibling.id },
        run: Effect.never.pipe(Effect.onInterrupt(() => Effect.sync(() => interruptionOrder.push("sibling")))),
      })

      yield* jobs.cancelSession(chat.id)

      expect((yield* jobs.get(child.id))?.status).toBe("cancelled")
      expect((yield* jobs.get(grandchild.id))?.status).toBe("cancelled")
      expect(interruptionOrder).toEqual(["grandchild", "child"])
      expect((yield* jobs.get(sibling.id))?.status).toBe("running")
      yield* jobs.cancel(sibling.id)
    }),
  )
})
