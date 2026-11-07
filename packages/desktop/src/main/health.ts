export async function checkHealth(
  url: string,
  username?: string | null,
  password?: string | null,
  signal?: AbortSignal,
): Promise<boolean> {
  let healthUrls: URL[]
  try {
    healthUrls = [new URL("/api/health", url), new URL("/global/health", url)]
  } catch {
    return false
  }
  const headers = new Headers()
  if (password)
    headers.set("authorization", `Basic ${Buffer.from(`${username ?? "arforge"}:${password}`).toString("base64")}`)
  for (const healthUrl of healthUrls) {
    try {
      const timeout = AbortSignal.timeout(3000)
      const response = await fetch(healthUrl, {
        headers,
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      })
      if (!response.ok) {
        await response.body?.cancel()
        continue
      }
      const body: unknown = await response.json()
      if (typeof body !== "object" || body === null || !("healthy" in body) || body.healthy !== true) continue
      if (healthUrl.pathname === "/api/health" && "protocol" in body && body.protocol === "v2") return true
      if (
        healthUrl.pathname === "/global/health" &&
        "version" in body &&
        typeof body.version === "string" &&
        body.version.length > 0
      )
        return true
    } catch {}
    if (signal?.aborted) return false
  }
  return false
}

export async function waitForHealth(input: {
  check: (signal: AbortSignal) => Promise<boolean>
  signal: AbortSignal
  timeoutMs?: number
  intervalMs?: number
}) {
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(input.timeoutMs ?? 30_000)])
  while (!signal.aborted) {
    if (await input.check(signal)) {
      signal.throwIfAborted()
      return
    }
    if (signal.aborted) break
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer)
        signal.removeEventListener("abort", done)
        resolve()
      }
      const timer = setTimeout(done, input.intervalMs ?? 100)
      signal.addEventListener("abort", done, { once: true })
    })
  }
  throw new Error("Owned backend health check failed or timed out; restart the application to retry", {
    cause: signal.reason,
  })
}
