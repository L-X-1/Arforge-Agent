/** Public connection address only. Credentials and query/fragment values are never presentation data. */
export function managementServerAddress(value: string): string | undefined {
  try {
    const url = new URL(value)
    if (url.protocol !== "http:" && url.protocol !== "https:") return
    url.username = ""
    url.password = ""
    url.search = ""
    url.hash = ""
    return url.href.replace(/\/$/, "")
  } catch {
    return
  }
}
