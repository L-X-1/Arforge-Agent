export type SidebarScrollSurface = "desktop" | "mobile"

export function sidebarScrollMemoryKey(surface: SidebarScrollSurface, project: string) {
  return `${surface}:${project}`
}

export function createSidebarScrollMemory() {
  const positions = new Map<string, number>()

  return {
    remember(key: string, scrollTop: number) {
      positions.set(key, Math.max(0, scrollTop))
    },
    restore(key: string, scrollHeight: number, clientHeight: number) {
      const maximum = Math.max(0, scrollHeight - clientHeight)
      return Math.min(positions.get(key) ?? 0, maximum)
    },
  }
}
