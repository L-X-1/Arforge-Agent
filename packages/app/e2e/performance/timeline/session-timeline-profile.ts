import type { Page } from "@playwright/test"

export async function startTimelineProfile(
  page: Page,
  options: { cpuThrottle: number; profileCPU: boolean; deferThrottle?: boolean },
) {
  const cdp = await page.context().newCDPSession(page)
  let stopped: ReturnType<typeof stopProfile> | undefined
  let throttled: Promise<void> | undefined
  let restored: Promise<void> | undefined
  let reset: Promise<void> | undefined
  function applyThrottle() {
    if (restored || reset) return Promise.reject(new Error("Cannot apply CPU throttling after restoration"))
    return throttled ??= (async () => {
      if (options.cpuThrottle > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: options.cpuThrottle })
    })()
  }
  function restoreCPU() {
    return restored ??= (async () => {
      // A timed-out activation can still finish later. Restore only after it settles.
      if (!throttled) return
      await throttled.catch(() => undefined)
      if (options.cpuThrottle > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 })
    })()
  }
  async function stopProfile() {
      if (!options.profileCPU) return
      const result = await cdp.send("Profiler.stop")
      const self = new Map<number, number>()
      result.profile.samples?.forEach((id, index) => {
        const duration = (result.profile.timeDeltas?.[index] ?? 0) / 1_000
        self.set(id, (self.get(id) ?? 0) + duration)
      })
      console.log(
        "timeline cpu profile",
        JSON.stringify(
          result.profile.nodes
            .map((node) => ({
              function: node.callFrame.functionName || "(anonymous)",
              url: node.callFrame.url,
              line: node.callFrame.lineNumber + 1,
              column: node.callFrame.columnNumber + 1,
              selfMs: self.get(node.id) ?? 0,
            }))
            .filter((node) => node.selfMs > 1)
            .sort((a, b) => b.selfMs - a.selfMs)
            .slice(0, 40),
        ),
      )
      return result.profile
  }
  try {
    if (!options.deferThrottle) await applyThrottle()
    if (options.profileCPU) {
      await cdp.send("Profiler.enable")
      await cdp.send("Profiler.setSamplingInterval", { interval: 1000 })
      await cdp.send("Profiler.start")
    }
  } catch (error) {
    await restoreCPU().catch(() => undefined)
    await cdp.detach().catch(() => undefined)
    throw error
  }
  return {
    applyThrottle,
    restoreCPU,
    stop() {
      return stopped ??= stopProfile()
    },
    reset() {
      return reset ??= (async () => {
        try {
          await restoreCPU()
        } finally {
          await cdp.detach()
        }
      })()
    },
  }
}
