import { test, expect, type Locator } from "@playwright/test"
import { setupTimelineBenchmark, buildInitialStreamEvent } from "../timeline/session-timeline-benchmark.fixture"

type ReadingPosition = { scrollTop: number; anchor: { key: string; offset: number } }
type TimelineGeometry = ReadingPosition & {
  scrollHeight: number
  clientHeight: number
  clientWidth: number
  viewportTop: number
  viewportHeight: number
  viewportWidth: number
}

const waitForStableReadingPosition = (scroller: Locator) =>
  scroller.evaluate((element) => new Promise<TimelineGeometry>((resolve, reject) => {
    let frame = 0
    let finished = false
    let previous: TimelineGeometry | undefined
    let stableSince = 0
    let stableFrames = 0
    const stop = () => {
      finished = true
      cancelAnimationFrame(frame)
      clearTimeout(timeout)
    }
    const timeout = window.setTimeout(() => {
      stop()
      reject(new Error(
        "Timed out waiting for loaded fonts and stable timeline geometry/anchor: "
        + JSON.stringify({ fonts: document.fonts.status, geometry: previous }),
      ))
    }, 5000)

    const sample = (now: number) => {
      if (finished) return
      const viewport = element.getBoundingClientRect()
      const anchor = Array.from(element.querySelectorAll<HTMLElement>("[data-timeline-key]"))
        .filter((row) => !row.querySelector('[data-timeline-row="TurnGap"]'))
        .map((row) => ({ key: row.dataset.timelineKey, rect: row.getBoundingClientRect() }))
        .filter((row) => row.key && row.rect.height > 0 && row.rect.bottom > viewport.top && row.rect.top < viewport.bottom)
        .sort((a, b) => a.rect.top - b.rect.top)[0]
      if (!element.isConnected || document.fonts.status !== "loaded" || viewport.height <= 0 || !anchor?.key) {
        previous = undefined
        stableFrames = 0
        stableSince = now
      } else {
        const geometry: TimelineGeometry = {
          scrollTop: element.scrollTop,
          scrollHeight: element.scrollHeight,
          clientHeight: element.clientHeight,
          clientWidth: element.clientWidth,
          viewportTop: viewport.top,
          viewportHeight: viewport.height,
          viewportWidth: viewport.width,
          anchor: { key: anchor.key, offset: anchor.rect.top - viewport.top },
        }
        if (JSON.stringify(geometry) === JSON.stringify(previous)) {
          stableFrames++
        } else {
          stableFrames = 1
          stableSince = now
        }
        previous = geometry
        if (stableFrames >= 3 && now - stableSince >= 250) {
          stop()
          resolve(geometry)
          return
        }
      }
      frame = requestAnimationFrame(sample)
    }

    void document.fonts.ready.then(() => {
      if (!finished) frame = requestAnimationFrame(sample)
    }).catch((error: unknown) => {
      if (finished) return
      stop()
      reject(error)
    })
  }))

const expectReadingPositionUnchanged = async (scroller: Locator, before: ReadingPosition) => {
  const after = await scroller.evaluate((element, key) => {
    const viewport = element.getBoundingClientRect()
    const row = element.querySelector<HTMLElement>('[data-timeline-key="' + CSS.escape(key) + '"]')
    const rect = row?.getBoundingClientRect()
    return {
      scrollTop: element.scrollTop,
      anchor: row && rect && rect.height > 0 && rect.bottom > viewport.top && rect.top < viewport.bottom
        ? { key: row.dataset.timelineKey, offset: rect.top - viewport.top }
        : undefined,
    }
  }, before.anchor.key)
  expect(after.scrollTop).toBe(before.scrollTop)
  expect(after.anchor).toEqual(before.anchor)
}

test("desktop history preview preserves reading position and permits crossing into the card", async ({ page }) => {
  const fixture = await setupTimelineBenchmark(page, { historyTurns: 12, eventBatch: 1, newLayoutDesigns: true })
  const first = page.locator("[data-history-message-id]").first()
  const before = await waitForStableReadingPosition(fixture.scroller)
  await first.hover()
  const preview = page.locator('[data-component="history-rail-preview"]')
  await expect(preview).toBeVisible()
  await expectReadingPositionUnchanged(fixture.scroller, before)
  await preview.hover()
  await page.waitForTimeout(250)
  await expect(preview).toBeVisible()
  await expectReadingPositionUnchanged(fixture.scroller, before)
  const id = await first.getAttribute("data-history-message-id")
  await preview.locator("[data-history-jump]").click()
  await expect(page.locator('[id="message-' + id + '"]')).toBeInViewport()
  await expect(preview).toHaveCount(0)
})

