import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { mappedCapabilityMethods } from "./control-center-map"
import { reviewedUiCapabilityMethods, UI_CAPABILITY_REVIEW } from "./ui-capability-review"

function generatedClientMethods() {
  const source = readFileSync(resolve(import.meta.dir, "../../../client/src/generated/client.ts"), "utf8")
  const methods: string[] = []
  let group = ""
  for (const line of source.split(/\r?\n/)) {
    const groupMatch = /^    ([A-Za-z][A-Za-z0-9]*): \{$/.exec(line)
    if (groupMatch) {
      group = groupMatch[1]!
      continue
    }
    const methodMatch = /^      ([A-Za-z][A-Za-z0-9]*): \(/.exec(line)
    if (group && methodMatch) methods.push(`${group}.${methodMatch[1]}`)
  }
  return methods
}

describe("Scheme B capability mapping", () => {
  test("classifies every generated Server API method exactly once", () => {
    const generated = generatedClientMethods().sort()
    const mapped = mappedCapabilityMethods().sort()
    const duplicate = mapped.filter((method, index) => mapped.indexOf(method) !== index)

    expect(duplicate).toEqual([])
    expect(mapped as string[]).toEqual(generated)
  })

  test("keeps every indirect UI method in one evidence-backed manual review row", () => {
    const generated = new Set(generatedClientMethods())
    const reviewed = reviewedUiCapabilityMethods()
    const duplicate = reviewed.filter((method, index) => reviewed.indexOf(method) !== index)

    expect(duplicate).toEqual([])
    expect(reviewed.filter((method) => !generated.has(method))).toEqual([])
    expect(UI_CAPABILITY_REVIEW.map((entry) => String(entry.disposition))).not.toContain("ui-gap")

    const root = resolve(import.meta.dir, "../../../..")
    for (const entry of UI_CAPABILITY_REVIEW) {
      for (const file of entry.evidence) {
        expect(() => readFileSync(resolve(root, file), "utf8")).not.toThrow()
      }
    }
  })

  test("keeps the governed memory candidate lifecycle reachable through the Personal Workspace", () => {
    const review = UI_CAPABILITY_REVIEW.find((entry) => entry.id === "memory-candidate-review-adapter")

    expect(review?.disposition).toBe("semantic-ui")
    expect(review?.methods).toEqual([
      "memories.candidateReview",
      "memories.candidateApprove",
      "memories.candidateReject",
      "memories.candidateActivate",
    ])
  })
})
