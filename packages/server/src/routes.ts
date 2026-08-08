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

const applicationServices = LayerNode.group([
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
    Layer.provide(serviceLayer),
  )
}

export const routes = createRoutes()

export const webHandler = () =>
  HttpRouter.toWebHandler(routes.pipe(Layer.provide(HttpServer.layerServices)), { disableLogger: true })