test("history keyboard entry pages by stable message identity and Escape restores focus", async ({ page }) => {
  await setupTimelineBenchmark(page, { historyTurns: 80, eventBatch: 1, newLayoutDesigns: true })
  const current = page.locator('[data-history-message-id][tabindex="0"]')
  await current.focus()
  await current.press("Home")
  const first = page.locator("[data-history-message-id]").first()
  await expect(first).toBeFocused()
  await page.keyboard.press("Escape")
  await expect(page.locator('[data-component="history-rail-preview"]')).toHaveCount(0)
  await expect(first).toBeFocused()
  await first.press("Enter")
  const id = await first.getAttribute("data-history-message-id")
  await expect(page.locator('[id="message-' + id + '"]')).toBeInViewport()
})

test.describe("touch history", () => {
  test.use({ hasTouch: true })
  test("touch previews until explicit jump or close, with separate 44px targets", async ({ page }) => {
    await setupTimelineBenchmark(page, { historyTurns: 12, eventBatch: 1, newLayoutDesigns: true })
    await page.setViewportSize({ width: 390, height: 844 })
    const first = page.locator("[data-history-message-id]").first()
    const route = page.url()
    await first.tap()
    const preview = page.locator('[data-component="history-rail-preview"]')
    await expect(preview).toBeVisible()
    await page.waitForTimeout(400)
    await expect(preview).toBeVisible()
    expect(page.url()).toBe(route)
    expect((await first.boundingBox())!.height).toBeGreaterThanOrEqual(44)
    await preview.locator("[data-history-close]").tap()
    await expect(preview).toHaveCount(0)
    await first.tap()
    await preview.locator("[data-history-jump]").tap()
    await expect(preview).toHaveCount(0)
  })
})

test("composer has real 2-8 line bounds, keeps its toolbar visible, and does not submit IME Enter", async ({ page }) => {
  await setupTimelineBenchmark(page, { historyTurns: 1, eventBatch: 1, newLayoutDesigns: true })
  const editor = page.locator('[data-slot="prompt-input-editor"]')
  await expect(editor).toBeVisible()
  const bounds = await editor.evaluate((element) => {
    const style = getComputedStyle(element)
    const padding = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom)
    return {
      line: parseFloat(style.lineHeight),
      min: parseFloat(style.minHeight) - padding,
      max: parseFloat(style.maxHeight) - padding,
    }
  })
  // Chromium quantizes each used lh to 1/64 CSS px before multiplying it.
  // Validate the two-line minimum per line, then the exact 2-to-8-line ratio.
  const layoutQuantum = 1 / 64
  expect(Math.abs(bounds.min / 2 - bounds.line)).toBeLessThanOrEqual(layoutQuantum)
  expect(Math.abs(bounds.max - 4 * bounds.min)).toBeLessThanOrEqual(layoutQuantum)
  const draft = Array.from({ length: 12 }, (_, i) => "Draft line " + i).join("\n")
  await editor.fill(draft)
  expect(await editor.innerText()).toBe(draft)
  expect(await editor.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true)
  await expect(page.locator('[data-slot="prompt-input-footer"]')).toBeInViewport()
  const sessionWrites: Array<{ method: string; path: string }> = []
  page.on("request", (request) => {
    const method = request.method()
    const path = new URL(request.url()).pathname
    if (["POST", "PUT", "PATCH", "DELETE"].includes(method) && /\/(?:sessions?|queue)(?:\/|$)/.test(path)) {
      sessionWrites.push({ method, path })
    }
  })
  await editor.dispatchEvent("compositionstart")
  await editor.dispatchEvent("keydown", { key: "Enter", keyCode: 229, isComposing: true, bubbles: true })
  await editor.dispatchEvent("compositionend")
  // Let input reconciliation and scheduled browser work complete before checking.
  await editor.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  }))
  expect(await editor.innerText()).toBe(draft)
  await expect(page.locator('[data-action="prompt-model"] [data-component="provider-icon"]')).toHaveCount(0)
  expect(sessionWrites).toEqual([])
})

