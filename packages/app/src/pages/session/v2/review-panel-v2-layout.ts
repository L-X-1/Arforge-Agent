import type { SessionReviewDiffStyle } from "@arforge-ai/session-ui/session-review"

/** The preview's measured width, after the directory, determines the default. */
export function reviewPanelDiffStyle(input: {
  width: number
  preference: SessionReviewDiffStyle | null | undefined
  choice?: SessionReviewDiffStyle
  controlled: SessionReviewDiffStyle
}): SessionReviewDiffStyle {
  if (input.preference) return input.preference
  if (input.choice) return input.choice
  if (input.preference === undefined) return input.controlled
  return Number.isFinite(input.width) && input.width >= 620 ? "split" : "unified"
}
