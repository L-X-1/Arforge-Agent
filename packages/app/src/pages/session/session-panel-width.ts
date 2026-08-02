// The review pane has no width of its own: it takes whatever the chat panel
// leaves behind. Wide windows honor the preferred pane reserves below. Compact
// windows relax both panes toward usable floors while preserving an actual drag
// range instead of collapsing the handle to min === max.
export const SESSION_PANEL_WIDTH_MIN = 450
export const SESSION_PANEL_WIDTH_MIN_COMPACT = 320
export const REVIEW_PANE_WIDTH_MIN = 480
export const REVIEW_PANE_WIDTH_MIN_COMPACT = 360
export const REVIEW_PANE_WIDTH_MIN_SPLIT = 800
export const SESSION_PANEL_RESIZE_RANGE_MIN = 240

export function sessionPanelWidthBounds(input: { available: number; split: boolean }) {
  const available = Math.max(0, input.available)
  const preferredPane = input.split ? REVIEW_PANE_WIDTH_MIN_SPLIT : REVIEW_PANE_WIDTH_MIN
  const paneReserve = Math.min(
    preferredPane,
    Math.max(
      REVIEW_PANE_WIDTH_MIN_COMPACT,
      available - SESSION_PANEL_WIDTH_MIN - SESSION_PANEL_RESIZE_RANGE_MIN,
    ),
  )
  const max = Math.max(SESSION_PANEL_WIDTH_MIN_COMPACT, available - paneReserve)
  const min = Math.min(
    SESSION_PANEL_WIDTH_MIN,
    Math.max(SESSION_PANEL_WIDTH_MIN_COMPACT, max - SESSION_PANEL_RESIZE_RANGE_MIN),
  )
  return { min, max }
}

export function sessionPanelWidthMax(input: { available: number; split: boolean }) {
  return sessionPanelWidthBounds(input).max
}

export function sessionPanelWidthMin(input: { available: number; split: boolean }) {
  return sessionPanelWidthBounds(input).min
}

// `available` is undefined until the layout row is first measured; render the
// stored width untouched until then to avoid a first-frame snap.
export function clampSessionPanelWidth(input: { width: number; available: number | undefined; split: boolean }) {
  if (input.available === undefined) return input.width
  const bounds = sessionPanelWidthBounds({ available: input.available, split: input.split })
  return Math.min(bounds.max, Math.max(bounds.min, input.width))
}
