import { describe, expect, test } from "bun:test"
import {
  contractAuditBoundaryLabel,
  contractAuditEffect,
  contractAuditEvidenceLabel,
  contractAuditMissingLabel,
  contractAuditRequirementLabel,
  contractAuditStatus,
  contractAuditTitle,
  isContractAuditSectionID,
  parseExecutionBoundary,
  parseContractAudit,
} from "./contract-audit-presentation"
import type { Locale } from "@/context/language"

const report = {
  execution_mode: "read-only-feature-policy-contract-audit",
  status: "not_ready",
  ready: false,
  side_effects: "none",
  writes: 0,
  missing_requirements: ["transactional_update", "audit_evidence"],
  caveat: "No legacy writer is opened.",
  execution_boundary: {
    mode: "read-only",
    writes: false,
    repairs_recovery: false,
    provider_execution_allowed: false,
    creates_profile_state: false,
    creates_settlement_state: false,
  },
} as const

const supportedLocales = [
  "en",
  "zh",
  "zht",
  "ko",
  "de",
  "es",
  "fr",
  "da",
  "ja",
  "pl",
  "ru",
  "uk",
  "ar",
  "no",
  "br",
  "th",
  "bs",
  "tr",
] as const satisfies readonly Locale[]

describe("contract audit presentation", () => {
  test("parses only complete structured audits", () => {
    expect(parseContractAudit(report)).toEqual(report)
    const parsedWithoutBoundary = parseContractAudit({ ...report, execution_boundary: undefined })
    expect(parsedWithoutBoundary).toMatchObject({
      execution_mode: report.execution_mode,
      status: report.status,
      ready: report.ready,
    })
    expect(parsedWithoutBoundary?.execution_boundary).toBeUndefined()
    const parsedWithUnknownBoundaryField = parseContractAudit({
      ...report,
      execution_boundary: { ...report.execution_boundary, extra: "ignored" },
    })
    expect(parsedWithUnknownBoundaryField?.execution_boundary).toEqual(report.execution_boundary)
    expect(Object.keys(parsedWithUnknownBoundaryField?.execution_boundary ?? {})).not.toContain("extra")
    expect(parseContractAudit({ ...report, writes: "0" })).toBeUndefined()
    expect(parseContractAudit({ ...report, writes: 0.5 })).toBeUndefined()
    expect(parseContractAudit({ ...report, writes: Number.MAX_SAFE_INTEGER + 1 })).toBeUndefined()
    expect(parseContractAudit({ ...report, missing_requirements: [1] })).toBeUndefined()
    expect(
      parseContractAudit({ ...report, execution_boundary: { ...report.execution_boundary, writes: true } }),
    ).toBeUndefined()
  })

  test("localizes policy titles and safe status/effect summaries", () => {
    expect(isContractAuditSectionID("feature-policy-contract")).toBe(true)
    expect(isContractAuditSectionID("permission-rules")).toBe(false)
    expect(contractAuditTitle("feature-policy-contract", "zh")).toBe("功能策略迁移")
    expect(contractAuditTitle("permission-policy-contract", "zht")).toBe("權限策略遷移")
    expect(contractAuditStatus(report, "zh")).toBe("尚未完成（fail-closed）")
    expect(contractAuditStatus({ status: "ready", ready: true }, "en")).toBe("Ready")
    expect(contractAuditEffect(report, "zht")).toBe("唯讀 · 不寫入")
    expect(contractAuditMissingLabel(report.missing_requirements.length, "zh")).toBe("尚缺要求（2）")
    expect(contractAuditEvidenceLabel("en")).toBe("Advanced evidence")
    expect(contractAuditRequirementLabel("typed_rule_schema", "zh")).toBe("类型化规则结构")
    expect(contractAuditRequirementLabel("workspace_identity_binding", "zht")).toBe("工作區與身分綁定")
    expect(contractAuditRequirementLabel("unknown_requirement", "en")).toBe("Additional migration requirement")
    expect(parseExecutionBoundary(report.execution_boundary)).toEqual(report.execution_boundary)
    expect(contractAuditBoundaryLabel(report.execution_boundary, "zh")).toContain("只读")
    expect(contractAuditBoundaryLabel(report.execution_boundary, "zht")).toContain("唯讀")
    expect(contractAuditBoundaryLabel(undefined, "zh")).toContain("不可用")
    expect(contractAuditBoundaryLabel(undefined, "zht")).toContain("不可用")
    expect(contractAuditBoundaryLabel(undefined, "en")).toContain("unavailable")
    expect(parseExecutionBoundary({ ...report.execution_boundary, provider_execution_allowed: true })).toBeUndefined()
  })

  test("keeps contract summaries understandable across every supported locale", () => {
    for (const locale of supportedLocales) {
      const requirement = contractAuditRequirementLabel("typed_rule_schema", locale)
      expect(requirement).toBeTruthy()
      expect(requirement).not.toContain("typed_rule_schema")
      expect(contractAuditTitle("file-state", locale)).toBeTruthy()
      expect(contractAuditStatus(report, locale)).toBeTruthy()
      expect(contractAuditEffect(report, locale)).toBeTruthy()
      expect(contractAuditMissingLabel(report.missing_requirements.length, locale)).toBeTruthy()
      expect(contractAuditEvidenceLabel(locale)).toBeTruthy()
      expect(contractAuditBoundaryLabel(report.execution_boundary, locale)).toBeTruthy()
      expect(contractAuditBoundaryLabel(undefined, locale)).toBeTruthy()
    }
  })
})
