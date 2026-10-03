import { expect, type Page } from "@playwright/test"
import { classifySessionSwitch, isStableDestination, type SessionSwitchSample } from "./session-tab-switch-metrics"

type SessionSwitchProbe = {
  samples: SessionSwitchSample[]
  stop: () => void
}

type TimelineStabilitySample = Pick<SessionSwitchSample, "last" | "bottomErrorPx"> & {
  viewportCount: number
  timelineRowCount: number
  lastMessageCount?: number
  scrollTop?: number
  scrollHeight?: number
  clientHeight?: number
  viewportTop?: number
  viewportBottom?: number
  spacerBottom?: number
}

export function timelineStabilityError(
  lastID: string,
  samples: readonly Pick<SessionSwitchSample, "last" | "bottomErrorPx">[],
  cause: unknown,
) {
  return new Error(
    `Timeline did not stabilize: lastMessageID=${lastID}, samples=${samples.length}, recent=${JSON.stringify(samples.slice(-3))}`,
    { cause },
  )
}

async function installSessionSwitchProbe(
  page: Page,
  input: {
    destinationIDs: string[]
    sourceIDs: string[]
    lastID: string
    requiredPartID?: string
    requireBottomAnchor?: boolean
    href: string
  },
) {
  await page.evaluate(({ destinationIDs, sourceIDs, lastID, requiredPartID, requireBottomAnchor, href }) => {
    const destination = new Set(destinationIDs)
    const source = new Set(sourceIDs)
    const samples: SessionSwitchSample[] = []
    let started: number | undefined
    let running = true
    const reviewLevels: Record<string, string> = {
      panel: "#review-panel",
      tabs: '#review-panel [data-component="tabs"]',
      body: '#review-panel [data-slot="session-review-v2-body"]',
      review: '#review-panel [data-component="session-review-v2"]',
      preview: '#review-panel [data-slot="session-review-v2-preview"]',
      scroll: '#review-panel [data-slot="session-review-v2-diff-scroll"]',
      file: '#review-panel [data-component="file"][data-mode="diff"]',
    }
    const initialReviewNodes: Record<string, Element | null> = {}
    const sample = () => {
      if (!running || started === undefined) return
      setTimeout(() => {
        if (!running || started === undefined) return
        const observedAtMs = performance.now() - started
        const reviewPanel = document.querySelector<HTMLElement>("#review-panel")
        const reviewFile = reviewPanel?.querySelector('[data-component="file"][data-mode="diff"]')
        const initialReviewFile = initialReviewNodes.file
        const replacedLevels = Object.entries(reviewLevels).flatMap(([name, selector]) => {
          const initial = initialReviewNodes[name]
          if (!initial) return []
          const current = document.querySelector(selector)
          return current && current !== initial ? [name] : []
        })
        const review = reviewPanel
          ? {
              fileHost: !!reviewFile,
              fileHostReplaced: !!initialReviewFile && !!reviewFile && reviewFile !== initialReviewFile,
              header:
                reviewPanel
                  .querySelector<HTMLElement>('[data-slot="session-review-v2-file-header"]')
                  ?.textContent?.trim() ?? "",
              replacedLevels,
            }
          : undefined
        const root = [...document.querySelectorAll<HTMLElement>(".scroll-view__viewport")].find((element) =>
          element.querySelector("[data-timeline-row]"),
        )
        if (root) {
          const view = root.getBoundingClientRect()
          const visible = [...root.querySelectorAll<HTMLElement>("[data-message-id]")]
            .filter((element) => {
              const rect = element.getBoundingClientRect()
              return rect.bottom > view.top && rect.top < view.bottom
            })
            .map((element) => element.dataset.messageId!)
          const hasVisibleRows = [...root.querySelectorAll<HTMLElement>("[data-timeline-key]")].some((element) => {
            const rect = element.getBoundingClientRect()
            return rect.bottom > view.top && rect.top < view.bottom
          })
          const requiredPartVisible = requiredPartID
            ? [...root.querySelectorAll<HTMLElement>("[data-timeline-part-id]")].some((element) => {
                if (element.dataset.timelinePartId !== requiredPartID) return false
                const rect = element.getBoundingClientRect()
                return rect.width > 0 && rect.height > 0 && rect.bottom > view.top && rect.top < view.bottom
              })
            : undefined
          const spacer = root.querySelector<HTMLElement>('[data-timeline-row="bottom-spacer"]')?.getBoundingClientRect()
          samples.push({
            observedAtMs,
            destination: visible.filter((id) => destination.has(id)),
            source: visible.filter((id) => source.has(id)),
            hasVisibleRows,
            last: visible.includes(lastID),
            requiredPartVisible,
            bottomAnchorRequired: requireBottomAnchor !== false,
            bottomErrorPx: spacer ? root.scrollHeight - root.clientHeight - root.scrollTop : undefined,
            review,
          })
        } else {
          samples.push({
            observedAtMs,
            destination: [],
            source: [],
            hasVisibleRows: false,
            last: false,
            requiredPartVisible: requiredPartID ? false : undefined,
            bottomAnchorRequired: requireBottomAnchor !== false,
            review,
          })
        }
        requestAnimationFrame(sample)
      }, 0)
    }
    document.addEventListener(
      "click",
      (event) => {
        const link = event.target instanceof Element ? event.target.closest("a") : undefined
        if (link?.getAttribute("href") !== href) return
        started = performance.now()
        for (const [name, selector] of Object.entries(reviewLevels)) {
          initialReviewNodes[name] = document.querySelector(selector)
        }
        requestAnimationFrame(sample)
      },
      { capture: true, once: true },
    )
    ;(window as Window & { __sessionSwitchProbe?: SessionSwitchProbe }).__sessionSwitchProbe = {
      samples,
      stop: () => {
        running = false
      },
    }
  }, input)
}

