import { describe, expect, test } from "bun:test"
import type { Page } from "@playwright/test"
import { startTimelineProfile } from "../timeline/session-timeline-profile"

function profilePage(options: {
  waitForRestore?: boolean
  failRestore?: boolean
  waitForThrottle?: boolean
  failThrottle?: boolean
  failProfilerStart?: boolean
} = {}) {
  const calls: { method: string; params?: unknown }[] = []
  let rate = 1
  let resumeStop: (() => void) | undefined
  let resumeThrottle: (() => void) | undefined
  const profile = {
    nodes: [{ id: 1, callFrame: { functionName: "fixtureFrame", scriptId: "1", url: "http://127.0.0.1/fixture.js", lineNumber: 0, columnNumber: 0 } }],
    startTime: 0,
    endTime: 2000,
    samples: [1],
    timeDeltas: [2000],
  }
  const cdp = {
    async send(method: string, params?: unknown) {
      calls.push({ method, params })
      if (method === "Emulation.setCPUThrottlingRate") {
        const nextRate = (params as { rate: number }).rate
        if (nextRate > 1 && options.waitForThrottle) {
          await new Promise<void>((resolve) => { resumeThrottle = resolve })
        }
        if (nextRate > 1 && options.failThrottle) throw new Error("CPU throttle failed")
        if (nextRate === 1 && options.failRestore) throw new Error("CPU restore failed")
        rate = nextRate
        if (rate === 1) resumeStop?.()
      }
      if (method === "Profiler.start" && options.failProfilerStart) throw new Error("Profiler start failed")
      if (method === "Profiler.stop") {
        if (options.waitForRestore && rate > 1) await new Promise<void>((resolve) => { resumeStop = resolve })
        return { profile }
      }
      return {}
    },
    async detach() {
      calls.push({ method: "detach" })
    },
  }
  const page = { context: () => ({ newCDPSession: async () => cdp }) } as unknown as Page
  return { page, calls, profile, resumeThrottle: () => resumeThrottle?.() }
}

