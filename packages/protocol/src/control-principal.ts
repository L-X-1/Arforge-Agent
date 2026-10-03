import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { Schema } from "effect"

/**
 * Client mutation envelope shared by control-plane HTTP payloads.
 *
 * Deliberately no tenantID, userID, actor, or principalRef is accepted here.
 * The server derives those values from its authenticated IdentityContext and
 * constructs the durable ControlPlaneSubject before Core sees the mutation.
 */
export const ControlPlaneMutationPayload = Schema.Struct({
  requestID: AgentRuntime.ControlPlaneRequestID,
}).annotate({ identifier: "Protocol.ControlPlaneMutationPayload" })

export type ControlPlaneMutationPayload = typeof ControlPlaneMutationPayload.Type
