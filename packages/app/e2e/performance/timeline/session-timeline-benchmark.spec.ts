import type { Page } from "@playwright/test"
import { createHash } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { benchmark, benchmarkDiagnostics, expect } from "../benchmark"
import {
  buildInitialStreamEvent,
  buildStreamDeltaEvents,
  setupTimelineBenchmark,
  textPartID,
} from "./session-timeline-benchmark.fixture"
import { startTimelineProfile } from "./session-timeline-profile"
import { withTimelineDeadline } from "./session-timeline-deadline"
import { createReviewDiffs } from "./timeline-test-helpers"
import {
  collectTimelineStreamMetrics,
  installTimelineStreamProbe,
  startTimelineStreamProbe,
  type TimelineProbeState,
} from "./session-timeline-stream-probe"

type TimelineStreamOptions = {
  newLayoutDesigns?: boolean
  reviewDiffs?: boolean
  reviewPane?: boolean
}

type ReviewPaneSample = {
  observedAtMs: number
  panelVisible: boolean
  header: string
  diffViewers: number
  diffLines: number
  codeBlocks: number
  ready: boolean
}

type ReviewPaneProbe = {
  samples: ReviewPaneSample[]
  start: () => void
  stop: () => void
}

const reviewReadyStreak = 3

benchmark.describe("performance: session timeline streaming", () => {
  benchmark("streams assistant text without remounting or oscillating", async ({ page, report }) => {
    benchmark.setTimeout(Number(process.env.TIMELINE_COMPLETION_TIMEOUT_MS ?? 420_000) + 60_000)
    const result = await runTimelineStreamBenchmark(page, {})
    report(result.metrics, result.context)
  })

  benchmark("streams assistant text in v2 with review pane closed", async ({ page, report }) => {
    benchmark.setTimeout(Number(process.env.TIMELINE_COMPLETION_TIMEOUT_MS ?? 420_000) + 60_000)
    const result = await runTimelineStreamBenchmark(page, { newLayoutDesigns: true })
    report(result.metrics, result.context)
  })

  benchmark("streams assistant text in v2 with review diffs and pane closed", async ({ page, report }) => {
    benchmark.setTimeout(Number(process.env.TIMELINE_COMPLETION_TIMEOUT_MS ?? 420_000) + 60_000)
    const result = await runTimelineStreamBenchmark(page, { newLayoutDesigns: true, reviewDiffs: true })
    report(result.metrics, result.context)
  })

  benchmark("streams assistant text in v2 with review pane open", async ({ page, report }) => {
    benchmark.setTimeout(Number(process.env.TIMELINE_COMPLETION_TIMEOUT_MS ?? 420_000) + 60_000)
    const result = await runTimelineStreamBenchmark(page, { newLayoutDesigns: true, reviewPane: true })
    report(result.metrics, result.context)
  })
})

benchmark.describe("performance: review pane", () => {
  benchmark("loads v2 review diffs and switches active files", async ({ page, report }) => {
    benchmark.setTimeout(240_000)
    const historyTurns = Number(process.env.REVIEW_PANE_HISTORY_TURNS ?? 72)
    const diffs = createReviewDiffs()
    const fixture = await setupTimelineBenchmark(page, {
      historyTurns,
      eventBatch: 1,
      newLayoutDesigns: true,
      vcsDiff: diffs,
    })

    fixture.transport.enqueue(buildInitialStreamEvent(1))
    await expect(fixture.text).toBeVisible()
    await expect(fixture.text).toContainText("Implementation plan")
    await fixture.scrollToBottom()
    await fixture.waitForStableGeometry()

    const open = await measureReviewPaneLoad(page, diffs[0]!.file)
    const switches = []
    for (const diff of diffs.slice(1, 4)) switches.push(await measureReviewNextFile(page, diff.file))

    report(
      {
        open,
        switches,
      },
      {
        historyTurns,
        reviewDiffs: diffs.length,
      },
    )
  })
})

