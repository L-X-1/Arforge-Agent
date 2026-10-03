import { writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { Effect } from "effect"
import { commitWorkspaceRootMutation } from "../../src/workspace-root-writer"
import { makeWorkspaceRootFileWriter } from "../../src/workspace-root-file-writer"
import { planWorkspaceRootMutation, workspaceRootMutationIntentDigest } from "../../src/workspace-roots"

const [profileDirectory, primary, target, readyMarker, crashStage = "after-journal-committed"] = process.argv.slice(2)

if (!profileDirectory || !primary || !target || !readyMarker) process.exit(2)

const request = {
  action: "trust" as const,
  primary: resolve(primary),
  primaryIsDirectory: true,
  target: resolve(target),
  targetIsDirectory: true,
  trustedWorkspaces: [] as string[],
  configuredRoots: [] as string[],
}
const authorization = {
  kind: "action-gateway" as const,
  status: "approved" as const,
  receiptID: "receipt-promotion-crash",
  actionID: "action-promotion-crash",
  workspace: request.primary,
  target: request.target,
  intentDigest: workspaceRootMutationIntentDigest(request),
}
const plan = planWorkspaceRootMutation({ ...request, authorization })
const writer = makeWorkspaceRootFileWriter({
  profileDirectory: resolve(profileDirectory),
  primary: request.primary,
  enabled: true,
  testFaultInjection: (stage) => {
    if (stage !== crashStage) return
    // Both state files and the committed journal are durable, while the
    // outbox/audit promotion has not started. A real SIGKILL leaves the
    // exact post-CAS ambiguity that restart must classify as recovery-required.
    writeFileSync(resolve(readyMarker), crashStage, "utf8")
    process.kill(process.pid, "SIGKILL")
  },
})

await Effect.runPromise(
  commitWorkspaceRootMutation({
    request,
    authorization,
    plan,
    writer,
  }),
)
