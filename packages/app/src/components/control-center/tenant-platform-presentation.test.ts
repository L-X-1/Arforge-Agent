import { describe, expect, test } from "bun:test"
import { formatTenantTime, shortDigest, tenantDataKindLabel, tenantStatusLabel } from "./tenant-platform-presentation"

describe("tenant platform presentation", () => {
  test("localizes administrative statuses and data-rights kinds", () => {
    expect(tenantStatusLabel("verified", "zh")).toBe("已校验")
    expect(tenantStatusLabel("verified", "zht")).toBe("已驗證")
    expect(tenantStatusLabel("verified", "en")).toBe("Verified")
    expect(tenantDataKindLabel("tenant-delete", "zh")).toBe("租户数据删除")
    expect(tenantDataKindLabel("tenant-delete", "zht")).toBe("租戶資料刪除")
  })

  test("keeps long evidence digests readable without hiding their identity", () => {
    const digest = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    expect(shortDigest(digest)).toBe("0123456789ab…456789abcdef")
    expect(shortDigest(digest, 8)).toBe("01234567…89abcdef")
  })

  test("formats invalid or missing timestamps safely", () => {
    expect(formatTenantTime(undefined, "zh")).toBe("—")
    expect(formatTenantTime("not-a-date", "en")).toBe("—")
    expect(formatTenantTime("2026-01-02T03:04:05.000Z", "en")).toMatch(/2026/)
  })
})