async function runTimelineStreamBenchmark(page: Page, options: TimelineStreamOptions) {
  const setupStarted = performance.now()
  const completionTimeoutMs = Number(process.env.TIMELINE_COMPLETION_TIMEOUT_MS ?? 420_000)
  const cpuThrottle = Number(process.env.TIMELINE_CPU_THROTTLE ?? 30)
  const deltaCount = Number(process.env.TIMELINE_DELTA_COUNT ?? 160)
  const historyTurns = Number(process.env.TIMELINE_HISTORY_TURNS ?? 320)
  const eventBatch = Number(process.env.TIMELINE_EVENT_BATCH ?? 1)
  const minimal = process.env.TIMELINE_MINIMAL === "1"
  const profileCPU = process.env.TIMELINE_CPU_PROFILE === "1"
  const profileVisual = !minimal && profileCPU && process.env.TIMELINE_VISUAL_PROFILE !== "0"
  const diffs = options.reviewDiffs || options.reviewPane ? createReviewDiffs() : undefined
  const fixture = await setupTimelineBenchmark(page, {
    historyTurns,
    eventBatch,
    newLayoutDesigns: options.newLayoutDesigns,
    // Turn diffs exercise timeline data cost; the pane-open scenario serves the same
    // diffs through the default git mode so it works across review implementations.
    turnDiffs: options.reviewDiffs ? diffs : undefined,
    vcsDiff: options.reviewPane ? diffs : undefined,
  })

  fixture.transport.enqueue(buildInitialStreamEvent(deltaCount))
  const contentStart = performance.now()
  await expect(fixture.text).toBeVisible()
  await expect(fixture.text).toContainText("Implementation plan")
  const initialContentObservedMs = performance.now() - contentStart
  await fixture.scrollToBottom()
  await fixture.waitForStableGeometry()

  const reviewPane = options.reviewPane && diffs ? await measureReviewPaneLoad(page, diffs[0]!.file) : undefined
  if (reviewPane) await fixture.waitForStableGeometry()

  const profile = await startTimelineProfile(page, { cpuThrottle, profileCPU, deferThrottle: true })
  const deltas = buildStreamDeltaEvents(deltaCount)
  let setupElapsedMs = 0
  let throttleActivationMs = 0
  let streamStartedAt: number | undefined
  let streamCompletedAt: number | undefined
  let phase = "probe-installation"
  try {
    // Install and arm all renderer instrumentation before enabling CPU throttling.
    await withTimelineDeadline(
      installTimelineStreamProbe(page, { textPartID, finalIndex: deltaCount, profileVisual, minimal }),
      "Stream probe installation",
      15_000,
    )
    phase = "probe-start"
    await withTimelineDeadline(startTimelineStreamProbe(page), "Stream probe start", 15_000)
    setupElapsedMs = Math.ceil(performance.now() - setupStarted)
    // The renderer probe includes activation; report the host stream interval separately.
    const testTimeoutMs = setupElapsedMs + 15_000 + completionTimeoutMs + 60_000
    benchmark.setTimeout(testTimeoutMs)
    console.log("TIMELINE_PREPARATION_READY", JSON.stringify({ setupElapsedMs, cpuThrottle, profileCPU, profileVisual, minimal }))
    phase = "cpu-throttle"
    const throttleStartedAt = performance.now()
    await withTimelineDeadline(profile.applyThrottle(), "CPU throttle activation", 15_000)
    throttleActivationMs = performance.now() - throttleStartedAt
    console.log("TIMELINE_STREAM_WAIT", JSON.stringify({ setupElapsedMs, throttleActivationMs, completionTimeoutMs, testTimeoutMs }))
    phase = "stream-completion"
    streamStartedAt = performance.now()
    fixture.transport.enqueue(deltas)
    await withTimelineDeadline(
      page.waitForFunction(
        (finalIndex) =>
          (
            window as Window & {
              __timelineStreamBenchmark?: { applied: { index: number }[] }
            }
          ).__timelineStreamBenchmark?.applied.some((value) => value.index === finalIndex),
        deltaCount,
        // Node owns the deadline; the renderer only polls for completion.
        { timeout: 0 },
      ),
      "Stream completion",
      completionTimeoutMs,
    )
    streamCompletedAt = performance.now()
    phase = "final-text"
    await expect(fixture.text).toContainText("benchmark-complete")
    await expect(fixture.text).toContainText("Streaming")
    phase = "stable-geometry"
    await fixture.waitForStableGeometry()
  } catch (error) {
    const failureObservedAt = performance.now()
    const pendingDeltas = fixture.transport.pendingCount()
    const transportAtFailure = fixture.transport.stats()
    let cpuRestoreError: string | undefined
    // The outcome is already failed. Restore responsiveness only for diagnostics,
    // keeping the debugger attached until the raw profile has been collected.
    try {
      await withTimelineDeadline(profile.restoreCPU(), "CPU restore before diagnostics", 5000)
    } catch (restoreError) {
      cpuRestoreError = restoreError instanceof Error ? restoreError.message : String(restoreError)
      console.warn("TIMELINE_CPU_RESTORE_ERROR", cpuRestoreError)
    }
    let cpuCaptureError: string | undefined
    try {
      await attachTimelineCpuProfile(profile, "failed")
    } catch (captureError) {
      cpuCaptureError = captureError instanceof Error ? captureError.message : String(captureError)
      console.warn("TIMELINE_CPU_PROFILE_ERROR", cpuCaptureError)
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const snapshot = await Promise.race([
        page.evaluate(({ textPartID, finalIndex }) => {
          const state = (window as Window & { __timelineStreamBenchmark?: TimelineProbeState }).__timelineStreamBenchmark
          const selector = `[data-timeline-part-id="${CSS.escape(textPartID)}"]`
          const parts = [...document.querySelectorAll<HTMLElement>(selector)]
          const samplePart = (part: HTMLElement | null) => {
            if (!part) return null
            const content = part.textContent ?? ""
            const rect = part.getBoundingClientRect()
            const style = getComputedStyle(part)
            const markdown = part.querySelector<HTMLElement>('[data-component="markdown"]')
            return {
              connected: part.isConnected,
              characters: content.length,
              hasCompletionText: content.includes("benchmark-complete"),
              lastStreamMarker: content.match(/stream-\d+/g)?.at(-1) ?? null,
              tail: content.slice(-1000),
              bounds: { top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height },
              display: style.display,
              visibility: style.visibility,
              opacity: style.opacity,
              rowMatchesOriginal: part.closest("[data-timeline-row]") === state?.row,
              markdownMatchesOriginal: markdown === state?.markdown,
              markdown: markdown ? {
                projectionLength: markdown.dataset.markdownProjectionLength,
                projectionBlocks: markdown.dataset.markdownProjectionBlocks,
                resultLength: markdown.dataset.markdownResultLength,
                resultBlocks: markdown.dataset.markdownResultBlocks,
                appliedBlocks: markdown.dataset.markdownAppliedBlocks,
                children: markdown.children.length,
              } : null,
            }
          }
          const now = performance.now()
          return {
            capturedAt: new Date().toISOString(),
            path: location.pathname,
            visibility: document.visibilityState,
            focused: document.hasFocus(),
            readyState: document.readyState,
            matchingParts: parts.length,
            documentParts: parts.slice(0, 4).map(samplePart),
            probe: state ? {
              running: state.running,
              elapsedMs: now - state.started,
              frames: state.frames.length,
              lastFrameAgeMs: state.frameAt.length ? now - state.frameAt[state.frameAt.length - 1]! : null,
              appliedCount: state.applied.length,
              lastApplied: state.applied.slice(-8).map((value) => ({ index: value.index, elapsedMs: value.at - state.started })),
              sawFinalIndex: state.applied.some((value) => value.index === finalIndex),
              lastGeometry: state.geometry.at(-1) ?? null,
              blankSamples: state.blanks,
              longTaskCount: state.longTasks.length,
              rootConnected: state.root.isConnected,
              rowConnected: state.row.isConnected,
              markdownConnected: state.markdown.isConnected,
              rootStillOwnsOriginalRow: state.root.contains(state.row),
              currentRootMatchesOriginal: parts[0]?.closest(".scroll-view__viewport") === state.root,
              observedRootPart: samplePart(state.root.querySelector<HTMLElement>(selector)),
              originalRowPart: samplePart(state.row.querySelector<HTMLElement>(selector)),
            } : null,
          }
        }, { textPartID, finalIndex: deltaCount }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Failure snapshot did not respond within 15 seconds")), 15_000)
        }),
      ]).catch((captureError) => ({ captureError: captureError instanceof Error ? captureError.message : String(captureError) }))
      const diagnostics = {
        phase,
        cpuRestoreError,
        cpuCaptureError,
        snapshotAfterThrottleRestore: cpuRestoreError === undefined,
        diagnosticElapsedMs: performance.now() - failureObservedAt,
        preparationElapsedMs: setupElapsedMs || failureObservedAt - setupStarted,
        throttleActivationMs,
        streamObservedMs: streamStartedAt === undefined ? null : failureObservedAt - streamStartedAt,
        error: error instanceof Error ? error.message : String(error),
        context: { cpuThrottle, historyTurns, deltaCount, eventBatch, completionTimeoutMs, profileCPU, profileVisual, minimal, ...options },
        transport: { queuedDeltas: deltas.length, pendingDeltas, deliveredDeltas: deltas.length - pendingDeltas, ...transportAtFailure },
        navigations: benchmarkDiagnostics(page).navigations,
        snapshot,
      }
      console.log("TIMELINE_FAILURE_DIAGNOSTICS", JSON.stringify(diagnostics))
      await benchmark.info().attach("timeline-failure-diagnostics", {
        body: Buffer.from(JSON.stringify(diagnostics, null, 2)),
        contentType: "application/json",
      })
    } catch (captureError) {
      console.warn("TIMELINE_FAILURE_DIAGNOSTICS_ERROR", captureError instanceof Error ? captureError.message : String(captureError))
    } finally {
      if (timer) clearTimeout(timer)
      await withTimelineDeadline(profile.reset(), "CPU throttle reset", 5000).catch((resetError) => {
        console.warn("TIMELINE_PROFILE_RESET_ERROR", resetError instanceof Error ? resetError.message : String(resetError))
      })
    }
    throw error
  }
  const metrics = await collectTimelineStreamMetrics(page, {
    textPartID,
    finalIndex: deltaCount,
    navigations: benchmarkDiagnostics(page).navigations,
  })
  const delivered = deltas.length - fixture.transport.pendingCount()
  await attachTimelineCpuProfile(profile, "passed")

  const result = {
    metrics: {
      endToEndInitialContentObservedMs: initialContentObservedMs,
      preparationElapsedMs: setupElapsedMs,
      throttleActivationMs,
      hostStreamCompletionMs: streamStartedAt === undefined || streamCompletedAt === undefined
        ? null
        : streamCompletedAt - streamStartedAt,
      ...metrics,
      deliveredDeltas: delivered,
      pendingDeltas: fixture.transport.pendingCount(),
      reviewPane: reviewPane ?? null,
    },
    context: {
      cpuThrottle,
      probeTimingIncludesThrottleActivation: true,
      profileCPU,
      profileVisual,
      minimal,
      queuedDeltas: deltas.length,
      transport: fixture.transport.stats(),
      historyTurns,
      eventBatch,
      newLayoutDesigns: options.newLayoutDesigns === true,
      reviewPane: options.reviewPane === true ? "open" : "closed",
      reviewDiffs: diffs?.length ?? 0,
    },
  }

  await profile.reset()
  return result
}

