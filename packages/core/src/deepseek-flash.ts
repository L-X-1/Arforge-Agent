const canonical = "deepseek-flash"
export const deepSeekFlashAliases = ["deepseek-v4-flash", "deepseek-v4-flash-vision-exp"] as const

/** https://api-docs.deepseek.com/quick_start/pricing/ */
export function officialDeepSeekFlash(providerID: string, modelID: string, endpoint: string | undefined) {
  if (
    providerID !== "deepseek" ||
    !endpoint ||
    (modelID !== canonical && !deepSeekFlashAliases.some((alias) => alias === modelID))
  )
    return undefined
  const url = URL.parse(endpoint)
  if (url?.origin !== "https://api.deepseek.com" || url.username || url.password || url.search || url.hash)
    return undefined
  const path = url.pathname.replace(/\/$/, "")
  if (path === "" || path === "/v1" || path === "/anthropic") return canonical
}