async function waitForStableSessionSwitch(page: Page, input: { lastID: string; requiredPartID?: string }) {
  await page.waitForFunction(() => {
    const samples = (window as Window & { __sessionSwitchProbe?: SessionSwitchProbe }).__sessionSwitchProbe?.samples
    if (!samples) return false
    return samples.some((_, index) => {
      const stable = samples.slice(index, index + 3)
      return (
        stable.length === 3 &&
        stable.every(
          (sample) =>
            sample.destination.length > 0 &&
            sample.source.length === 0 &&
            sample.last &&
            sample.requiredPartVisible !== false &&
            (sample.bottomAnchorRequired === false || Math.abs(sample.bottomErrorPx ?? Infinity) <= 1),
        )
      )
    })
  }, undefined, { timeout: 30_000 }).catch(async (error: unknown) => {
    const diagnostics = await page.evaluate(({ lastID, requiredPartID }) => {
      const probe = (window as Window & { __sessionSwitchProbe?: SessionSwitchProbe }).__sessionSwitchProbe
      const viewports = [...document.querySelectorAll<HTMLElement>(".scroll-view__viewport")]
      const root = viewports.find((element) => element.querySelector("[data-timeline-row]"))
      const view = root?.getBoundingClientRect()
      const bounds = (element: HTMLElement) => {
        const rect = element.getBoundingClientRect()
        return { top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height }
      }
      const visible = (element: HTMLElement) => {
        if (!view) return false
        const rect = element.getBoundingClientRect()
        return rect.width > 0 && rect.height > 0 && rect.bottom > view.top && rect.top < view.bottom
      }
      const messages = root ? [...root.querySelectorAll<HTMLElement>("[data-message-id]")] : []
      const parts = root ? [...root.querySelectorAll<HTMLElement>("[data-timeline-part-id]")] : []
      return {
        sampleCount: probe?.samples.length ?? 0,
        recent: probe?.samples.slice(-3) ?? [],
        viewportCount: viewports.length,
        viewport: root ? {
          ...bounds(root),
          scrollTop: root.scrollTop,
          scrollHeight: root.scrollHeight,
          clientHeight: root.clientHeight,
        } : undefined,
        lastMatches: messages.filter((element) => element.dataset.messageId === lastID).map(bounds),
        requiredPartMatches: parts.filter((element) => element.dataset.timelinePartId === requiredPartID).map(bounds),
        visibleMessageIDs: [...new Set(messages.filter(visible).map((element) => element.dataset.messageId))].slice(-64),
        visiblePartIDs: [...new Set(parts.filter(visible).map((element) => element.dataset.timelinePartId))].slice(-64),
        partIDs: [...new Set(parts.map((element) => element.dataset.timelinePartId))].slice(-200),
      }
    }, { lastID: input.lastID, requiredPartID: input.requiredPartID }).catch(() => undefined)
    if (!diagnostics) throw error
    throw new Error(
      `Session switch did not stabilize: ${JSON.stringify({ lastID: input.lastID, requiredPartID: input.requiredPartID, ...diagnostics })}`,
      { cause: error },
    )
  })
}