async function attachTimelineCpuProfile(profile: Awaited<ReturnType<typeof startTimelineProfile>>, outcome: string) {
  const captured = await withTimelineDeadline(profile.stop(), "CPU profile capture", 10_000)
  if (!captured) return
  const name = `timeline-${outcome}.cpuprofile`
  const body = Buffer.from(JSON.stringify(captured))
  let archivePath: string | undefined
  const archiveDir = process.env.ARFORGE_TIMELINE_PROFILE_DIR
  if (archiveDir) {
    try {
      const info = benchmark.info()
      const key = createHash("sha256").update(info.testId).digest("hex").slice(0, 16)
      const profilesDir = join(archiveDir, "profiles")
      await mkdir(profilesDir, { recursive: true })
      const destination = join(profilesDir, `${key}-${info.repeatEachIndex}-${info.retry}-${name}`)
      await writeFile(destination, body)
      archivePath = destination
    } catch (archiveError) {
      console.warn("TIMELINE_CPU_ARCHIVE_ERROR", archiveError instanceof Error ? archiveError.message : String(archiveError))
    }
  }
  await benchmark.info().attach(name, {
    body,
    contentType: "application/json",
  })
  console.log("TIMELINE_CPU_PROFILE_SAVED", JSON.stringify({ name, archivePath, nodes: captured.nodes.length, samples: captured.samples?.length ?? 0 }))
}

