import { describe, expect, test } from "bun:test"
import { sessionOperationsText } from "./session-operations-text"

describe("Session control center copy", () => {
  test("uses user-facing Chinese for the primary navigation and safety boundary", () => {
    expect(sessionOperationsText.zh).toMatchObject({
      title: "会话控制中心",
      goalTask: "目标与任务",
      promptQueue: "待发送消息",
      checkpointRewind: "检查点与对话回退",
    })
    expect(sessionOperationsText.zh.checkpointDescription).toContain("不会撤销")
    expect(Object.values(sessionOperationsText.zh).join(" ")).not.toMatch(/Goal|Task|Prompt Queue|Rewind/)
  })

  test("keeps the same concepts available in Traditional Chinese", () => {
    expect(sessionOperationsText.zht).toMatchObject({
      goalTask: "目標與任務",
      promptQueue: "待傳送訊息",
      checkpointRewind: "檢查點與對話回退",
    })
    expect(sessionOperationsText.zht.checkpointDescription).toContain("不會復原")
  })
})
