import { writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { Effect } from "effect"
import { commitWorkspaceRootMutation } from "../../src/workspace-root-writer"
import { makeWorkspaceRootFileWriter } from "../../src/workspace-root-file-writer"
import { planWorkspaceRootMutation, workspaceRootMutationIntentDigest } from "../../src/workspace-roots"

const [profileDirectory, primary, target, readyMarker] = process.argv.slice(2)

if (!profileDirectory || !primary || !target || !readyMarker) {
  process.exit(2)
}

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
  receiptID: "receipt-process-crash",
  actionID: "action-process-crash",
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
    if (stage !== "after-trusted-file") return
    // The marker is written only after the journal and the first state file
    // are durable.  SIGKILL then leaves the exact cross-file crash window for
    // a fresh process to recover.
    writeFileSync(resolve(readyMarker), "trusted-file-written", "utf8")
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