async function measureReviewPaneLoad(page: Page, file: string) {
  // Default git mode reads the mocked /vcs/diff data, so opening the pane is enough
  // and the flow works across review pane implementations.
  await installReviewPaneProbe(page, { file })
  await startReviewPaneProbe(page)
  await page.getByRole("button", { name: "Toggle review" }).click()
  await expect(page.locator("#review-panel")).toBeVisible()
  return collectReviewPaneProbe(page)
}

async function measureReviewNextFile(page: Page, file: string) {
  await installReviewPaneProbe(page, { file })
  await startReviewPaneProbe(page)
  await page.getByRole("button", { name: "Next file" }).click()
  return collectReviewPaneProbe(page)
}

async function installReviewPaneProbe(page: Page, input: { file: string }) {
  await page.evaluate((input) => {
    const samples: ReviewPaneSample[] = []
    const basename = input.file.split(/[\\/]/).at(-1) ?? input.file
    let started: number | undefined
    let running = true

    const paneState = () => {
      const panel = document.querySelector<HTMLElement>("#review-panel")
      const review = panel?.querySelector<HTMLElement>('[data-component="session-review-v2"]')
      const rect = (review ?? panel)?.getBoundingClientRect()
      const text = panel?.textContent ?? ""
      const previewHeader = panel?.querySelector<HTMLElement>(
        '[data-slot="session-review-v2-file-header"]',
      )?.textContent
      const header = previewHeader ?? text
      const viewers = panel ? [...panel.querySelectorAll<HTMLElement>('[data-component="file"][data-mode="diff"]')] : []
      const codeBlocks = panel?.querySelectorAll("code").length ?? 0
      const diffLines = viewers.reduce(
        (sum, viewer) =>
          sum +
          (viewer.shadowRoot?.querySelectorAll("[data-line]").length ?? viewer.querySelectorAll("[data-line]").length),
        0,
      )
      const panelVisible =
        !!panel && panel.getAttribute("aria-hidden") !== "true" && !!rect && rect.width > 0 && rect.height > 0
      return {
        panelVisible,
        header: header.slice(0, 500),
        diffViewers: viewers.length,
        diffLines,
        codeBlocks,
        ready:
          panelVisible &&
          header.includes(basename) &&
          (viewers.length > 0 || text.includes("+3") || diffLines > 0 || codeBlocks > 0),
      }
    }

    const sample = () => {
      if (!running || started === undefined) return
      requestAnimationFrame(() => {
        setTimeout(() => {
          if (!running || started === undefined) return
          samples.push({ observedAtMs: performance.now() - started, ...paneState() })
          if (performance.now() - started < 10_000) sample()
        }, 0)
      })
    }

    ;(window as Window & { __reviewPaneProbe?: ReviewPaneProbe }).__reviewPaneProbe = {
      samples,
      start: () => {
        started = performance.now()
        performance.mark("arforge.review-pane.click")
        sample()
      },
      stop: () => {
        running = false
      },
    }
  }, input)
}

