import type { SessionMessageInfo } from "@arforge-ai/client/promise"
import type { AgentRuntime } from "@arforge-ai/schema/agent-runtime"

export type PrimaryDeliveryArtifactInfo = {
  artifactID: string
  artifactRef?: AgentRuntime.OpaqueArtifactRef
  path: string
  displayName: string
  mime: string
  sizeBytes: number
  createdAt: number
  sha256: string
  source: "user_message"
  isImage: boolean
}

export type PrimaryDeliveryInfo = {
  status: "normal" | "proactive"
  sentAt: number
  attachmentCount: number
  attachments: PrimaryDeliveryArtifactInfo[]
  localOnly: true
  uploaded: false
}

export type PrimaryDeliveredEvent = {
  id: string
  type: "session.next.primary.delivered"
  data: {
    sessionID: string
    timestamp: number
    assistantMessageID: string
    callID: string
    message: string
    delivery: PrimaryDeliveryInfo
  }
}

export type AssistantWithPrimaryDelivery = Extract<SessionMessageInfo, { type: "assistant" }> & {
  delivery?: PrimaryDeliveryInfo
}

export function primaryDelivery(message: SessionMessageInfo): PrimaryDeliveryInfo | undefined {
  if (message.type !== "assistant") return
  const delivery = (message as AssistantWithPrimaryDelivery).delivery
  if (!delivery) return
  if (
    (delivery.status !== "normal" && delivery.status !== "proactive") ||
    !Number.isFinite(delivery.sentAt) ||
    !Number.isSafeInteger(delivery.attachmentCount) ||
    delivery.attachmentCount < 0 ||
    delivery.localOnly !== true ||
    delivery.uploaded !== false ||
    !Array.isArray(delivery.attachments) ||
    delivery.attachments.length !== delivery.attachmentCount
  )
    return
  return delivery
}
