export * as DurableEventManifest from "./durable-event-manifest"

import { Event } from "./event"
import { A2A } from "./a2a"
import { AgentRuntime } from "./agent-runtime"
import { SessionEvent } from "./session-event"
import { SessionV1 } from "./session-v1"
import { PersonalJob } from "./personal-job"
import { McpEvent } from "./mcp-event"

export const SessionDurable = {
  definitions: Event.durable(SessionEvent.DurableDefinitions),
  schema: SessionEvent.Durable,
} as const

export const AgentRunDurable = {
  definitions: Event.durable(AgentRuntime.Event.RunDefinitions),
  schema: AgentRuntime.RunDurableEvent,
} as const

export const AgentActionDurable = {
  definitions: Event.durable(AgentRuntime.Event.ActionDefinitions),
  schema: AgentRuntime.ActionDurableEvent,
} as const

export const Durable = Event.durable([
  ...AgentRuntime.Event.Definitions,
  ...A2A.Event.Definitions,
  ...PersonalJob.Event.Definitions,
  ...SessionV1.Event.Definitions.filter((definition) => definition.durable !== undefined),
  ...SessionEvent.DurableDefinitions,
  ...McpEvent.DurableDefinitions,
])
