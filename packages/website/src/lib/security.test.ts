import { describe, expect, test } from "bun:test"
import { publicWindowsRelease, safeReturnPath, type WindowsRelease } from "./security"

const validRelease: WindowsRelease = {
  channel: "public-beta",
  available: true,
  version: "1.0.0-beta.1",
  architecture: "x64",
  fileName: "Arforge-1.0.0-beta.1-x64.exe",
  downloadUrl: "https://downloads.arforgeagent.com/windows/1.0.0-beta.1/Arforge-1.0.0-beta.1-x64.exe",
  sizeBytes: 1024,
  publishedAt: "2026-08-03T00:00:00.000Z",
  signed: true,
  sha256: "a".repeat(64),
  acceptancePassed: true,
}

describe("safeReturnPath", () => {
  test("keeps same-origin relative paths", () => expect(safeReturnPath("/app/?device=one#session")).toBe("/app/?device=one#session"))
  test("rejects protocol-relative and backslash paths", () => {
    expect(safeReturnPath("//evil.example/path")).toBe("/app/")
    expect(safeReturnPath("/\\evil.example/path")).toBe("/app/")
  })
  test("rejects absolute external URLs", () => expect(safeReturnPath("https://evil.example/")).toBe("/app/"))
})

describe("publicWindowsRelease", () => {
  test("accepts a fully signed and verified manifest", () => expect(publicWindowsRelease(validRelease)).toBe(true))
  test("fails closed for unsigned or unaccepted builds", () => {
    expect(publicWindowsRelease({ ...validRelease, signed: false })).toBe(false)
    expect(publicWindowsRelease({ ...validRelease, acceptancePassed: false })).toBe(false)
  })
  test("rejects external URLs and invalid hashes", () => {
    expect(publicWindowsRelease({ ...validRelease, downloadUrl: "https://evil.example/file.exe" })).toBe(false)
    expect(publicWindowsRelease({ ...validRelease, sha256: "not-a-hash" })).toBe(false)
  })
})
