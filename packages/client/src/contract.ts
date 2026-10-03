import { makeDefaultApi } from "@arforge-ai/protocol/api"
import { InvalidRequestError, SessionNotFoundError } from "@arforge-ai/protocol/errors"
import { HttpApiMiddleware } from "effect/unstable/httpapi"

class LocationMiddleware extends HttpApiMiddleware.Service<LocationMiddleware>()(
  "@arforge-ai/client-next/LocationMiddleware",
) {}

class SessionLocationMiddleware extends HttpApiMiddleware.Service<SessionLocationMiddleware>()(
  "@arforge-ai/client-next/SessionLocationMiddleware",
  { error: [InvalidRequestError, SessionNotFoundError] },
) {}

export const ClientApi = makeDefaultApi({
  locationMiddleware: LocationMiddleware,
  sessionLocationMiddleware: SessionLocationMiddleware,
})

export const groupNames = {
  "server.health": "health",
  "server.location": "location",
  "server.agent": "agents",
  "server.session": "sessions",
  "server.goal": "goals",
  "server.scheduledPrompt": "scheduledPrompts",
  "server.personalJob": "personalJobs",
  "server.personalWorkspace": "personalWorkspace",
  "server.taskGraph": "tasks",
  "server.team": "teams",
  "server.cooperativeWait": "waits",
  "server.trigger": "triggers",
  "server.memory": "memories",
  "server.learning": "learning",
  "server.feedback": "feedback",
  "server.multimodalDiagnosis": "diagnostics",
  "server.agentCapability": "agentCapabilities",
  "server.mcp": "mcp",
  "server.privateOperation": "privateOperations",
  "server.runtimeInsight": "runtimeInsight",
  "server.subagentControl": "subagentControl",
  "server.message": "messages",
  "server.model": "models",
  "server.provider": "providers",
  "server.integration": "integrations",
  "server.credential": "credentials",
  "server.permission": "permissions",
  "server.fs": "files",
  "server.command": "commands",
  "server.skill": "skills",
  "server.event": "events",
  "server.pty": "ptys",
  "server.question": "questions",
  "server.reference": "references",
  "server.projectCopy": "projectCopies",
  "server.tenantPlatform": "tenantPlatform",
  "server.artifact": "artifacts",
} as const

export const endpointNames = {
  "session.messages": "list",
  "integration.connect.key": "connectKey",
  "integration.connect.oauth": "connectOauth",
  "integration.attempt.status": "attemptStatus",
  "integration.attempt.complete": "attemptComplete",
  "integration.attempt.cancel": "attemptCancel",
  "permission.request.list": "listRequests",
  "permission.saved.list": "listSaved",
  "permission.saved.remove": "removeSaved",
  "question.request.list": "listRequests",
  "mcp.resource.catalog": "resourceCatalog",
  "mcp.capabilities": "capabilities",
  "mcp.action.reconciliation": "actionReconciliation",
  "mcp.action.reconciliationRecord": "recordReconciliation",
} as const

export const omitEndpoints = new Set(["fs.read", "pty.connect", "pty.connectToken"])
