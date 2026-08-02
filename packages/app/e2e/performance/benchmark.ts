import {
  expect,
  test as base,
  type Browser,
  type ConsoleMessage,
  type Page,
  type Request,
  type Response,
  type TestInfo,
} from "@playwright/test"
import { startChromeTrace } from "./chrome-trace"

type BenchmarkFixtures = {
  report: (metrics: Record<string, unknown>, context?: Record<string, unknown>) => void
  reportState: { payload?: { metrics: Record<string, unknown>; context: Record<string, unknown> } }
  benchmarkResult: void
}

export type PerformancePageDiagnostics = {
  navigations: string[]
  consoleErrors: Array<{ text: string; location: ReturnType<ConsoleMessage["location"]> }>
  pageErrors: Array<{ message: string; stack?: string }>
  networkErrors: Array<{ method: string; url: string; status?: number; failure?: string }>
  stop: () => Promise<string | undefined>
}

const pages = new WeakMap<Page, PerformancePageDiagnostics>()

export const benchmark = base.extend<BenchmarkFixtures>({
  reportState: async ({}, use) => use({}),
  report: async ({ reportState }, use) => {
    await use((metrics, context = {}) => {
      if (reportState.payload) throw new Error("Benchmark reported metrics more than once")
      reportState.payload = { metrics, context }
    })
  },
  benchmarkResult: [
    async ({ reportState }, use, testInfo) => {
      await use()
      const missing = !reportState.payload
      console.log(
        `BENCHMARK ${JSON.stringify({
          schemaVersion: 2,
          runID: process.env.ARFORGE_PERFORMANCE_RUN_ID,
          name: benchmarkName(testInfo),
          status: missing ? "failed" : testInfo.status,
          expectedStatus: testInfo.expectedStatus,
          retry: testInfo.retry,
          repeatEachIndex: testInfo.repeatEachIndex,
          context: {
            project: testInfo.project.name,
            platform: process.platform,
            ...reportState.payload?.context,
          },
          metrics: reportState.payload?.metrics ?? null,
          error: missing ? "Benchmark did not report metrics" : undefined,
        })}`,
      )
      if (missing && testInfo.status === testInfo.expectedStatus)
        throw new Error(`Benchmark did not report metrics: ${benchmarkName(testInfo)}`)
    },
    { auto: true },
  ],
  page: async ({ page }, use, testInfo) => {
    const name = benchmarkName(testInfo)
    const diagnostics = await observePerformancePage(page, name)
    try {
      await use(page)
    } finally {
      try {
        await reportPerformancePage(name, diagnostics, testInfo)
      } finally {
        if (testInfo.status !== testInfo.expectedStatus) {
          await testInfo.attach("performance-navigations", {
            body: JSON.stringify(diagnostics.navigations, null, 2),
            contentType: "application/json",
          })
          await testInfo.attach("performance-browser-errors", {
            body: JSON.stringify(
              {
                console: diagnostics.consoleErrors,
                page: diagnostics.pageErrors,
                network: diagnostics.networkErrors,
              },
              null,
              2,
            ),
            contentType: "application/json",
          })
        }
      }
    }
  },
})

function benchmarkName(testInfo: TestInfo) {
  return testInfo.titlePath.slice(1).join(" > ")
}

export { expect }

async function observePerformancePage(page: Page, name: string) {
  const navigations: string[] = []
  const consoleErrors: PerformancePageDiagnostics["consoleErrors"] = []
  const pageErrors: PerformancePageDiagnostics["pageErrors"] = []
  const networkErrors: PerformancePageDiagnostics["networkErrors"] = []
  const onNavigation = (frame: ReturnType<Page["mainFrame"]>) => {
    if (frame === page.mainFrame()) navigations.push(frame.url())
  }
  const onConsole = (message: ConsoleMessage) => {
    if (message.type() === "error") {
      consoleErrors.push({
        text: message.text(),
        location: message.location(),
      })
    }
  }
  const onPageError = (error: Error) => {
    pageErrors.push({ message: error.message, stack: error.stack })
  }
  const onRequestFailed = (request: Request) => {
    const failure = request.failure()?.errorText
    if (failure === "net::ERR_ABORTED") return
    networkErrors.push({
      method: request.method(),
      url: request.url(),
      failure,
    })
  }
  const onResponse = (response: Response) => {
    if (response.status() < 400) return
    networkErrors.push({
      method: response.request().method(),
      url: response.url(),
      status: response.status(),
    })
  }
  page.on("framenavigated", onNavigation)
  page.on("console", onConsole)
  page.on("pageerror", onPageError)
  page.on("requestfailed", onRequestFailed)
  page.on("response", onResponse)
  const stopTrace = await startChromeTrace(page, name).catch((error) => {
    page.off("framenavigated", onNavigation)
    page.off("console", onConsole)
    page.off("pageerror", onPageError)
    page.off("requestfailed", onRequestFailed)
    page.off("response", onResponse)
    throw error
  })
  let stopping: Promise<string | undefined> | undefined
  const diagnostics: PerformancePageDiagnostics = {
    navigations,
    consoleErrors,
    pageErrors,
    networkErrors,
    stop() {
      page.off("framenavigated", onNavigation)
      page.off("console", onConsole)
      page.off("pageerror", onPageError)
      page.off("requestfailed", onRequestFailed)
      page.off("response", onResponse)
      return (stopping ??= stopTrace?.() ?? Promise.resolve(undefined))
    },
  }
  pages.set(page, diagnostics)
  return diagnostics
}

export async function withBenchmarkPage<T>(
  browser: Browser,
  name: string,
  run: (page: Page) => Promise<T>,
  testInfo?: TestInfo,
) {
  const context = await browser.newContext()
  try {
    const page = await context.newPage()
    const diagnostics = await observePerformancePage(page, name)
    try {
      return await run(page)
    } finally {
      await reportPerformancePage(name, diagnostics, testInfo)
    }
  } finally {
    await context.close()
  }
}

async function reportPerformancePage(name: string, diagnostics: PerformancePageDiagnostics, testInfo?: TestInfo) {
  const trace = await diagnostics.stop()
  console.log(
    `BENCHMARK_PAGE ${JSON.stringify({
      schemaVersion: 2,
      runID: process.env.ARFORGE_PERFORMANCE_RUN_ID,
      name,
      test: testInfo ? benchmarkName(testInfo) : undefined,
      retry: testInfo?.retry,
      repeatEachIndex: testInfo?.repeatEachIndex,
      context: {
        platform: process.platform,
        trace,
        selectorTrace: process.env.ARFORGE_PERFORMANCE_SELECTOR_TRACE === "1",
      },
      navigations: diagnostics.navigations,
      consoleErrors: diagnostics.consoleErrors,
      pageErrors: diagnostics.pageErrors,
      networkErrors: diagnostics.networkErrors,
    })}`,
  )
}

export function benchmarkDiagnostics(page: Page) {
  const diagnostics = pages.get(page)
  if (!diagnostics) throw new Error("Performance diagnostics are not installed for this page")
  return diagnostics
}
