export function readPartText(accum: Record<string, string> | undefined, part: { id: string; text?: string }): string {
  return readPartSource(accum, part).trim()
}

/** Markdown code disclosure/copy needs the exact source, including open-fence EOLs. */
export function readPartSource(accum: Record<string, string> | undefined, part: { id: string; text?: string }): string {
  return accum?.[part.id] ?? part.text ?? ""
}
