import { describe, expect, test } from "bun:test"
import { AgentV2 } from "@arforge-ai/core/agent"
import { PermissionV2 } from "@arforge-ai/core/permission"
import { SessionMessage } from "@arforge-ai/core/session/message"
import { SessionSchema } from "@arforge-ai/core/session/schema"
import type { ToolRegistry } from "@arforge-ai/core/tool/registry"
import { Deferred, Effect } from "effect"
import { ExplicitToolApproval } from "@/cli/cmd/debug/explicit-tool-approval"

const identity = {
  sessionID: SessionSchema.ID.make("ses_debug_exact"),
  assistantMessageID: SessionMessage.ID.make("msg_debug_exact"),
  toolCallID: "call_debug_exact",
}

const request = (id: string, source = identity): PermissionV2.Request => ({
  id: PermissionV2.ID.create(id),
  sessionID: source.sessionID,
  action: "debug_write",
  resources: ["workspace/file.txt"],
  source: {
    type: "tool",
    messageID: source.assistantMessageID,
    callID: source.toolCallID,
  },
  requiresHumanConfirmation: true,
})

test("approves every request from only the exact explicit invocation once", async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const first = yield* Deferred.make<void>()
      const second = yield* Deferred.make<void>()
      const exactFirst = request("per_debug_first")
      const exactSecond = request("per_debug_second")
      const foreign = request("per_debug_foreign", {
        sessionID: SessionSchema.ID.make("ses_other"),
        assistantMessageID: SessionMessage.ID.make("msg_other"),
        toolCallID: "call_other",
      })
      const pending: PermissionV2.Request[] = [foreign]
      const replies: PermissionV2.ReplyInput[] = []
      const waiters = new Map([
        [exactFirst.id, first],
        [exactSecond.id, second],
      ])
      const permissions = PermissionV2.Service.of({
        list: () => Effect.sync(() => [...pending]),
        reply: (input) =>
          Effect.gen(function* () {
            const index = pending.findIndex((item) => item.id === input.requestID)
            if (index < 0) return yield* new PermissionV2.NotFoundError({ requestID: input.requestID })
            replies.push(input)
            pending.splice(index, 1)
            const waiter = waiters.get(input.requestID)
            if (waiter) yield* Deferred.succeed(waiter, undefined)
          }),
        assert: () => Effect.die("unused"),
        ask: () => Effect.die("unused"),
        get: () => Effect.die("unused"),
        forSession: () => Effect.die("unused"),
      })
      let executions = 0
      const materialized: ToolRegistry.Materialization = {
        definitions: [],
        settle: () =>
          Effect.gen(function* () {
            pending.push(exactFirst)
            yield* Deferred.await(first)
            pending.push(exactSecond)
            yield* Deferred.await(second)
            executions += 1
            return { result: { type: "text" as const, value: "done" } }
          }),
      }
      const settlement = yield* ExplicitToolApproval.settle({
        permissions,
        materialized,
        identity,
        agent: AgentV2.ID.make("build"),
        name: "debug_write",
        args: { value: "ok" },
      })
      return { settlement, executions, replies, pending }
    }).pipe(Effect.timeoutOrElse({ duration: "2 seconds", orElse: () => Effect.die("approval timed out") })),
  )

  expect(result.executions).toBe(1)
  expect(result.settlement.result).toEqual({ type: "text", value: "done" })
  expect(result.replies).toEqual([
    { requestID: PermissionV2.ID.create("per_debug_first"), reply: "once" },
    { requestID: PermissionV2.ID.create("per_debug_second"), reply: "once" },
  ])
  expect(result.pending.map((item) => item.id)).toEqual([PermissionV2.ID.create("per_debug_foreign")])
})

describe("preflight failures", () => {
  for (const reason of ["Invalid input: value is required", "Permission blocked by deny rule"]) {
    test(`does not approve or execute after ${reason}`, async () => {
      const replies: PermissionV2.ReplyInput[] = []
      let executions = 0
      const permissions = PermissionV2.Service.of({
        list: () => Effect.succeed([]),
        reply: (input) => Effect.sync(() => replies.push(input)),
        assert: () => Effect.die("unused"),
        ask: () => Effect.die("unused"),
        get: () => Effect.die("unused"),
        forSession: () => Effect.die("unused"),
      })
      const materialized: ToolRegistry.Materialization = {
        definitions: [],
        settle: () =>
          Effect.sync(() => ({
            result: { type: "error" as const, value: reason },
          })),
      }
      const settlement = await Effect.runPromise(
        ExplicitToolApproval.settle({
          permissions,
          materialized,
          identity,
          agent: AgentV2.ID.make("build"),
          name: "debug_write",
          args: {},
        }),
      )
      expect(settlement.result).toEqual({ type: "error", value: reason })
      expect(executions).toBe(0)
      expect(replies).toEqual([])
    })
  }
})
