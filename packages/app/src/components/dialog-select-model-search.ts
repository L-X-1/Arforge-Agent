export const normalizeModelSearch = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ")

export const compactModelSearch = (value: string) => normalizeModelSearch(value).replaceAll(" ", "")

export const matchesModelSearch = (query: string, values: string[]) => {
  const search = normalizeModelSearch(query)
  if (!search) return true

  const fields = values.map((value) => ({ normal: normalizeModelSearch(value), compact: compactModelSearch(value) }))
  return search.split(" ").every((word) => fields.some((field) => field.normal.includes(word) || field.compact.includes(word)))
}

/** Rank only inside each provider; equal ranks retain configured order. */
export const modelSearchRank = (query: string, name: string) => {
  const search = normalizeModelSearch(query)
  if (!search) return 0
  if (normalizeModelSearch(name).startsWith(search) || compactModelSearch(name).startsWith(compactModelSearch(query))) return 0
  return matchesModelSearch(query, [name]) ? 1 : 2
}
