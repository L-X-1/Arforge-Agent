export * as TaskV2 from "./task"

import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { TaskGraph } from "@arforge-ai/schema/task-graph"
import { Context, Effect, Layer } from "effect"
import { makeLocationNode } from "./effect/app-node"
import { SessionSchema } from "./session/schema"
import { TaskGraphV2 } from "./task-graph"

/**
 * Task is the AgentRuntime business-object facade. TaskGraph remains the only
 * writer and durable authority; this service intentionally exposes no
 * mutation methods and therefore cannot create a second Task state machine.
 */
export const ID = AgentRuntime.TaskID
export type ID = AgentRuntime.TaskID
export const Status = AgentRuntime.TaskStatus
export type Status = AgentRuntime.TaskStatus
export const Info = AgentRuntime.Task
export type Info = AgentRuntime.Task

export interface Page {
  readonly items: ReadonlyArray<Info>
  readonly total: number
}

export interface Interface {
  readonly get: (input: {
    readonly sessionID: SessionSchema.ID
    readonly taskID: ID
  }) => Effect.Effect<Info, TaskGraphV2.NotFoundError>
  readonly list: (input: {
    readonly sessionID: SessionSchema.ID
    readonly status?: TaskGraphV2.Status
    readonly owner?: TaskGraphV2.Owner
    readonly search?: string
  }) => Effect.Effect<Page>
}

export class Service extends Context.Service<Service, Interface>()("@arforge/v2/Task") {}

/** Lossless identity/status projection from the durable TaskGraph authority. */
export const fromTaskGraph = (task: TaskGraph.Info): Info =>
  AgentRuntime.Task.make({
    id: task.id,
    sessionID: task.sessionID,
    objective: task.title,
    status: task.status,
    revision: task.revision,
    time: task.time,
  })

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const taskGraph = yield* TaskGraphV2.Service

    return {
      get: (input) => taskGraph.get(input).pipe(Effect.map(fromTaskGraph)),
      list: (input) =>
        taskGraph.list(input).pipe(
          Effect.map((page) => ({
            items: page.items.map(fromTaskGraph),
            total: page.total,
          })),
        ),
    } satisfies Interface
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [TaskGraphV2.node],
})
