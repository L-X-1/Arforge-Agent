export const EXECUTION_PREVIEW_LINES = 20

/** Count original lines without normalizing line endings or truncating long lines. */
export function executionContentPreview(content: string, expanded = false) {
  let totalLines = content.length ? 1 : 0
  let previewEnd = content.length
  for (const separator of content.matchAll(/\r\n|\r|\n/g)) {
    if (totalLines === EXECUTION_PREVIEW_LINES) previewEnd = separator.index
    totalLines++
  }
  const collapsible = totalLines > EXECUTION_PREVIEW_LINES
  const limited = collapsible && !expanded
  return {
    text: limited ? content.slice(0, previewEnd) : content,
    totalLines,
    shownLines: limited ? EXECUTION_PREVIEW_LINES : totalLines,
    collapsible,
  }
}
