import type { SessionMessageInfo } from "@arforge-ai/client/promise"
import type { AssistantMessage, Message, Part, SessionStatus, UserMessage } from "@arforge-ai/sdk/v2"
import { createMemo, mapArray, type Accessor } from "solid-js"
import { reuseTimelineRows } from "./row-reconciliation"
import { Timeline, TimelineRow } from "./rows"

export { reuseTimelineRows } from "./row-reconciliation"

export function createTimelineProjection(input: {
  messages: Accessor<Message[]>
  userMessages: Accessor<UserMessage[]>
  sessionMessages: Accessor<SessionMessageInfo[]>
  parts: (messageID: string) => Part[]
  status: Accessor<SessionStatus>
  showReasoningSummaries: Accessor<boolean>
  inlineComments: Accessor<boolean>
}) {
  const messageByID = createMemo(() => new Map(input.messages().map((message) => [message.id, message] as const)))
  const assistantMessagesByParent = createMemo(() => {
    const result = new Map<string, AssistantMessage[]>()
    input.messages().forEach((message) => {
      if (message.role !== "assistant") return
      const messages = result.get(message.parentID)
      if (messages) {
        messages.push(message)
        return
      }
      result.set(message.parentID, [message])
    })
    return result
  })
  const projection = createMemo(() =>
    Timeline.constructSessionTurns(
      input.sessionMessages(),
      (messageID) => messageByID().get(messageID) as UserMessage | AssistantMessage | undefined,
      input.userMessages(),
    ),
  )
  const activeMessageID = createMemo(() => projection().activeMessageID)
  const turnByID = createMemo(() => new Map(projection().turns.map((turn) => [turn.user.id, turn] as const)))
  // Keyed owners survive membership refreshes and are disposed when turns leave.
  // Each row memo tracks only its own parts instead of every historical part.
  const turnRows = mapArray(
    () => projection().turns.map((turn) => turn.user.id),
    (userMessageID, index) => {
      const turn = createMemo(() => turnByID().get(userMessageID), undefined, { equals: sameTurn })
      const active = createMemo(() => activeMessageID() === userMessageID)
      return createMemo((previous: TimelineRow.TimelineRow[] | undefined) => {
        const current = turn()
        // A removed turn can become unavailable before its keyed owner disposes.
        if (!current) return []
        return reuseTimelineRows(previous, Timeline.constructMessageRows(
          current.user,
          input.parts,
          current.assistants,
          index(),
          input.showReasoningSummaries(),
          input.status().type,
          active(),
          input.inlineComments(),
          current.deliveries,
        ))
      })
    },
  )
  const rows = createMemo((previous: TimelineRow.TimelineRow[] | undefined) =>
    reuseTimelineRows(previous, turnRows().flatMap((rows) => rows())),
  )
  const rowByKey = createMemo(() => new Map(rows().map((row) => [TimelineRow.key(row), row] as const)))
  const messageRowIndex = createMemo(() => {
    const result = new Map<string, number>()
    rows().forEach((row, index) => {
      if (!("userMessageID" in row) || result.has(row.userMessageID)) return
      result.set(row.userMessageID, index)
    })
    return result
  })
  const messageLastRowIndex = createMemo(() => {
    const result = new Map<string, number>()
    rows().forEach((row, index) => {
      if ("userMessageID" in row) result.set(row.userMessageID, index)
    })
    return result
  })
  const lastAssistantGroupKey = createMemo(() => {
    const result = new Map<string, string>()
    rows().forEach((row) => {
      if (row._tag === "AssistantPart") result.set(row.userMessageID, row.group.key)
    })
    return result
  })

  return {
    activeMessageID,
    assistantMessagesByParent,
    lastAssistantGroupKey,
    messageByID,
    messageRowIndex,
    messageLastRowIndex,
    rowByKey,
    rows,
  }
}

function sameTurn(a: Timeline.Turn | undefined, b: Timeline.Turn | undefined): boolean {
  if (a === b) return true
  if (!a || !b || a.user !== b.user) return false
  if (a.assistants.length !== b.assistants.length || a.deliveries.length !== b.deliveries.length) return false
  for (let index = 0; index < a.assistants.length; index++) {
    if (a.assistants[index] !== b.assistants[index]) return false
  }
  for (let index = 0; index < a.deliveries.length; index++) {
    const left = a.deliveries[index]!
    const right = b.deliveries[index]!
    if (left.assistantMessageID !== right.assistantMessageID || left.delivery !== right.delivery) return false
  }
  return true
}
