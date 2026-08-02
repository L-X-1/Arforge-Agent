export function workspaceRevealDelta(input: {
  containerTop: number
  containerBottom: number
  headerTop: number
  targetBottom: number
  inset: number
}) {
  const visibleBottom = input.containerBottom - input.inset
  const overflow = input.targetBottom - visibleBottom
  if (overflow <= 0) return 0

  const headerTravel = input.headerTop - (input.containerTop + input.inset)
  if (headerTravel <= 0) return 0
  return Math.min(overflow, headerTravel)
}
