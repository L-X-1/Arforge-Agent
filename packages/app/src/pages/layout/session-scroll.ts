export function sessionRevealDelta(input: {
  containerTop: number
  containerBottom: number
  targetTop: number
  targetBottom: number
  inset: number
}) {
  const visibleTop = input.containerTop + input.inset
  const visibleBottom = input.containerBottom - input.inset
  if (input.targetTop < visibleTop) return input.targetTop - visibleTop
  if (input.targetBottom > visibleBottom) return input.targetBottom - visibleBottom
  return 0
}

export function sessionScrollDelta(input: {
  scrollTop: number
  requestedDelta: number
  scrollHeight: number
  clientHeight: number
}) {
  const maximum = Math.max(0, input.scrollHeight - input.clientHeight)
  const target = Math.min(maximum, Math.max(0, input.scrollTop + input.requestedDelta))
  return target - input.scrollTop
}
