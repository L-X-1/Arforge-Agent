import { describe, expect, test } from "bun:test"
import type { PartGroup } from "@arforge-ai/session-ui/message-part"
import { Equal } from "effect"
import type { PrimaryDeliveryInfo } from "@/utils/primary-delivery"
import { reuseTimelineRows } from "./row-reconciliation"
import { TimelineRow, type SummaryDiff } from "./timeline-row"

const first = { messageID: "assistant-1", partID: "part-1" }
const second = { messageID: "assistant-1", partID: "part-2" }
const assistant = (group: PartGroup, previousAssistantPart = false, userMessageID = "user-1") =>
  new TimelineRow.AssistantPart({ userMessageID, group, previousAssistantPart })
const part = (): PartGroup => ({ type: "part", key: "part:1", ref: { ...first } })
const grouped = (type: "context" | "commands", refs = [first, second]): PartGroup => ({
  type, key: "group:1", refs: refs.map((ref) => ({ ...ref })),
})
const delivery = (): PrimaryDeliveryInfo => ({
  status: "normal", sentAt: 1, attachmentCount: 1, localOnly: true, uploaded: false,
  attachments: [{
    artifactID: "artifact-1", path: "C:/output/report.txt", displayName: "report.txt", mime: "text/plain",
    sizeBytes: 20, createdAt: 1, sha256: "original", source: "user_message", isImage: false,
  }],
})
const diff = (): SummaryDiff => ({ file: "src/main.ts", patch: "+initial", additions: 1, deletions: 0, status: "added" })
const delivered = (value: PrimaryDeliveryInfo, assistantMessageID = "assistant-1") =>
  new TimelineRow.PrimaryDelivery({ userMessageID: "user-1", assistantMessageID, delivery: value })
const summarized = (value: SummaryDiff[]) => new TimelineRow.DiffSummary({ userMessageID: "user-1", diffs: value })

const factories: { name: string; make: (userMessageID: string) => TimelineRow.TimelineRow }[] = [
  { name: "turn gap", make: (userMessageID) => new TimelineRow.TurnGap({ userMessageID }) },
  { name: "comment strip", make: (userMessageID) => new TimelineRow.CommentStrip({ userMessageID }) },
  { name: "user anchor", make: (userMessageID) => new TimelineRow.UserMessage({ userMessageID, anchor: true }) },
  { name: "turn divider", make: (userMessageID) => new TimelineRow.TurnDivider({ userMessageID, label: "compaction" }) },
  { name: "single part", make: (userMessageID) => assistant(part(), false, userMessageID) },
  { name: "context group", make: (userMessageID) => assistant(grouped("context"), false, userMessageID) },
  { name: "command group", make: (userMessageID) => assistant(grouped("commands"), false, userMessageID) },
  { name: "primary delivery", make: (userMessageID) => new TimelineRow.PrimaryDelivery({
    userMessageID, assistantMessageID: "assistant-1", delivery: delivery(),
  }) },
  { name: "thinking", make: (userMessageID) => new TimelineRow.Thinking({ userMessageID }) },
  { name: "diff summary", make: (userMessageID) => new TimelineRow.DiffSummary({ userMessageID, diffs: [diff()] }) },
  { name: "error", make: (userMessageID) => new TimelineRow.Error({ userMessageID, text: "Request failed" }) },
  { name: "retry", make: (userMessageID) => new TimelineRow.Retry({ userMessageID }) },
]