async function startReviewPaneProbe(page: Page) {
  await page.evaluate(() => {
    ;(window as Window & { __reviewPaneProbe?: ReviewPaneProbe }).__reviewPaneProbe!.start()
  })
}

async function collectReviewPaneProbe(page: Page) {
  await page.waitForFunction((streak) => {
    const samples = (window as Window & { __reviewPaneProbe?: ReviewPaneProbe }).__reviewPaneProbe?.samples
    if (!samples) return false
    return samples.some((_, index) => {
      const stable = samples.slice(index, index + streak)
      return stable.length === streak && stable.every((sample) => sample.ready)
    })
  }, reviewReadyStreak)

  const samples = await page.evaluate(() => {
    const probe = (window as Window & { __reviewPaneProbe?: ReviewPaneProbe }).__reviewPaneProbe!
    probe.stop()
    return probe.samples
  })
  return { summary: summarizeReviewPaneSamples(samples), samples }
}

function summarizeReviewPaneSamples(samples: ReviewPaneSample[]) {
  const firstReady = samples.find((sample) => sample.ready)
  const stableIndex = samples.findIndex((_, index) => {
    const stable = samples.slice(index, index + reviewReadyStreak)
    return stable.length === reviewReadyStreak && stable.every((sample) => sample.ready)
  })
  return {
    samples: samples.length,
    firstReadyObservedMs: firstReady?.observedAtMs ?? null,
    stableReadyObservedMs: stableIndex === -1 ? null : samples[stableIndex + reviewReadyStreak - 1]!.observedAtMs,
    notReadySamples: samples.filter((sample) => !sample.ready).length,
    maxDiffViewers: Math.max(0, ...samples.map((sample) => sample.diffViewers)),
    maxDiffLines: Math.max(0, ...samples.map((sample) => sample.diffLines)),
    maxCodeBlocks: Math.max(0, ...samples.map((sample) => sample.codeBlocks)),
  }
}
