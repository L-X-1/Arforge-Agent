import { describe, expect, test } from "bun:test"
import {
  assessFormalDefaultReadiness,
  directPromptBypassFindings,
  type SessionExecutionTopologySite,
} from "./arforge-session-execution-topology"

const site = (
  path: string,
  method: string,
  service: SessionExecutionTopologySite["service"] = "SessionPrompt",
): SessionExecutionTopologySite => ({ path, line: 10, service, method })

describe("session execution topology", () => {
  test("rejects a production SessionPrompt loop bypass", () => {
    expect(
      directPromptBypassFindings([
        site("packages/arforge/src/server/routes/instance/httpapi/handlers/session.ts", "loop"),
      ]),
    ).toEqual([
      expect.objectContaining({
        code: "ASE-001",
        detail: expect.stringContaining("SessionPrompt.loop"),
      }),
    ])
  })

  test("rejects reintroducing the retired mature execution adapter", () => {
    for (const method of ["loop", "runLoop", "cancel"]) {
      expect(directPromptBypassFindings([site("packages/arforge/src/session/execution.ts", method)])).toHaveLength(1)
    }
  })

  test("does not confuse direct shell ActionGateway transport with an Agent Loop owner", () => {
    expect(
      directPromptBypassFindings([
        site("packages/arforge/src/server/routes/instance/httpapi/handlers/session.ts", "shell"),
      ]),
    ).toEqual([])
  })

  test("reports canonical admission progress without calling a conditional Mature/Formal split ready", () => {
    const result = assessFormalDefaultReadiness({
      execution:
        "if (options?.credentialIDs.length || options?.billing !== undefined) return drainScoped(); prompt.loop()",
      prompt:
        'SessionInput.admit(database.db, events); admitWithCommand(prepared.prompt, { name: prepared.command, arguments: prepared.arguments }); DurableRequestSystem.create(message.info.system); if (task?.type === "subtask") {}',
      promptSchema: "system: RequestSystem.pipe(optional)",
      formalRunner: "PromptSystem.layer({ messageID: latestUserMessage.id",
      httpServer: "SessionExecutionMature.node",
      appRuntime: "SessionExecutionMature.node",
    })

    expect(result.selected_owner).toBe("conditional")
    expect(result.ready).toBe(false)
    expect(result.checks.filter((check) => check.ready).map((check) => check.id)).toEqual([
      "AFD-001",
      "AFD-002",
      "AFD-003",
    ])
    expect(result.blockers.map((check) => check.id)).toEqual(["AFD-004", "AFD-005"])
  })

  test("marks Formal ready only when every admission surface and product root has converged", () => {
    const fixture = {
      execution: "const scheduledTaskTool = prompt.scheduledTaskTool({}); return runner.run({ scheduledTaskTool, })",
      prompt:
        "SessionInput.admit(database.db, events); admitWithCommand(prepared.prompt, { name: prepared.command, arguments: prepared.arguments }); DurableRequestSystem.create(message.info.system); scheduledTasks.length > 0 ? { scheduledTasks } : {}; const scheduledTaskTool = Effect.fn('SessionPrompt.scheduledTaskTool')",
      promptSchema: "system: RequestSystem.pipe(optional); scheduledTasks: Schema.Array(ScheduledTask).pipe(optional)",
      formalRunner:
        "PromptSystem.layer({ messageID: latestUserMessage.id; SessionRunner.executeScheduledTask; scheduledTaskTool: input.runtime.tool",
      httpServer: "SessionExecutionFormal.node",
      appRuntime: "SessionExecutionFormal.node",
    }

    const result = assessFormalDefaultReadiness(fixture)

    expect(result).toMatchObject({ ready: true, selected_owner: "formal", blockers: [] })
    expect(result.checks.every((check) => check.ready)).toBe(true)
    for (const [field, duplicate] of [
      ["prompt", "const scheduledTaskCarrier = Effect.fn('retired')"],
      ["prompt", "const prepareScheduledSubtaskProjection = Effect.fn('retired')"],
      ["formalRunner", "readonly carrier: TurnToolCarrier.ScheduledTask"],
    ] as const) {
      const reintroduced = assessFormalDefaultReadiness({ ...fixture, [field]: fixture[field] + duplicate })
      expect(reintroduced.ready).toBe(false)
      expect(reintroduced.blockers.map((check) => check.id)).toContain("AFD-004")
    }
  })
})
