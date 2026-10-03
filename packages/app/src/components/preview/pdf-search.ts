export async function findPdfPages(input: {
  pages: number
  query: string
  read: (page: number) => Promise<string>
  current: () => boolean
}): Promise<number[] | undefined> {
  const query = input.query.trim().replace(/\s+/g, " ").toLocaleLowerCase()
  if (!query) return []
  const matches: number[] = []
  for (let page = 1; page <= input.pages; page++) {
    if (!input.current()) return
    const text = await input.read(page)
    if (!input.current()) return
    if (text.replace(/\s+/g, " ").toLocaleLowerCase().includes(query)) matches.push(page)
  }
  return matches
}
