import { describe, expect, test } from "bun:test"
import {
  diagnosisModeHint,
  diagnosisModeLabel,
  diagnosisSeverityLabel,
  diagnosisStatusLabel,
} from "./diagnostics-presentation"

describe("diagnostics presentation", () => {
  test("keeps mode labels understandable for each supported locale", () => {
    expect(diagnosisModeLabel("error", "en")).toBe("Error / document")
    expect(diagnosisModeLabel("frontend", "zh")).toBe("前端 HTML / Vue")
    expect(diagnosisModeLabel("javascript", "zht")).toBe("JavaScript")
  })

  test("maps deterministic outcomes and severities to user-facing text", () => {
    expect(diagnosisStatusLabel(true, "zh")).toBe("检查通过")
    expect(diagnosisStatusLabel(false, "en")).toBe("Review findings")
    expect(diagnosisSeverityLabel("error", "zht")).toBe("錯誤")
    expect(diagnosisSeverityLabel("info", "en")).toBe("Info")
  })

  test("explains the selected mode before a user runs it", () => {
    expect(diagnosisModeHint("frontend", "zh")).toContain("挂载目标")
    expect(diagnosisModeHint("javascript", "en")).toContain("delimiters")
  })
})
