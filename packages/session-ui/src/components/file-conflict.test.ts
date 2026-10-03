import { describe, expect, test } from "bun:test"
import { parseFileConflict, shortVersion } from "./file-conflict"

describe("parseFileConflict", () => {
  test("reads the canonical stale-version metadata", () => {
    expect(
      parseFileConflict({
        kind: "file_conflict",
        code: "observed_version_mismatch",
        path: "src/example.ts",
        observedVersion: "a".repeat(64),
        currentVersion: "b".repeat(64),
      }),
    ).toEqual({
      kind: "file_conflict",
      code: "observed_version_mismatch",
      path: "src/example.ts",
      observedVersion: "a".repeat(64),
      currentVersion: "b".repeat(64),
    })
  })

  test("accepts an adapter nested conflict payload", () => {
    expect(parseFileConflict({ conflict: { kind: "file_conflict", code: "target_exists", path: "new.ts" } })).toEqual(
      {
        kind: "file_conflict",
        code: "target_exists",
        path: "new.ts",
      },
    )
  })

  test("ignores malformed or unrelated metadata", () => {
    expect(parseFileConflict(undefined)).toBeUndefined()
    expect(parseFileConflict({ kind: "other", code: "target_exists", path: "new.ts" })).toBeUndefined()
    expect(parseFileConflict({ kind: "file_conflict", code: "unknown", path: "new.ts" })).toBeUndefined()
    expect(parseFileConflict({ kind: "file_conflict", code: "target_exists" })).toBeUndefined()
  })
})

test("shortVersion keeps the timeline compact", () => {
  expect(shortVersion("a".repeat(64))).toBe(`${"a".repeat(12)}…`)
  expect(shortVersion(undefined)).toBeUndefined()
})
