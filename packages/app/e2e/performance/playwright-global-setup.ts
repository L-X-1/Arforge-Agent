import type { FullConfig } from "@playwright/test"
import { playwrightReadinessPath } from "./playwright-server"

type ReadinessPayload = {
  ready?: boolean
  runID?: string
  port?: number
}

export default async function verifyPlaywrightTemporaryServer(config: FullConfig) {
  const runID = process.env.ARFORGE_PERFORMANCE_RUN_ID
  const port = Number(process.env.ARFORGE_PLAYWRIGHT_TEMP_PORT)
  const baseURL = config.projects[0]?.use.baseURL

  if (!runID || !Number.isInteger(port) || typeof baseURL !== "string") {
    throw new Error("Playwright temporary server environment is incomplete")
  }

  const url = new URL(playwrightReadinessPath(runID), baseURL)
  const response = await fetch(url, {
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) throw new Error(`Playwright temporary server probe failed with HTTP ${response.status}`)

  const payload = (await response.json()) as ReadinessPayload
  if (payload.ready !== true || payload.runID !== runID || payload.port !== port) {
    throw new Error(
      `Playwright temporary server identity mismatch: expected ${runID}:${port}, received ${JSON.stringify(payload)}`,
    )
  }

  console.log(`[Arforge Playwright] verified temporary server ${runID} on ${baseURL}`)
}
