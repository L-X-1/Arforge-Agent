/** A bounded list preview never replaces the object's complete detail content. */
export function memoryListPreview(content: string, maximum = 120) {
  const text = content.replace(/\s+/gu, " ").trim()
  const characters = Array.from(text)
  return characters.length > maximum ? `${characters.slice(0, maximum).join("")}…` : text
}

/** Paginate only the real items returned by the existing bounded read. */
export function managementListPage<Item>(items: readonly Item[], requested: number, size = 20) {
  const pages = Math.max(1, Math.ceil(items.length / size))
  const index = Math.max(0, Math.min(Math.trunc(requested) || 0, pages - 1))
  return { index, pages, items: items.slice(index * size, (index + 1) * size) }
}