describe("timeline row equality", () => {
  test.each(factories)("preserves structural equality for $name", ({ make }) => {
    const a = make("user-1")
    const b = make("user-1")
    expect(TimelineRow.equals(a, b)).toBe(true)
    expect(TimelineRow.equals(a, b)).toBe(Equal.equals(a, b))
    expect(TimelineRow.equals(b, a)).toBe(true)
    expect(TimelineRow.equals(a, a)).toBe(true)
  })

  test.each(factories)("never reuses $name across user messages", ({ make }) => {
    expect(TimelineRow.equals(make("user-1"), make("user-2"))).toBe(false)
  })

  test.each([
    { name: "row kind", a: new TimelineRow.TurnGap({ userMessageID: "user-1" }), b: new TimelineRow.CommentStrip({ userMessageID: "user-1" }) },
    { name: "anchor", a: new TimelineRow.UserMessage({ userMessageID: "user-1", anchor: true }), b: new TimelineRow.UserMessage({ userMessageID: "user-1", anchor: false }) },
    { name: "divider", a: new TimelineRow.TurnDivider({ userMessageID: "user-1", label: "compaction" }), b: new TimelineRow.TurnDivider({ userMessageID: "user-1", label: "interrupted" }) },
    { name: "error text", a: new TimelineRow.Error({ userMessageID: "user-1", text: "first" }), b: new TimelineRow.Error({ userMessageID: "user-1", text: "second" }) },
    { name: "assistant spacing", a: assistant(part()), b: assistant(part(), true) },
    { name: "group key", a: assistant(part()), b: assistant({ ...part(), key: "part:2" }) },
    { name: "part owner", a: assistant(part()), b: assistant({ type: "part", key: "part:1", ref: { ...first, messageID: "assistant-2" } }) },
    { name: "part identity", a: assistant(part()), b: assistant({ type: "part", key: "part:1", ref: second }) },
    { name: "group kind", a: assistant(grouped("context")), b: assistant(grouped("commands")) },
    { name: "single versus grouped", a: assistant(part()), b: assistant({ type: "context", key: "part:1", refs: [first] }) },
    { name: "context append", a: assistant(grouped("context", [first])), b: assistant(grouped("context")) },
    { name: "context removal", a: assistant(grouped("context")), b: assistant(grouped("context", [second])) },
    { name: "context order", a: assistant(grouped("context")), b: assistant(grouped("context", [second, first])) },
    { name: "context owner", a: assistant(grouped("context", [first])), b: assistant(grouped("context", [{ ...first, messageID: "assistant-2" }])) },
    { name: "command append", a: assistant(grouped("commands", [first])), b: assistant(grouped("commands")) },
    { name: "command order", a: assistant(grouped("commands")), b: assistant(grouped("commands", [second, first])) },
    { name: "delivery owner", a: delivered(delivery()), b: delivered(delivery(), "assistant-2") },
  ])("detects changes to $name", ({ a, b }) => {
    expect(TimelineRow.equals(a, b)).toBe(false)
    expect(TimelineRow.equals(b, a)).toBe(false)
    expect(TimelineRow.equals(a, b)).toBe(Equal.equals(a, b))
  })

  test.each([
    { name: "status", change: (value: PrimaryDeliveryInfo) => { value.status = "proactive" } },
    { name: "timestamp", change: (value: PrimaryDeliveryInfo) => { value.sentAt = 2 } },
    { name: "attachment list", change: (value: PrimaryDeliveryInfo) => { value.attachments.push({ ...value.attachments[0]!, artifactID: "artifact-2" }); value.attachmentCount++ } },
    { name: "attachment path", change: (value: PrimaryDeliveryInfo) => { value.attachments[0]!.path = "C:/output/new.txt" } },
    { name: "attachment name", change: (value: PrimaryDeliveryInfo) => { value.attachments[0]!.displayName = "new.txt" } },
    { name: "attachment content", change: (value: PrimaryDeliveryInfo) => { value.attachments[0]!.sha256 = "updated" } },
    { name: "attachment size", change: (value: PrimaryDeliveryInfo) => { value.attachments[0]!.sizeBytes = 30 } },
    { name: "attachment MIME", change: (value: PrimaryDeliveryInfo) => { value.attachments[0]!.mime = "text/markdown" } },
    { name: "attachment image mode", change: (value: PrimaryDeliveryInfo) => { value.attachments[0]!.isImage = true } },
  ])("preserves deep delivery updates to $name", ({ change }) => {
    const next = delivery()
    change(next)
    const a = delivered(delivery())
    const b = delivered(next)
    expect(TimelineRow.equals(a, b)).toBe(false)
    expect(TimelineRow.equals(a, b)).toBe(Equal.equals(a, b))
  })

  test.each([
    { file: "src/other.ts" }, { patch: "+updated" }, { additions: 2 }, { deletions: 1 }, { status: "modified" as const },
  ])("preserves every diff summary field: %j", (change) => {
    const a = summarized([diff()])
    const b = summarized([{ ...diff(), ...change }])
    expect(TimelineRow.equals(a, b)).toBe(false)
    expect(TimelineRow.equals(a, b)).toBe(Equal.equals(a, b))
  })

  test("preserves attachment and diff ordering", () => {
    const firstDelivery = delivery()
    firstDelivery.attachments.push({ ...firstDelivery.attachments[0]!, artifactID: "artifact-2" })
    firstDelivery.attachmentCount = 2
    expect(TimelineRow.equals(delivered(firstDelivery), delivered({
      ...firstDelivery, attachments: [...firstDelivery.attachments].reverse(),
    }))).toBe(false)
    const diffs = [diff(), { ...diff(), file: "src/other.ts" }]
    expect(TimelineRow.equals(summarized(diffs), summarized([...diffs].reverse()))).toBe(false)
  })

  test("compares common rows without generic object traversal or equality hooks", () => {
    const fields = new Set(["_tag", "userMessageID", "anchor", "label", "group", "previousAssistantPart", "text"])
    for (const { make } of factories) {
      const row = make("user-1")
      if (row._tag === "DiffSummary" || row._tag === "PrimaryDelivery") continue
      const guarded = new Proxy(row, {
        ownKeys() { throw new Error("Generic row traversal is not allowed") },
        get(target, key, receiver) {
          if (typeof key !== "string" || !fields.has(key)) throw new Error("Unexpected equality hook or field")
          return Reflect.get(target, key, receiver)
        },
      })
      expect(TimelineRow.equals(guarded, make("user-1"))).toBe(true)
    }
  })

  test("reuses every unchanged history row and the original array", () => {
    const previous = history()
    expect(reuseTimelineRows(previous, history())).toBe(previous)
  })

  test("a streaming context update preserves 320 historical turns and its stable key", () => {
    const previous = history()
    const next = history()
    next[next.length - 1] = assistant(grouped("context", [first, second]), false, "user-current")
    const reused = reuseTimelineRows(previous, next)
    expect(reused).not.toBe(previous)
    for (let index = 0; index < previous.length - 1; index++) expect(reused[index]).toBe(previous[index])
    expect(reused.at(-1)).not.toBe(previous.at(-1))
    expect(TimelineRow.key(reused.at(-1)!)).toBe(TimelineRow.key(previous.at(-1)!))
  })
})

function history(): TimelineRow.TimelineRow[] {
  const rows: TimelineRow.TimelineRow[] = []
  for (let index = 0; index < 320; index++) {
    const userMessageID = `user-${index}`
    rows.push(new TimelineRow.UserMessage({ userMessageID, anchor: true }))
    rows.push(assistant({
      type: "part", key: `part:${index}`, ref: { messageID: `assistant-${index}`, partID: `part-${index}` },
    }, false, userMessageID))
  }
  rows.push(assistant(grouped("context", [first]), false, "user-current"))
  return rows
}
