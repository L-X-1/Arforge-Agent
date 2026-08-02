import { describe, expect, test } from "bun:test"
import { classify, scanText, summarize, type Policy } from "../../../script/brand-audit"

const policy: Policy = {
  terms: [{ id: "legacy-product", pattern: "\\barforge\\b" }],
  excludeDirectories: [],
  auditArtifacts: ["specs/brand-policy.json"],
  finalBudgets: {
    product: 0,
    distribution: 0,
    generated: 0,
    fixture: 0,
    compatibility: 0,
    legal: 100,
    audit: 100,
  },
}

describe("brand audit", () => {
  test("classifies legal, generated, fixture, distribution, audit, and product surfaces", () => {
    expect(classify("LICENSE", policy)).toBe("legal")
    expect(classify("src/generated/client.ts", policy)).toBe("generated")
    expect(classify("test/client.test.ts", policy)).toBe("fixture")
    expect(classify("packages/app/package.json", policy)).toBe("distribution")
    expect(classify("specs/brand-policy.json", policy)).toBe("audit")
    expect(classify("packages/app/src/header.tsx", policy)).toBe("product")
  })

  test("counts every case-insensitive content occurrence", () => {
    const findings = scanText("src/header.ts", "Arforge and arforge\nnothing", policy)
    expect(findings).toEqual([
      {
        term: "legacy-product",
        category: "product",
        file: "src/header.ts",
        line: 1,
        source: "content",
        count: 2,
      },
    ])
    expect(summarize(findings).totals).toEqual({ "legacy-product": 2 })
  })
})
