import { expect, test } from "bun:test"
import { AbsolutePath } from "@arforge-ai/core/schema"
import * as ControlClaimIndex from "@arforge-ai/core/runtime/control-claim-index"
import { ControlPrincipal } from "@arforge-ai/core/runtime/control-principal"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { ProjectID } from "@arforge-ai/schema/project-id"
import { Effect } from "effect"
import { SessionID } from "@/session/schema"
import { SessionShareControlOperation } from "@/control-operation/session-share-operation"
import * as SessionShareSnapshot from "@/share/session-snapshot"

const principal: ControlClaimIndex.Principal = { tenantID: "ten_local", userID: "usr_local" }
const sessionID = SessionID.make("ses_share_operation_test")
const projectID = ProjectID.make("project_share_operation_test")
const location = "C:\\repo\\share-operation"
const requestID = AgentRuntime.ControlPlaneRequestID.make("cpr_share_operation_test")

const snapshot = SessionShareSnapshot.encode({
  version: 1,
  kind: "share",
  requestID,
  sessionID,
  projectID,
  location,
  eventHighWaterMark: 4,
  export: {
    format: SessionShareSnapshot.FORMAT,
    items: [{ key: "session", type: "session", data: { id: sessionID, projectID, directory: location } }],
  },
  target: {
    baseURL: "https://share.example.com/api",
    organizationID: null,
    visibility: "private",
    publication: null,
  },
  heuristicScan: {
    scannerVersion: SessionShareSnapshot.HEURISTIC_SCANNER_VERSION,
    excluded: [],
  },
})

test("session share control operation claims the sealed snapshot and only schedules its durable run", async () => {
  const seen: ControlClaimIndex.ClaimInput[] = []
  const scheduled: AgentRuntime.RunID[] = []
  const claims = {
    claim: (input: ControlClaimIndex.ClaimInput) =>
      Effect.sync(() => {
        seen.push(input)
        return {
          kind: "claimed" as const,
          presentedRequestID: input.subject.requestID,
          snapshot: {
            run: {
              id: AgentRuntime.RunID.make("run_share_operation_test"),
              operation: { actionID: AgentRuntime.ActionID.make("act_share_operation_test") },
              status: "draft" as const,
            },
          },
        } as unknown as ControlClaimIndex.ClaimResult
      }),
  } as unknown as ControlClaimIndex.Interface
  const service = SessionShareControlOperation.make({
    claims,
    scheduler: { start: (runID) => Effect.sync(() => void scheduled.push(runID)) },
  })
  const subject = AgentRuntime.ControlPlaneSubject.make({
    type: "control-plane",
    id: AgentRuntime.ControlPlaneID.make("ctl_share_operation_test"),
    location: AbsolutePath.make(location),
    project: projectID,
    actor: "user",
    principalRef: ControlPrincipal.principalRef(principal),
    requestID,
  })

  const result = await Effect.runPromise(
    service
      .claimAndStart({ subject, snapshot })
      .pipe(Effect.provideService(ControlClaimIndex.CurrentPrincipal, principal)),
  )

  expect(result).toMatchObject({ runID: "run_share_operation_test", status: "draft" })
  expect(scheduled).toEqual([AgentRuntime.RunID.make("run_share_operation_test")])
  expect(seen).toHaveLength(1)
  expect(seen[0]!.operation.kind).toBe("session.share")
  expect(seen[0]!.operation.payload).toEqual(snapshot)
  expect(seen[0]!.claimMaterial?.input).not.toHaveProperty("requestID")
})
