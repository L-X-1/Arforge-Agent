import { describe, expect, test } from "bun:test"
import {
  clampSessionArchiveOffset,
  SESSION_ARCHIVE_REVEAL_PX,
  shouldRevealSessionArchive,
} from "./sidebar-swipe"

describe("sidebar session archive swipe", () => {
  test("clamps direct manipulation to the reveal track", () => {
    expect(clampSessionArchiveOffset(0, -18)).toBe(-18)
    expect(clampSessionArchiveOffset(0, -80)).toBe(-SESSION_ARCHIVE_REVEAL_PX)
    expect(clampSessionArchiveOffset(-SESSION_ARCHIVE_REVEAL_PX, 80)).toBe(0)
  })

  test("settles by distance when the release is slow", () => {
    expect(shouldRevealSessionArchive(-23, 0)).toBe(true)
    expect(shouldRevealSessionArchive(-21, 0)).toBe(false)
  })

  test("honors a deliberate flick in either direction", () => {
    expect(shouldRevealSessionArchive(-8, -0.4)).toBe(true)
    expect(shouldRevealSessionArchive(-40, 0.4)).toBe(false)
  })
})