async function collectSessionSwitchResult(page: Page) {
  const samples = await page.evaluate(() => {
    const probe = (window as Window & { __sessionSwitchProbe?: SessionSwitchProbe }).__sessionSwitchProbe!
    probe.stop()
    return probe.samples
  })
  return classifySessionSwitch(samples)
}

export async function measureSessionSwitch(
  page: Page,
  input: {
    destinationIDs: string[]
    sourceIDs: string[]
    lastID: string
    requiredPartID?: string
    requireBottomAnchor?: boolean
    href: string
    switch: () => Promise<void>
  },
) {
  const { switch: run, ...probe } = input
  await installSessionSwitchProbe(page, probe)
  let failed = false
  try {
    await run()
    await waitForStableSessionSwitch(page, probe)
    return await collectSessionSwitchResult(page)
  } catch (error) {
    failed = true
    throw error
  } finally {
    await page.evaluate(() => {
      ;(window as Window & { __sessionSwitchProbe?: SessionSwitchProbe }).__sessionSwitchProbe?.stop()
    }).catch((error: unknown) => {
      if (!failed) throw error
    })
  }
}

export async function waitForStableTimeline(page: Page, lastID: string) {
  const samples: TimelineStabilitySample[] = []
  await expect
    .poll(
      async () => {
        samples.push(
          await page.evaluate(
            (lastID) =>
              new Promise<TimelineStabilitySample>((resolve) => {
                requestAnimationFrame(() =>
                  setTimeout(() => {
                    const viewports = [...document.querySelectorAll<HTMLElement>(".scroll-view__viewport")]
                    const root = viewports.find((element) =>
                      element.querySelector("[data-timeline-row]"),
                    )
                    if (!root) {
                      resolve({
                        last: false,
                        viewportCount: viewports.length,
                        timelineRowCount: document.querySelectorAll("[data-timeline-row]").length,
                      })
                      return
                    }
                    const view = root.getBoundingClientRect()
                    const matching = [...root.querySelectorAll<HTMLElement>("[data-message-id]")].filter(
                      (element) => element.dataset.messageId === lastID,
                    )
                    const last = matching.some((element) => {
                      const rect = element.getBoundingClientRect()
                      return rect.bottom > view.top && rect.top < view.bottom
                    })
                    const spacer = root
                      .querySelector<HTMLElement>('[data-timeline-row="bottom-spacer"]')
                      ?.getBoundingClientRect()
                    resolve({
                      last,
                      bottomErrorPx: spacer ? root.scrollHeight - root.clientHeight - root.scrollTop : undefined,
                      viewportCount: viewports.length,
                      timelineRowCount: root.querySelectorAll("[data-timeline-row]").length,
                      lastMessageCount: matching.length,
                      scrollTop: root.scrollTop,
                      scrollHeight: root.scrollHeight,
                      clientHeight: root.clientHeight,
                      viewportTop: view.top,
                      viewportBottom: view.bottom,
                      spacerBottom: spacer?.bottom,
                    })
                  }, 0),
                )
              }),
            lastID,
          ),
        )
        return isStableDestination(samples.slice(-3))
      },
      { timeout: 30_000, intervals: [0] },
    )
    .toBe(true)
    .catch((error: unknown) => {
      throw timelineStabilityError(lastID, samples, error)
    })
}
