import { existsSync, renameSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { Effect } from "effect"
import { commitWorkspaceRootMutation } from "../../src/workspace-root-writer"
import { makeWorkspaceRootFileWriter } from "../../src/workspace-root-file-writer"
import { planWorkspaceRootMutation, workspaceRootMutationIntentDigest } from "../../src/workspace-roots"

const [profileDirectory, primary, target, readyMarker, startMarker, resultMarker] = process.argv.slice(2)

if (!profileDirectory || !primary || !target || !readyMarker || !startMarker || !resultMarker) process.exit(2)

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
  receiptID: "receipt-process-concurrent",
  actionID: "action-process-concurrent",
  workspace: request.primary,
  target: request.target,
  intentDigest: workspaceRootMutationIntentDigest(request),
}
const plan = planWorkspaceRootMutation({ ...request, authorization })
const writer = makeWorkspaceRootFileWriter({
  profileDirectory: resolve(profileDirectory),
  primary: request.primary,
  enabled: true,
})

const writeMarker = (path: string, value: unknown) => {
  const temporary = `${path}.tmp-${process.pid}`
  writeFileSync(temporary, JSON.stringify(value), "utf8")
  renameSync(temporary, path)
}

writeMarker(readyMarker, { schemaVersion: 1, pid: process.pid, ready: true })
while (!existsSync(startMarker)) await Bun.sleep(5)

try {
  const result = await Effect.runPromise(
    commitWorkspaceRootMutation({
      request,
      authorization,
      plan,
      writer,
    }),
  )
  writeMarker(resultMarker, { schemaVersion: 1, status: result.status, intentDigest: result.intentDigest })
} catch (error) {
  writeMarker(resultMarker, {
    schemaVersion: 1,
    status: "failed",
    reason: error instanceof Error ? error.message : String(error),
  })
  process.exitCode = 1
}
