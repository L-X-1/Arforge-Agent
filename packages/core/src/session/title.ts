/** Shared title policy; execution and storage remain owned by the session runtime. */
export const parentPrefix = "新会话 - "
export const childPrefix = "子会话 - "

const defaultTitle = /^(新会话 - |子会话 - )\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

export const isDefaultTitle = (title: string): boolean => defaultTitle.test(title)

/** A generated title may replace only the exact default observed at admission. */
export const canReplace = (input: {
  readonly expected: string
  readonly current: string
  readonly parentID?: string
}): boolean => !input.parentID && isDefaultTitle(input.expected) && input.current === input.expected

/** Ignore reasoning and blank output; bound Unicode code points without splitting a surrogate pair. */
export const normalizeGenerated = (text: string): string | undefined => {
  const visible = text.replace(/<think>[\s\S]*?<\/think>\s*/gi, "")
  // An unfinished reasoning block is not a usable title.
  if (/<think>/i.test(visible)) return undefined
  const first = visible
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0)
  if (!first || isDefaultTitle(first)) return undefined
  const points = Array.from(first)
  return points.length > 100 ? `${points.slice(0, 97).join("")}...` : first
}