describe("timeline CPU profile lifecycle", () => {
  test("initializes a deferred profiler at normal speed and applies throttling once", async () => {
    const fixture = profilePage()
    const capture = await startTimelineProfile(fixture.page, { cpuThrottle: 30, profileCPU: true, deferThrottle: true })
    expect(fixture.calls).toEqual([
      { method: "Profiler.enable", params: undefined },
      { method: "Profiler.setSamplingInterval", params: { interval: 1000 } },
      { method: "Profiler.start", params: undefined },
    ])
    await capture.applyThrottle()
    await capture.applyThrottle()
    await capture.restoreCPU()
    expect(await capture.stop()).toEqual(fixture.profile)
    await capture.reset()
    expect(fixture.calls.slice(3)).toEqual([
      { method: "Emulation.setCPUThrottlingRate", params: { rate: 30 } },
      { method: "Emulation.setCPUThrottlingRate", params: { rate: 1 } },
      { method: "Profiler.stop", params: undefined },
      { method: "detach" },
    ])
  })

  test("cleans up preparation without applying or restoring unused throttling", async () => {
    const fixture = profilePage()
    const capture = await startTimelineProfile(fixture.page, { cpuThrottle: 30, profileCPU: false, deferThrottle: true })
    expect(fixture.calls).toEqual([])
    await capture.reset()
    await capture.reset()
    await expect(capture.applyThrottle()).rejects.toThrow("after restoration")
    expect(fixture.calls).toEqual([{ method: "detach" }])
  })

  test("does not activate after an early restoration", async () => {
    const fixture = profilePage()
    const capture = await startTimelineProfile(fixture.page, { cpuThrottle: 30, profileCPU: false, deferThrottle: true })
    await capture.restoreCPU()
    await expect(capture.applyThrottle()).rejects.toThrow("after restoration")
    await capture.reset()
    expect(fixture.calls).toEqual([{ method: "detach" }])
  })

  test("waits for an in-flight activation before restoring and detaching", async () => {
    const fixture = profilePage({ waitForThrottle: true })
    const capture = await startTimelineProfile(fixture.page, { cpuThrottle: 30, profileCPU: false, deferThrottle: true })
    const activation = capture.applyThrottle()
    const cleanup = capture.reset()
    expect(fixture.calls).toEqual([{ method: "Emulation.setCPUThrottlingRate", params: { rate: 30 } }])
    fixture.resumeThrottle()
    await activation
    await cleanup
    expect(fixture.calls).toEqual([
      { method: "Emulation.setCPUThrottlingRate", params: { rate: 30 } },
      { method: "Emulation.setCPUThrottlingRate", params: { rate: 1 } },
      { method: "detach" },
    ])
  })

  test("attempts restoration after a failed deferred activation", async () => {
    const fixture = profilePage({ failThrottle: true })
    const capture = await startTimelineProfile(fixture.page, { cpuThrottle: 30, profileCPU: false, deferThrottle: true })
    await expect(capture.applyThrottle()).rejects.toThrow("CPU throttle failed")
    await capture.reset()
    expect(fixture.calls).toEqual([
      { method: "Emulation.setCPUThrottlingRate", params: { rate: 30 } },
      { method: "Emulation.setCPUThrottlingRate", params: { rate: 1 } },
      { method: "detach" },
    ])
  })

  test("detaches when deferred profiler initialization fails", async () => {
    const fixture = profilePage({ failProfilerStart: true })
    await expect(startTimelineProfile(fixture.page, {
      cpuThrottle: 30, profileCPU: true, deferThrottle: true,
    })).rejects.toThrow("Profiler start failed")
    expect(fixture.calls).toEqual([
      { method: "Profiler.enable", params: undefined },
      { method: "Profiler.setSamplingInterval", params: { interval: 1000 } },
      { method: "Profiler.start", params: undefined },
      { method: "detach" },
    ])
  })

  test("returns a profile once and resets throttling and the debugger once", async () => {
    const fixture = profilePage()
    const capture = await startTimelineProfile(fixture.page, { cpuThrottle: 30, profileCPU: true })
    expect(await capture.stop()).toEqual(fixture.profile)
    expect(await capture.stop()).toEqual(fixture.profile)
    await capture.reset()
    await capture.reset()
    expect(fixture.calls).toEqual([
      { method: "Emulation.setCPUThrottlingRate", params: { rate: 30 } },
      { method: "Profiler.enable", params: undefined },
      { method: "Profiler.setSamplingInterval", params: { interval: 1000 } },
      { method: "Profiler.start", params: undefined },
      { method: "Profiler.stop", params: undefined },
      { method: "Emulation.setCPUThrottlingRate", params: { rate: 1 } },
      { method: "detach" },
    ])
  })

  test("does not start a profiler or apply throttling in the unprofiled control", async () => {
    const fixture = profilePage()
    const capture = await startTimelineProfile(fixture.page, { cpuThrottle: 1, profileCPU: false })
    expect(await capture.stop()).toBeUndefined()
    await capture.reset()
    expect(fixture.calls).toEqual([{ method: "detach" }])
  })

  test("restores CPU before failure capture without detaching or restoring twice", async () => {
    const fixture = profilePage({ waitForRestore: true })
    const capture = await startTimelineProfile(fixture.page, { cpuThrottle: 30, profileCPU: true })
    await capture.restoreCPU()
    await capture.restoreCPU()
    expect(fixture.calls.some((call) => call.method === "detach")).toBe(false)
    expect(await capture.stop()).toEqual(fixture.profile)
    await capture.reset()
    await capture.reset()
    expect(fixture.calls.slice(4)).toEqual([
      { method: "Emulation.setCPUThrottlingRate", params: { rate: 1 } },
      { method: "Profiler.stop", params: undefined },
      { method: "detach" },
    ])
  })

  test("releases a pending profiler stop by restoring CPU before detaching", async () => {
    const fixture = profilePage({ waitForRestore: true })
    const capture = await startTimelineProfile(fixture.page, { cpuThrottle: 30, profileCPU: true })
    const pending = capture.stop()
    await capture.restoreCPU()
    expect(await pending).toEqual(fixture.profile)
    expect(fixture.calls.some((call) => call.method === "detach")).toBe(false)
    await capture.reset()
    expect(fixture.calls.at(-1)).toEqual({ method: "detach" })
  })

  test("still detaches when restoring CPU fails", async () => {
    const fixture = profilePage({ failRestore: true })
    const capture = await startTimelineProfile(fixture.page, { cpuThrottle: 30, profileCPU: false })
    await expect(capture.reset()).rejects.toThrow("CPU restore failed")
    await expect(capture.reset()).rejects.toThrow("CPU restore failed")
    expect(fixture.calls.filter((call) => call.method === "detach")).toHaveLength(1)
  })

  test("restores an unprofiled throttled run without starting a profiler", async () => {
    const fixture = profilePage()
    const capture = await startTimelineProfile(fixture.page, { cpuThrottle: 30, profileCPU: false })
    await capture.restoreCPU()
    expect(await capture.stop()).toBeUndefined()
    await capture.reset()
    expect(fixture.calls).toEqual([
      { method: "Emulation.setCPUThrottlingRate", params: { rate: 30 } },
      { method: "Emulation.setCPUThrottlingRate", params: { rate: 1 } },
      { method: "detach" },
    ])
  })
})
