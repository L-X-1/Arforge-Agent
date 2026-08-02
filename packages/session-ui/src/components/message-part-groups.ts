import type { Part as PartType, ToolPart } from "@arforge-ai/sdk/v2"

const CONTEXT_GROUP_TOOLS = new Set(["read", "glob", "grep", "list"])
const COMMAND_GROUP_TOOLS = new Set(["bash", "shell"])

export type PartRef = {
  messageID: string
  partID: string
}

export type PartGroup =
  | {
      key: string
      type: "part"
      ref: PartRef
    }
  | {
      key: string
      type: "context"
      refs: PartRef[]
    }
  | {
      key: string
      type: "commands"
      refs: PartRef[]
    }

function sameRef(a: PartRef, b: PartRef) {
  return a.messageID === b.messageID && a.partID === b.partID
}

function sameGroup(a: PartGroup, b: PartGroup) {
  if (a === b) return true
  if (a.key !== b.key) return false
  if (a.type !== b.type) return false
  if (a.type === "part") {
    if (b.type !== "part") return false
    return sameRef(a.ref, b.ref)
  }
  if (b.type !== a.type) return false
  if (a.refs.length !== b.refs.length) return false
  return a.refs.every((ref, i) => sameRef(ref, b.refs[i]!))
}

export function sameGroups(a: readonly PartGroup[] | undefined, b: readonly PartGroup[] | undefined) {
  if (a === b) return true
  if (!a || !b) return false
  if (a.length !== b.length) return false
  return a.every((item, i) => sameGroup(item, b[i]!))
}

export function isContextGroupTool(part: PartType): part is ToolPart {
  return part.type === "tool" && CONTEXT_GROUP_TOOLS.has(part.tool)
}

export function isCommandGroupTool(part: PartType): part is ToolPart {
  return part.type === "tool" && COMMAND_GROUP_TOOLS.has(part.tool)
}

export function groupParts(parts: { messageID: string; part: PartType }[]) {
  const result: PartGroup[] = []
  let start = -1
  let groupedType: "context" | "commands" | undefined

  const flush = (end: number) => {
    if (start < 0 || !groupedType) return
    const first = parts[start]
    const last = parts[end]
    if (!first || !last) {
      start = -1
      groupedType = undefined
      return
    }
    const refs = parts.slice(start, end + 1).map((item) => ({
      messageID: item.messageID,
      partID: item.part.id,
    }))
    if (groupedType === "commands" && refs.length === 1) {
      result.push({
        key: `part:${first.messageID}:${first.part.id}`,
        type: "part",
        ref: refs[0]!,
      })
      start = -1
      groupedType = undefined
      return
    }
    result.push({
      key: `${groupedType}:${first.part.id}`,
      type: groupedType,
      refs,
    })
    start = -1
    groupedType = undefined
  }

  parts.forEach((item, index) => {
    const nextType = isContextGroupTool(item.part) ? "context" : isCommandGroupTool(item.part) ? "commands" : undefined
    if (nextType) {
      if (start >= 0 && groupedType !== nextType) flush(index - 1)
      if (start < 0) {
        start = index
        groupedType = nextType
      }
      return
    }

    flush(index - 1)
    result.push({
      key: `part:${item.messageID}:${item.part.id}`,
      type: "part",
      ref: {
        messageID: item.messageID,
        partID: item.part.id,
      },
    })
  })

  flush(parts.length - 1)
  return result
}