test("real streamed Markdown uses review typography, spacing and native list semantics", async ({ page }) => {
  const fixture = await setupTimelineBenchmark(page, { historyTurns: 1, eventBatch: 1, newLayoutDesigns: true })
  const event = buildInitialStreamEvent(1)
  const properties = event.payload.properties as { part: { text: string } }
  properties.part.text = "# Heading\n\nBody paragraph.\n\n> Quoted text.\n\n- Bullet\n\n7. Ordered item\n8. Next item"
  fixture.transport.enqueue(event)
  const markdown = fixture.text.locator('[data-component="markdown"]')
  await expect(markdown.locator("blockquote")).toBeVisible()
  const style = await markdown.evaluate((element) => {
    const p = element.querySelector("p")!
    const heading = element.querySelector("h1")!
    const quote = element.querySelector("blockquote")!
    const ol = element.querySelector("ol")!
    const body = getComputedStyle(p)
    const q = getComputedStyle(quote)
    return {
      bodySize: body.fontSize, bodyWeight: body.fontWeight, bodyLine: body.lineHeight,
      heading: getComputedStyle(heading).fontSize, headingFont: getComputedStyle(heading).fontFamily,
      quoteSize: q.fontSize, quoteRadius: q.borderRadius, quoteBorder: q.borderLeftWidth,
      quotePadding: q.padding, orderedFont: getComputedStyle(ol).fontFamily, start: ol.start,
      headingGap: p.getBoundingClientRect().top - heading.getBoundingClientRect().bottom,
      quoteGap: quote.getBoundingClientRect().top - p.getBoundingClientRect().bottom,
    }
  })
  expect(style.bodySize).toBe("17px")
  expect(style.bodyWeight).toBe("400")
  expect(parseFloat(style.bodyLine)).toBeCloseTo(30.6, 1)
  expect(style.heading).toBe("28px")
  expect(style.headingFont).toContain("Noto Serif SC")
  expect(style.quoteSize).toBe("18px")
  expect(style.quoteRadius).toBe("16px")
  expect(style.quoteBorder).toBe("0px")
  expect(style.quotePadding).toBe("16px 20px")
  expect(style.orderedFont).toContain("Noto Serif SC")
  expect(style.start).toBe(7)
  expect(style.headingGap).toBeCloseTo(12, 0)
  expect(style.quoteGap).toBeCloseTo(24, 0)
  await page.evaluate(() => document.documentElement.style.setProperty("--font-family-sans", "Georgia"))
  expect(await markdown.locator("p").first().evaluate((element) => getComputedStyle(element).fontFamily)).toBe("Georgia")
})

test("multi-paragraph list items retain spacing around an intervening nested list", async ({ page }) => {
  const fixture = await setupTimelineBenchmark(page, { historyTurns: 1, eventBatch: 1, newLayoutDesigns: true })
  const event = buildInitialStreamEvent(1)
  const properties = event.payload.properties as { part: { text: string } }
  properties.part.text = '<ul><li><p>First paragraph</p><ul><li>Nested item</li></ul><p>Continued paragraph</p></li><li><p>Following item</p></li></ul>'
  fixture.transport.enqueue(event)
  const markdown = fixture.text.locator('[data-component="markdown"]')
  await expect(markdown.getByText("Continued paragraph", { exact: true })).toBeVisible()
  const spacing = await markdown.evaluate((element) => {
    const list = element.querySelector("ul")!
    const first = list.children[0]!
    const next = list.children[1]!
    const paragraphs = first.querySelectorAll(":scope > p")
    return {
      item: getComputedStyle(next).marginTop,
      paragraph: getComputedStyle(paragraphs[1]!).marginTop,
      nested: first.querySelectorAll(":scope > ul > li").length,
      count: list.children.length,
    }
  })
  expect(spacing).toEqual({ item: "24px", paragraph: "16px", nested: 1, count: 2 })
})
