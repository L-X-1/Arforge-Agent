import { describe, expect, test } from "bun:test"
import type { Part } from "@arforge-ai/sdk/v2"
import { groupParts } from "./message-part-groups"

function tool(id: string, name: string) {
  return {
    id,
    type: "tool",
    tool: name,
    state: {
      status: "completed",
      input: {},
      output: "",
      title: name,
      time: { start: 1, end: 2 },
    },
  } as unknown as Part
}

describe("message part activity grouping", () => {
  test("groups consecutive shell commands into one collapsible activity row", () => {
    const groups = groupParts([
      { messageID: "m1", part: tool("p1", "bash") },
      { messageID: "m1", part: tool("p2", "shell") },
    ])

    expect(groups).toEqual([
      {
        key: "commands:p1",
        type: "commands",
        refs: [
          { messageID: "m1", partID: "p1" },
          { messageID: "m1", partID: "p2" },
        ],
      },
    ])
  })

  test("keeps a single shell command as a normal tool row", () => {
    const groups = groupParts([{ messageID: "m1", part: tool("p1", "bash") }])

    expect(groups).toEqual([
      {
        key: "part:m1:p1",
        type: "part",
        ref: { messageID: "m1", partID: "p1" },
      },
    ])
  })

  test("does not merge command activity with context exploration", () => {
    const groups = groupParts([
      { messageID: "m1", part: tool("p1", "read") },
      { messageID: "m1", part: tool("p2", "bash") },
      { messageID: "m1", part: tool("p3", "bash") },
    ])

    expect(groups.map((group) => group.type)).toEqual(["context", "commands"])
  })
})
