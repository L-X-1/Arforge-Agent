import { Database } from "@arforge-ai/core/database/database"
import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { httpClient } from "@arforge-ai/core/effect/app-node-platform"
import { AppNodeBuilder } from "@arforge-ai/core/effect/app-node-builder"
import { EventV2 } from "@arforge-ai/core/event"
import { Credential } from "@arforge-ai/core/credential"
import { PermissionSaved } from "@arforge-ai/core/permission/saved"
import { PtyTicket } from "@arforge-ai/core/pty/ticket"
import { SessionV2 } from "@arforge-ai/core/session"
import { ScheduledPromptV2 } from "@arforge-ai/core/scheduled-prompt"
import { TriggerV2 } from "@arforge-ai/core/trigger"
import { SessionExecution } from "@arforge-ai/core/session/execution"
import { LocationServiceMap } from "@arforge-ai/core/location-service-map"
import { SessionExecutionLocal } from "@arforge-ai/core/session/execution/local"
import { ToolOutputStore } from "@arforge-ai/core/tool-output-store"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Layer, Option } from "effect"
import { Api } from "./api"
import { ServerAuth } from "./auth"
import { handlers, RuntimeInsightPersistence } from "./handlers"
import { authorizationLayer } from "./middleware/authorization"
import { schemaErrorLayer } from "./middleware/schema-error"
import { PtyEnvironment } from "./pty-environment"
import { layer as locationLayer } from "./location"
import { sessionLocationLayer } from "./middleware/session-location"
import { UserAuth } from "./user-auth"
import { DurableRun } from "@arforge-ai/core/runtime/durable-run"
import { ControlClaimIndex } from "@arforge-ai/core/runtime"
import { SubagentControl } from "@arforge-ai/core/runtime/subagent-control"
import { SubagentControlRecovery } from "@arforge-ai/core/runtime/subagent-control-recovery"
import { RuntimeInvariants } from "@arforge-ai/core/runtime"
import { DurableAction } from "@arforge-ai/core/runtime/durable-action"
import { PersonalJobV2 } from "@arforge-ai/core/personal-job"
import { PersonalJobExecutor } from "@arforge-ai/core/personal-job-executor"
import { IdentityContext } from "./identity-context"
import { node as tenantPlatformNode } from "@arforge-ai/core/tenant-platform"
import { node as artifactMaintenanceScanNode } from "@arforge-ai/core/runtime/artifact-maintenance-scan"
import { node as profileMaintenanceLifecycleNode } from "@arforge-ai/core/runtime/profile-maintenance-lifecycle"
import { node as rollbackArtifactNode } from "@arforge-ai/core/runtime/rollback-artifact"

/**
 * Complete service graph required by the HTTP route layer.  Consumers that
 * embed `createRoutes` (the CLI server is one) must provide this same graph;
 * maintaining a smaller hand-written subset causes new route services to leak
 * into handler environments and makes the composition fail only at runtime.
 */
export const applicationServices = LayerNode.group([
  Database.node,
  EventV2.node,
  httpClient,
  ToolOutputStore.cleanupNode,
  SessionV2.node,
  ScheduledPromptV2.node,
  TriggerV2.node,
  PermissionSaved.node,
  PtyTicket.node,
  Credential.node,
  PtyEnvironment.node,
  LocationServiceMap.node,
  DurableRun.node,
  ControlClaimIndex.node,
  SubagentControl.node,
  SubagentControlRecovery.node,
  RuntimeInvariants.node,
  DurableAction.node,
  artifactMaintenanceScanNode,
  profileMaintenanceLifecycleNode,
  rollbackArtifactNode,
  PersonalJobV2.node,
  PersonalJobExecutor.node,
  tenantPlatformNode,
])

export function createRoutes(password?: string) {
  return makeRoutes(
    password
      ? ServerAuth.Config.configLayer({ username: "arforge", password: Option.some(password) })
      : ServerAuth.Config.layer,
  )
}

export function createEmbeddedRoutes() {
  return makeRoutes(ServerAuth.Config.configLayer({ username: "arforge", password: Option.none() }))
}

function makeRoutes<AuthError, AuthServices>(auth: Layer.Layer<ServerAuth.Config, AuthError, AuthServices>) {
  const serviceLayer = AppNodeBuilder.build(applicationServices, [[SessionExecution.node, SessionExecutionLocal.node]])

  return HttpApiBuilder.layer(Api, { openapiPath: "/openapi.json" }).pipe(
    Layer.provide(handlers),
    Layer.provide(RuntimeInsightPersistence),
    Layer.provide(sessionLocationLayer),
    Layer.provide(locationLayer),
    Layer.provide(authorizationLayer),
    Layer.provide(schemaErrorLayer),
    Layer.provide(auth),
    Layer.provide(UserAuth.Config.layer),
    // Handler effects may reference the request identity directly. Authorization
    // replaces this fallback per request after authentication; the fallback keeps
    // the assembled server layer total for private/basic-auth routes.
    Layer.provide(Layer.succeed(IdentityContext.Current, IdentityContext.LocalPrincipal)),
    // Control claims are request-scoped.  Keep the long-lived application layer
    // total with an explicit empty fallback; the subagent-control handler
    // supplies the authenticated principal around each claim operation.
    Layer.provide(Layer.succeed(ControlClaimIndex.CurrentPrincipal, undefined)),
    Layer.provide(serviceLayer),
  )
}

export const routes = createRoutes()

export const webHandler = () =>
  HttpRouter.toWebHandler(routes.pipe(Layer.provide(HttpServer.layerServices)), { disableLogger: true })
