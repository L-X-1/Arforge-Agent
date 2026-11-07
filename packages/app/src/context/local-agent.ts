export function hasCustomAgent(items: Array<{ native?: boolean }>) {
  return items.some((item) => item.native === false)
}

export function resolveAgent<T extends { name: string }>(items: T[], name?: string) {
  if (name !== undefined) return items.find((item) => item.name === name)
  return items.find((item) => item.name === "build") ?? items[0]
}

export function resolveAgentSelection<T extends { name: string }>(
  items: T[],
  input: { selected?: string; fallback?: string },
) {
  const current = input.selected !== undefined
    ? resolveAgent(items, input.selected)
    : resolveAgent(items, input.fallback) ?? resolveAgent(items)
  return {
    current,
    selected: input.selected ?? current?.name,
    unavailable: input.selected !== undefined && !current ? input.selected : undefined,
  }
}

export function unavailableAgentReason(name: string | undefined, ready: boolean, locale: string) {
  if (!ready || name === undefined) return
  return locale.startsWith("zh")
    ? `已选择的代理“${name}”在当前来源中不可用。请选择其他代理。`
    : `Selected Agent "${name}" is unavailable in this source. Choose another Agent.`
}
