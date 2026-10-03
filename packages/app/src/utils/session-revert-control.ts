import type { OperationsApi } from "./server"
import {
  beginControlOperation,
  runControlOperation,
  type ControlOperationRunResult,
} from "./control-operation-intent"

type Location = { readonly directory: string; readonly workspace?: string }

type Common = {
  readonly api: OperationsApi
  readonly server: string
  readonly project: string
  readonly location: Location
  readonly sessionID: string
}

export async function requestSessionRevert(
  input: Common & { readonly messageID: string; readonly partID?: string },
): Promise<ControlOperationRunResult<true>> {
  const intent = await beginControlOperation({
    server: input.server,
    project: input.project,
    location: input.location.directory,
    kind: "session.revert",
    input: { sessionID: input.sessionID, messageID: input.messageID, partID: input.partID },
  })
  return runControlOperation<true>(intent, async (requestID) => {
    return input.api.controlledSessions.revert({
      sessionID: input.sessionID,
      directory: input.location.directory,
      workspace: input.location.workspace,
      requestID,
      messageID: input.messageID,
      partID: input.partID,
    })
  })
}

export async function requestSessionUnrevert(input: Common): Promise<ControlOperationRunResult<true>> {
  const intent = await beginControlOperation({
    server: input.server,
    project: input.project,
    location: input.location.directory,
    kind: "session.unrevert",
    input: { sessionID: input.sessionID },
  })
  return runControlOperation<true>(intent, async (requestID) => {
    return input.api.controlledSessions.unrevert({
      sessionID: input.sessionID,
      directory: input.location.directory,
      workspace: input.location.workspace,
      requestID,
    })
  })
}
