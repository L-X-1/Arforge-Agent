export const SESSION_ARCHIVE_REVEAL_PX = 44

export function clampSessionArchiveOffset(start: number, delta: number) {
  return Math.min(0, Math.max(-SESSION_ARCHIVE_REVEAL_PX, start + delta))
}

export function shouldRevealSessionArchive(offset: number, velocity: number) {
  if (velocity <= -0.35) return true
  if (velocity >= 0.35) return false
  return offset <= -SESSION_ARCHIVE_REVEAL_PX / 2
}
