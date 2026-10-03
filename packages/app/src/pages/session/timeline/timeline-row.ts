import type { SnapshotFileDiff } from "@arforge-ai/sdk/v2"
import type { PartGroup } from "@arforge-ai/session-ui/message-part"
import { Data, Equal } from "effect"
import type { PrimaryDeliveryInfo } from "@/utils/primary-delivery"

export type SummaryDiff = SnapshotFileDiff & { file: string }

export namespace TimelineRow {
  export class TurnGap extends Data.TaggedClass("TurnGap")<{
    userMessageID: string
  }> {}
  export class CommentStrip extends Data.TaggedClass("CommentStrip")<{
    userMessageID: string
  }> {}
  export class UserMessage extends Data.TaggedClass("UserMessage")<{
    userMessageID: string
    anchor: boolean
  }> {}
  export class TurnDivider extends Data.TaggedClass("TurnDivider")<{
    userMessageID: string
    label: "compaction" | "interrupted"
  }> {}
  export class AssistantPart extends Data.TaggedClass("AssistantPart")<{
    userMessageID: string
    group: PartGroup
    previousAssistantPart: boolean
  }> {}
  export class PrimaryDelivery extends Data.TaggedClass("PrimaryDelivery")<{
    userMessageID: string
    assistantMessageID: string
    delivery: PrimaryDeliveryInfo
  }> {}
  export class Thinking extends Data.TaggedClass("Thinking")<{
    userMessageID: string
  }> {}
  export class DiffSummary extends Data.TaggedClass("DiffSummary")<{
    userMessageID: string
    diffs: SummaryDiff[]
  }> {}
  export class Error extends Data.TaggedClass("Error")<{
    userMessageID: string
    text: string
  }> {}
  export class Retry extends Data.TaggedClass("Retry")<{
    userMessageID: string
  }> {}

  export type TimelineRow =
    | TurnGap
    | CommentStrip
    | UserMessage
    | TurnDivider
    | AssistantPart
    | PrimaryDelivery
    | Thinking
    | DiffSummary
    | Error
    | Retry

  export const key = (row: TimelineRow) => {
    switch (row._tag) {
      case "TurnGap":
        return `turn-gap:${row.userMessageID}`
      case "CommentStrip":
        return `comment-strip:${row.userMessageID}`
      case "UserMessage":
        return `user-message:${row.userMessageID}`
      case "TurnDivider":
        return `turn-divider:${row.userMessageID}:${row.label}`
      case "AssistantPart":
        return `assistant-part:${row.userMessageID}:${row.group.key}`
      case "PrimaryDelivery":
        return `primary-delivery:${row.assistantMessageID}`
      case "Thinking":
        return `thinking:${row.userMessageID}`
      case "DiffSummary":
        return `diff-summary:${row.userMessageID}`
      case "Error":
        return `error:${row.userMessageID}`
      case "Retry":
        return `retry:${row.userMessageID}`
    }
  }

  export function equals(a: TimelineRow, b: TimelineRow): boolean {
    if (a === b) return true
    if (a._tag !== b._tag || a.userMessageID !== b.userMessageID) return false

    // Common rows contain identities and presentation flags, not message bodies.
    // Avoid hashing each freshly projected tagged row on every stream update.
    switch (a._tag) {
      case "TurnGap":
      case "CommentStrip":
      case "Thinking":
      case "Retry":
        return true
      case "UserMessage":
        return b._tag === "UserMessage" && a.anchor === b.anchor
      case "TurnDivider":
        return b._tag === "TurnDivider" && a.label === b.label
      case "AssistantPart":
        return b._tag === "AssistantPart" &&
          a.previousAssistantPart === b.previousAssistantPart && samePartGroup(a.group, b.group)
      case "Error":
        return b._tag === "Error" && a.text === b.text
      case "PrimaryDelivery":
        return b._tag === "PrimaryDelivery" && a.assistantMessageID === b.assistantMessageID &&
          Equal.equals(a.delivery, b.delivery)
      case "DiffSummary":
        return b._tag === "DiffSummary" && Equal.equals(a.diffs, b.diffs)
    }
  }
}

function samePartGroup(a: PartGroup, b: PartGroup): boolean {
  if (a === b) return true
  if (a.key !== b.key || a.type !== b.type) return false
  if (a.type === "part") {
    return b.type === "part" && a.ref.messageID === b.ref.messageID && a.ref.partID === b.ref.partID
  }
  if (b.type === "part" || a.refs.length !== b.refs.length) return false
  for (let index = 0; index < a.refs.length; index++) {
    const left = a.refs[index]!
    const right = b.refs[index]!
    if (left.messageID !== right.messageID || left.partID !== right.partID) return false
  }
  return true
}
