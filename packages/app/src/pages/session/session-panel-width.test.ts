import { describe, expect, test } from "bun:test"
import {
  clampSessionPanelWidth,
  REVIEW_PANE_WIDTH_MIN,
  REVIEW_PANE_WIDTH_MIN_COMPACT,
  REVIEW_PANE_WIDTH_MIN_SPLIT,
  SESSION_PANEL_RESIZE_RANGE_MIN,
  SESSION_PANEL_WIDTH_MIN,
  SESSION_PANEL_WIDTH_MIN_COMPACT,
  sessionPanelWidthBounds,
  sessionPanelWidthMin,
  sessionPanelWidthMax,
} from "./session-panel-width"

describe("sessionPanelWidthMax", () => {
  test("reserves the unified review pane minimum", () => {
    expect(sessionPanelWidthMax({ available: 1700, split: false })).toBe(1700 - REVIEW_PANE_WIDTH_MIN)
  })

  test("reserves a larger minimum for split diffs", () => {
    expect(sessionPanelWidthMax({ available: 1700, split: true })).toBe(1700 - REVIEW_PANE_WIDTH_MIN_SPLIT)
    expect(REVIEW_PANE_WIDTH_MIN_SPLIT).toBeGreaterThan(REVIEW_PANE_WIDTH_MIN)
  })

  test("lets the chat panel take everything beyond the review pane minimum", () => {
    // Regression: the old cap was 45% of the window, forcing the review pane
    // to at least 55% of the window regardless of content.
    const available = 3440
    expect(sessionPanelWidthMax({ available, split: false })).toBeGreaterThan(available * 0.45)
  })

  test("keeps a useful resize range in the compact split layout from the reported video", () => {
    const bounds = sessionPanelWidthBounds({ available: 1215, split: true })
    expect(bounds).toEqual({ min: SESSION_PANEL_WIDTH_MIN, max: SESSION_PANEL_WIDTH_MIN + 240 })
    expect(bounds.max - bounds.min).toBe(SESSION_PANEL_RESIZE_RANGE_MIN)
    expect(1215 - bounds.max).toBeGreaterThanOrEqual(REVIEW_PANE_WIDTH_MIN_COMPACT)
  })

  test("relaxes the chat minimum only when both preferred panes cannot fit", () => {
    const bounds = sessionPanelWidthBounds({ available: 930, split: true })
    expect(bounds).toEqual({ min: 330, max: 570 })
    expect(sessionPanelWidthMin({ available: 930, split: true })).toBe(330)
    expect(bounds.max - bounds.min).toBe(SESSION_PANEL_RESIZE_RANGE_MIN)
  })

  test("uses compact floors only when the window cannot provide a full resize range", () => {
    expect(sessionPanelWidthBounds({ available: 700, split: true })).toEqual({
      min: SESSION_PANEL_WIDTH_MIN_COMPACT,
      max: 340,
    })
    expect(sessionPanelWidthBounds({ available: 600, split: true })).toEqual({
      min: SESSION_PANEL_WIDTH_MIN_COMPACT,
      max: SESSION_PANEL_WIDTH_MIN_COMPACT,
    })
  })
})

describe("clampSessionPanelWidth", () => {
  test("keeps widths already within the limit", () => {
    expect(clampSessionPanelWidth({ width: 800, available: 1700, split: false })).toBe(800)
  })

  test("forces the width down when the window shrinks", () => {
    expect(clampSessionPanelWidth({ width: 1600, available: 1700, split: false })).toBe(1700 - REVIEW_PANE_WIDTH_MIN)
    expect(clampSessionPanelWidth({ width: 1600, available: 1700, split: true })).toBe(
      1700 - REVIEW_PANE_WIDTH_MIN_SPLIT,
    )
  })

  test("clamps into compact bounds when there is no room for both preferred panes", () => {
    expect(clampSessionPanelWidth({ width: 1600, available: 700, split: true })).toBe(340)
    expect(clampSessionPanelWidth({ width: 100, available: 930, split: true })).toBe(330)
  })

  test("skips clamping before the layout is measured", () => {
    expect(clampSessionPanelWidth({ width: 1600, available: undefined, split: false })).toBe(1600)
  })
})
