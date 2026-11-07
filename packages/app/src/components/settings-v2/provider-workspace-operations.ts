import type { OperationsApi } from "@/utils/server"
export type WorkspaceApi = OperationsApi["providers"]
export type WorkspaceDetail = Awaited<ReturnType<WorkspaceApi["configurationGet"]>>["data"]
export type WorkspaceTestResult = Awaited<ReturnType<WorkspaceApi["configurationTest"]>>["data"]

export class WorkspaceCredentialPending extends Error {}
/** Volatile nonsecret acknowledgement permits credential-only retries after a partial commit. */
export function createWorkspaceSave(api: Pick<WorkspaceApi, "save" | "credential">, isCurrent: () => boolean) {
  let committed: { revision: string; fingerprint: string } | undefined
  const check = () => {
    if (!isCurrent()) throw new Error("Configuration source changed")
  }
  return async (input: Parameters<WorkspaceApi["save"]>[0], key?: string) => {
    check()
    const { revision: requestedRevision, ...publicInput } = input
    const fingerprint = JSON.stringify(publicInput)
    if (!committed || committed.fingerprint !== fingerprint) {
      const receipt = (await api.save({ ...input, revision: committed?.revision ?? requestedRevision })).data
      check()
      committed = { revision: receipt.revision, fingerprint }
    }
    check()
    if (key?.trim()) {
      try {
        await api.credential({
          providerID: input.providerID,
          location: input.location,
          revision: committed.revision,
          key: key.trim(),
        })
      } catch {
        check()
        throw new WorkspaceCredentialPending("Configuration saved; reconnect pending")
      }
      check()
    }
  }
}

/** Only the captured saved source/revision may publish a diagnostic result. */
export function createSavedModelTest<Result>(input: {
  owner: () => string
  isCurrent: () => boolean
  run: (modelID: string, signal: AbortSignal) => Promise<Result>
  publish: (modelID: string, state: { status: "pending" | "done" | "failed" | "cancelled"; result?: Result }) => void
}) {
  let generation = 0,
    controller: AbortController | undefined,
    pendingID: string | undefined
  const cancel = () => {
    generation++
    controller?.abort()
    controller = undefined
    if (pendingID && input.isCurrent()) input.publish(pendingID, { status: "cancelled" })
    pendingID = undefined
  }
  return {
    cancel,
    async start(modelID: string) {
      cancel()
      if (!input.isCurrent()) return
      const owner = input.owner(),
        operation = ++generation,
        abort = new AbortController()
      controller = abort
      pendingID = modelID
      const current = () =>
        input.isCurrent() && owner === input.owner() && generation === operation && !abort.signal.aborted
      input.publish(modelID, { status: "pending" })
      try {
        const result = await input.run(modelID, abort.signal)
        if (current()) input.publish(modelID, { status: "done", result })
      } catch {
        if (current()) input.publish(modelID, { status: "failed" })
      } finally {
        if (generation === operation) {
          pendingID = undefined
          controller = undefined
        }
      }
    },
  }
}

/** Patch omission preserves authentication, adapter and server-only advanced fields. */
export function workspacePatch(
  detail: WorkspaceDetail,
  changes: {
    name?: string
    baseURL?: string
    apiFormat?: Parameters<WorkspaceApi["save"]>[0]["apiFormat"]
    disabled?: boolean
    models?: Parameters<WorkspaceApi["save"]>[0]["models"]
    deletedModelIDs?: readonly string[]
  },
): Parameters<WorkspaceApi["save"]>[0] {
  return {
    providerID: detail.providerID,
    revision: detail.revision,
    name: changes.name ?? detail.name,
    ...(changes.baseURL !== undefined ? { baseURL: changes.baseURL } : {}),
    models: changes.models ?? [],
    ...(changes.apiFormat !== undefined ? { apiFormat: changes.apiFormat } : {}),
    ...(changes.disabled !== undefined ? { disabled: changes.disabled } : {}),
    ...(changes.deletedModelIDs !== undefined ? { deletedModelIDs: changes.deletedModelIDs } : {}),
  }
}
