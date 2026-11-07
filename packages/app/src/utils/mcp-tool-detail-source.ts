import { pathKey } from "./path-key"
import type { OperationsApi } from "./server"

type Response = Awaited<ReturnType<OperationsApi["mcp"]["toolDetails"]>>
type Request = Parameters<OperationsApi["mcp"]["toolDetails"]>[0]

export function matchesMcpToolDetailsSource(response: Response, request: Request) {
  const item = response.data.capability
  return (
    item.kind === "tool" &&
    item.server === request.server &&
    item.id === request.capabilityID &&
    item.generation === request.generation &&
    (!request.location?.directory || pathKey(response.location.directory) === pathKey(request.location.directory)) &&
    (!request.location?.workspace || response.location.workspaceID === request.location.workspace)
  )
}
