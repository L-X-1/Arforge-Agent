export type FrameScheduler = (callback: FrameRequestCallback) => number

/**
 * Run menu follow-up work after the controlled close state has propagated.
 *
 * Kobalte may keep closed presence content mounted, so disconnection is not a
 * valid completion signal. The desktop close CSS is synchronous; two frames
 * provide a bounded hand-off for focus and controlled-state updates.
 */
export const afterModelMenuClose = (
  callback: () => void,
  schedule: FrameScheduler = requestAnimationFrame,
) => {
  schedule(() => schedule(callback))
}
