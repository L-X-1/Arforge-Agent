export function resizeHandleKeyboardSize(input: {
  key: string
  direction: "horizontal" | "vertical"
  edge?: "start" | "end"
  size: number
  min: number
  max: number
  shiftKey?: boolean
}) {
  if (input.key === "Home") return input.min
  if (input.key === "End") return input.max
  const horizontal = input.direction === "horizontal"
  const edge = input.edge ?? (horizontal ? "end" : "start")
  const backwards = horizontal ? "ArrowLeft" : "ArrowUp"
  const forwards = horizontal ? "ArrowRight" : "ArrowDown"
  if (input.key !== backwards && input.key !== forwards) return undefined
  const delta = (input.key === forwards ? 1 : -1) * (edge === "start" ? -1 : 1)
  return Math.min(input.max, Math.max(input.min, input.size + delta * (input.shiftKey ? 32 : 8)))
}
