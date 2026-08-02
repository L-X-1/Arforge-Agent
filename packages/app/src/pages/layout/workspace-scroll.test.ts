import { describe, expect, test } from "bun:test"
import { workspaceRevealDelta } from "./workspace-scroll"

describe("workspace reveal scroll geometry", () => {
  test("does not move a fully visible expanded workspace", () => {
    expect(
      workspaceRevealDelta({
        containerTop: 100,
        containerBottom: 600,
        headerTop: 400,
        targetBottom: 580,
        inset: 8,
      }),
    ).toBe(0)
  })

  test("scrolls only by the amount hidden below the bottom inset", () => {
    expect(
      workspaceRevealDelta({
        containerTop: 100,
        containerBottom: 600,
        headerTop: 400,
        targetBottom: 632,
        inset: 8,
      }),
    ).toBe(40)
  })

  test("keeps the workspace header visible when the content is taller than the viewport", () => {
    expect(
      workspaceRevealDelta({
        containerTop: 100,
        containerBottom: 600,
        headerTop: 180,
        targetBottom: 900,
        inset: 8,
      }),
    ).toBe(72)
  })

  test("does not force scroll when the header is already at the top inset", () => {
    expect(
      workspaceRevealDelta({
        containerTop: 100,
        containerBottom: 600,
        headerTop: 108,
        targetBottom: 700,
        inset: 8,
      }),
    ).toBe(0)
  })
})
