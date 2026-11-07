import { expect, test } from "bun:test"
import { Cause, DateTime, Effect, Exit, Layer } from "effect"
import { AgentV2 } from "@arforge-ai/core/agent"
import { EventV2 } from "@arforge-ai/core/event"
import { ModelV2 } from "@arforge-ai/core/model"
import { ProviderV2 } from "@arforge-ai/core/provider"
import { DurableAction } from "@arforge-ai/core/runtime/durable-action"
import { SessionMessage } from "@arforge-ai/core/session/message"
import { SessionSchema } from "@arforge-ai/core/session/schema"
import { SessionStore } from "@arforge-ai/core/session/store"
import { ToolRegistry } from "@arforge-ai/core/tool/registry"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import {
  resourceAssistantID,
  resourceToolName,
  settleResourceAttachments,
} from "@arforge-ai/core/session/runner/resource-attachments"

const sessionID = SessionSchema.ID.make("ses_resource_guards")
const user = SessionMessage.User.make({
  id: SessionMessage.ID.make("msg_resource_guards"),
  type: "user",
  text: "@manual",
  files: [{ uri: "evidence://manual", mime: "text/plain", resource: { server: "A", uri: "evidence://manual" } }],
  time: { created: DateTime.makeUnsafe(0) },
})
const model = ModelV2.Ref.make({ id: ModelV2.ID.make("local"), providerID: ProviderV2.ID.make("local") })

for (const boundary of ["unavailable", "step-limit", "omitted-committed-step", "lease-lost"] as const)
  test(`MCP attachment ${boundary} fails explicitly without a remote read`, async () => {
    const published: string[] = []
    let materializations = 0
    const committed = SessionMessage.Assistant.make({
      id: resourceAssistantID(sessionID, user.id),
      type: "assistant",
      agent: "build",
      model,
      content: [],
      time: { created: DateTime.makeUnsafe(0), completed: DateTime.makeUnsafe(1) },
    })
    const publish: EventV2.Interface["publish"] = (definition, data) =>
      Effect.sync(() => {
        published.push(definition.type)
        return { id: EventV2.ID.create(), type: definition.type, data }
      })
    const exit = await Effect.runPromise(
      settleResourceAttachments({
        sessionID,
        runID: AgentRuntime.RunID.make("run_resource_guards"),
        context: [user],
        agent: AgentV2.ID.make("build"),
        model,
        permissions: [],
        externalTools: {},
        isLastStep: boundary === "step-limit",
        validateExecution: boundary === "lease-lost" ? Effect.die(new Error("execution lease lost")) : Effect.void,
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.mock(EventV2.Service, { publish }),
            Layer.mock(ToolRegistry.Service, {
              materialize: () =>
                Effect.sync(() => {
                  materializations++
                  throw new Error("No execution is allowed")
                }),
            }),
            Layer.mock(DurableAction.Service, {
              load: (actionID) => Effect.fail(new DurableAction.NotFoundError({ actionID })),
            }),
            Layer.mock(SessionStore.Service, {
              message: () =>
                Effect.succeed(boundary === "omitted-committed-step" ? { sessionID, message: committed } : undefined),
            }),
          ),
        ),
        Effect.exit,
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit))
      expect(Cause.pretty(exit.cause)).toContain(
        {
          unavailable: "unavailable",
          "step-limit": "step limit",
          "omitted-committed-step": "outside the current context",
          "lease-lost": "execution lease lost",
        }[boundary],
      )
    expect(materializations).toBe(0)
    if (boundary === "omitted-committed-step" || boundary === "lease-lost") expect(published).toEqual([])
    else {
      expect(published).toContain("session.next.tool.failed")
      expect(published).toContain("session.next.step.failed")
    }
  })

test("MCP attachment identities retain server, URI and admitted input identity", () => {
  expect(resourceToolName({ server: "A", uri: "evidence://same" })).not.toBe(
    resourceToolName({ server: "B", uri: "evidence://same" }),
  )
  expect(resourceToolName({ server: "A", uri: "evidence://same" })).toBe(
    resourceToolName({ server: "A", uri: "evidence://same" }),
  )
  expect(resourceAssistantID(sessionID, "msg_A")).not.toBe(resourceAssistantID(sessionID, "msg_B"))
})
