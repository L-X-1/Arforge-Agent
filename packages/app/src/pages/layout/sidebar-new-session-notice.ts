export function sidebarNewSessionScrollTop(input: {
  scrollTop: number
  containerTop: number
  targetTop: number
  scrollHeight: number
  clientHeight: number
  inset?: number
}) {
  const maximum = Math.max(0, input.scrollHeight - input.clientHeight)
  const inset = input.inset ?? 8
  const next = input.scrollTop + input.targetTop - input.containerTop - inset
  return Math.min(maximum, Math.max(0, next))
}

export function sidebarNewSessionTargetReached(input: {
  containerTop: number
  containerBottom: number
  targetTop: number
  targetBottom: number
}) {
  return input.targetTop >= input.containerTop && input.targetBottom <= input.containerBottom
}

export function mergeSidebarNewSessionIDs(previousIDs: string[], nextIDs: string[]) {
  const seen = new Set(previousIDs)
  const merged = [...previousIDs]
  for (const id of nextIDs) {
    if (seen.has(id)) continue
    seen.add(id)
    merged.push(id)
  }
  return merged
}

export function sidebarNewSessionVisualCount(count: number, maximum = 99) {
  return count > maximum ? `${maximum}+` : count
}

export function firstSidebarNewSessionTarget(container: HTMLDivElement, ids: string[]) {
  const pending = new Set(ids)
  return [...container.querySelectorAll<HTMLElement>("[data-sidebar-session-row]")].find((row) => {
    const id = row.closest<HTMLElement>("[data-session-id]")?.dataset.sessionId
    return id !== undefined && pending.has(id)
  })
}

export function visibleSidebarNewSessionIDs(container: HTMLDivElement, ids: string[]) {
  const pending = new Set(ids)
  const containerRect = container.getBoundingClientRect()
  return [...container.querySelectorAll<HTMLElement>("[data-sidebar-session-row]")].flatMap((row) => {
    const id = row.closest<HTMLElement>("[data-session-id]")?.dataset.sessionId
    if (id === undefined || !pending.has(id)) return []
    const rowRect = row.getBoundingClientRect()
    return sidebarNewSessionTargetReached({
      containerTop: containerRect.top,
      containerBottom: containerRect.bottom,
      targetTop: rowRect.top,
      targetBottom: rowRect.bottom,
    })
      ? [id]
      : []
  })
}

export function scrollSidebarNewSessionIntoView(
  container: HTMLDivElement,
  target: HTMLElement,
  reducedMotion: boolean,
) {
  const containerRect = container.getBoundingClientRect()
  const targetRect = target.getBoundingClientRect()
  const top = sidebarNewSessionScrollTop({
    scrollTop: container.scrollTop,
    containerTop: containerRect.top,
    targetTop: targetRect.top,
    scrollHeight: container.scrollHeight,
    clientHeight: container.clientHeight,
  })
  container.scrollTo({
    top,
    behavior: reducedMotion ? "auto" : "smooth",
  })
  return top
}
