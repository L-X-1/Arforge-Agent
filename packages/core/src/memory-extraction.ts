/** One deterministic, side-effect-free owner for explicit durable Memory extraction. */
import { Memory } from "@arforge-ai/schema/memory"
import { sanitize } from "./analysis/memory-conflict"

export interface ExtractedCandidate {
  readonly content: Memory.Content
  readonly type: Memory.Type
  readonly tags: Memory.Tags
  readonly importance: Memory.Importance
  readonly source: "auto"
  readonly scope: "workspace"
}

export function extractCandidates(text: string): ExtractedCandidate[] {
  const value = sanitize(text).slice(0, 800)
  if (!value || /\b(?:for now|temporarily|just this time|today only)\b/i.test(value)) return []
  const candidates: ExtractedCandidate[] = []
  const add = (content: string, type: string) => {
    const normalized = sanitize(content)
    if (!normalized) return
    candidates.push({
      content: Memory.Content.make(normalized),
      type: Memory.Type.make(type),
      tags: Memory.Tags.make([Memory.Tag.make("governed-auto")]),
      importance: Memory.Importance.make(type === "identity" ? 3 : 2),
      source: "auto",
      scope: "workspace",
    })
  }
  const remember = value.match(/\b(?:remember|please remember|from now on)\b(?:\s+that)?[:\s]+(.+)/i)
  if (remember?.[1]) add(remember[1], "constraint")
  const prefer = value.match(/\bI\s+(?:strongly\s+)?prefer\s+(.+)/i)
  if (prefer?.[1]) add(`User prefers ${prefer[1]}`, "preference")
  const always = value.match(/\b(?:always|never)\s+(.+)/i)
  if (always?.[0]) add(always[0], "convention")
  const identity = value.match(/\b(?:my name is|call me)\s+([^.!?\n]{1,80})/i)
  if (identity?.[1]) add(`User's preferred name is ${identity[1].trim()}`, "identity")
  return candidates.slice(0, 3)
}
