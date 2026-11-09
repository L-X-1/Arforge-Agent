import { afterEach, beforeAll, expect, mock, test } from "bun:test"
import { plugin } from "bun"
import { createRequire } from "node:module"
import { createComponent } from "solid-js"
import { createStore } from "solid-js/store"
import { render } from "solid-js/web"
import { createOperationsApiForServer, type OperationsApi } from "@/utils/server"

type Snapshot = Awaited<ReturnType<OperationsApi["runtimeInsight"]["snapshot"]>>
type Verification = Awaited<ReturnType<OperationsApi["runtimeInsight"]["auditVerify"]>>
let Workbench: typeof import("./runtime-insight-workbench").RuntimeInsightWorkbench
const disposals: (() => void)[] = []
const settle = async () => {
  for (let i = 0; i < 4; i++) await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

beforeAll(async () => {
  const require = createRequire(import.meta.resolve("vite-plugin-solid"))
  const babel: {
    transformSync(source: string, options: Record<string, unknown>): { code?: string | null } | null
  } = require("@babel/core")
  const solid = require("babel-preset-solid")
  plugin({
    name: "runtime-audit-verification-dom",
    setup(build) {
      build.onLoad({ filter: /[\\/]packages[\\/](app|ui)[\\/]src[\\/].*\.tsx$/ }, async ({ path }) => {
        const result = babel.transformSync(await Bun.file(path).text(), {
          filename: path,
          configFile: false,
          babelrc: false,
          parserOpts: { plugins: ["typescript", "jsx"] },
          presets: [[solid.default ?? solid, { generate: "dom" }]],
        })
        if (!result?.code) throw new Error("Solid compilation failed: " + path)
        return { contents: result.code, loader: "ts" }
      })
    },
  })
  await mock.module("@/context/language", () => ({
    useLanguage: () => ({ locale: () => "en", intl: () => "en", t: (key: string) => key }),
  }))
  // The separate receipt inspector is outside this audit-chain request owner.
  await mock.module("./artifact-evidence-workbench", () => ({ ArtifactEvidenceWorkbench: () => null }))
  Workbench = (await import("./runtime-insight-workbench")).RuntimeInsightWorkbench
})

afterEach(() => {
  for (const dispose of disposals.splice(0)) dispose()
  document.body.replaceChildren()
})

function deferred<T = Verification>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept
    reject = fail
  })
  return { promise, resolve, reject }
}

const verified = (count: number): Verification => ({ valid: true, count, headHash: "head-" + count, issue: null })
function snapshot(directory: string): Snapshot {
  return {
    access: {
      role: "owner",
      canReviewMutation: true,
      canRollbackMutation: true,
      canMaintainArtifacts: true,
      canRecordMcpEvidence: true,
    },
    contextLayers: [],
    routing: [],
    verifications: [],
    runs: [],
    durableRuns: [],
    durableActions: [],
    recalls: [],
    auditDropped: 0,
    auditVerify: verified(1),
    audit: [
      {
        seq: 1,
        recordedAt: 1000,
        actor: "owned-user",
        action: "run.state.changed",
        resource: directory + "/retained-row",
        reason: null,
        metadata: {},
        previousHash: "genesis",
        recordHash: "head-1",
      },
    ],
  }
}

function fixture(scope?: Verification["scope"]) {
  const requests: string[] = []
  const pending: ReturnType<typeof deferred<Verification>>[] = []
  const maintenance: { reject: (error: Error) => void }[] = []
  const [source, setSource] = createStore({ directory: "E:/audit-A", workspace: "workspace-A", ready: true })
  const transport = createOperationsApiForServer({
    server: { url: "http://127.0.0.1:4096" },
    fetch: Object.assign(
      async () => {
        throw new Error("Unexpected transport outside the audit UI fixture")
      },
      { preconnect: globalThis.fetch.preconnect },
    ),
  })
  // Control the already-typed request promises, below this UI's request guards.
  // Real transport rejection/retries are retained in run-uvEW2T, not simulated here.
  const api: OperationsApi = {
    ...transport,
    runtimeInsight: {
      ...transport.runtimeInsight,
      snapshot: async (input) => {
        if (typeof input?.location?.directory !== "string") throw new Error("Expected the captured audit source")
        requests.push("/snapshot")
        return { ...snapshot(input.location.directory), auditVerify: { ...verified(1), ...(scope === undefined ? {} : { scope }) } }
      },
      auditVerify: () => {
        requests.push("/audit/verify")
        const next = deferred()
        pending.push(next)
        return next.promise
      },
      artifactMaintenance: () => {
        const next = deferred<Awaited<ReturnType<OperationsApi["runtimeInsight"]["artifactMaintenance"]>>>()
        maintenance.push(next)
        return next.promise
      },
    },
  }
  const host = document.createElement("div")
  document.body.append(host)
  disposals.push(
    render(
      () =>
        createComponent(Workbench, {
          api: () => api,
          location: () => ({ location: { directory: source.directory, workspace: source.workspace } }),
          ready: () => source.ready,
        }),
      host,
    ),
  )
  disposals.push(() => {
    for (const request of pending) request.resolve(verified(0))
    for (const request of maintenance) request.reject(new Error("Artifact fixture disposed"))
  })
  const action = async (label: RegExp) => {
    const trigger = host.querySelector<HTMLButtonElement>('button[aria-label="More actions"]')!
    if (trigger.getAttribute("aria-expanded") !== "true") {
      trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }))
      await settle()
    }
    const menu = document.querySelector<HTMLElement>("[data-management-action-menu]")!
    menu.style.animationName = "none"
    const item = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((entry) =>
      label.test(entry.textContent ?? ""),
    )
    if (!item) throw new Error("Audit action missing: " + menu.textContent)
    item.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }))
    await settle()
  }
  const verify = () => action(/Verify tamper protection|Verify audit chain|Verify my audit records|Verifying/)
  const busy = () => host.getAttribute("aria-busy") ?? host.querySelector("section")!.getAttribute("aria-busy")
  const text = () => host.textContent ?? ""
  const error = () => host.querySelector('[data-testid="runtime-insight-error"]')
  const success = () => /Audit chain verified:/.test(text())
  const row = () => host.querySelector('[data-management-detail-id="1"]')?.textContent
  return { host, setSource, requests, pending, maintenance, action, verify, busy, text, error, success, row }
}

test("recheck pending/failure hides prior success, retains rows, and Retry read does not invent a verdict", async () => {
  const f = fixture()
  await settle()
  const row = f.row()
  expect(row).toContain("retained-row")
  await f.verify()
  f.pending[0].resolve(verified(30))
  await settle()
  expect(f.text()).toContain("Audit chain verified: 30 records are intact.")

  await f.verify()
  expect(f.pending).toHaveLength(2)
  expect(f.busy()).toBe("true")
  expect(f.success()).toBe(false)
  expect(f.text()).not.toContain("Intact (")
  expect(f.row()).toBe(row)
  f.pending[1].reject(new Error("Transport unavailable"))
  await settle()
  expect(f.error()?.textContent).toContain("Transport unavailable")
  expect(f.success()).toBe(false)
  expect(f.text()).not.toContain("Intact (")
  expect(f.text()).not.toContain("Audit chain verification failed:")
  expect(f.busy()).toBe("false")
  expect(f.row()).toBe(row)

  const retry = [...f.error()!.querySelectorAll("button")].find((button) => button.textContent === "Retry read")!
  retry.click()
  await settle()
  expect(f.requests.filter((path) => path.endsWith("/snapshot"))).toHaveLength(2)
  expect(f.pending).toHaveLength(2)
  expect(f.error()).toBeNull()
  expect(f.success()).toBe(false)
  expect(f.text()).not.toContain("Intact (")
  expect(f.row()).toBe(row)
  await f.verify()
  f.pending[2].resolve(verified(31))
  await settle()
  expect(f.text()).toContain("Audit chain verified: 31 records are intact.")
  expect(f.error()).toBeNull()
})

test("a successful verification retry clears the old request error and displays the actual invalid-chain result", async () => {
  const f = fixture()
  await settle()
  await f.verify()
  f.pending[0].reject(new Error("First check unavailable"))
  await settle()
  expect(f.error()).not.toBeNull()
  await f.verify()
  expect(f.error()).toBeNull()
  f.pending[1].resolve({ valid: false, count: 1, headHash: "head-1", issue: "Hash mismatch at record 1" })
  await settle()
  expect(f.text()).toContain("Audit chain verification failed: Hash mismatch at record 1")
  expect(f.text()).not.toContain("Intact (")
  expect(f.success()).toBe(false)
  expect(f.row()).toContain("retained-row")
})

test("another action clearing a failed verification error cannot restore the old snapshot's green status", async () => {
  const f = fixture()
  await settle()
  await f.verify()
  f.pending[0].resolve(verified(30))
  await settle()
  await f.verify()
  f.pending[1].reject(new Error("Recheck transport unavailable"))
  await settle()
  expect(f.error()).not.toBeNull()
  expect(f.text()).not.toContain("Intact (")
  const row = f.row()
  await f.action(/Audit artifact state/)
  expect(f.maintenance).toHaveLength(1)
  expect(f.error()).toBeNull()
  expect(f.success()).toBe(false)
  expect(f.text()).not.toContain("Intact (")
  expect(f.row()).toBe(row)
  f.maintenance[0].reject(new Error("Artifact maintenance unavailable"))
  await settle()
  expect(f.error()?.textContent).toContain("Artifact maintenance unavailable")
  expect(f.success()).toBe(false)
})

for (const late of ["success", "failure"] as const) {
  test("previous workspace " + late + " cannot publish or finish the new workspace verification", async () => {
    const f = fixture()
    await settle()
    await f.verify()
    f.setSource({ directory: "E:/audit-B", workspace: "workspace-B" })
    await settle()
    await f.verify()
    expect(f.pending).toHaveLength(2)
    if (late === "success") f.pending[0].resolve(verified(99))
    else f.pending[0].reject(new Error("Old workspace failure"))
    await settle()
    expect(f.success()).toBe(false)
    expect(f.error()).toBeNull()
    expect(f.text()).not.toContain("Verification result received locally at")
    expect(f.text()).not.toContain("User-initiated verification result")
    expect(f.busy()).toBe("true")
    expect(f.row()).toContain("audit-B/retained-row")
    f.pending[1].resolve(verified(2))
    await settle()
    expect(f.text()).toContain("Audit chain verified: 2 records are intact.")
    expect(f.text()).toContain("User-initiated verification result")
    expect(f.text()).toContain("Verification result received locally at")
    expect(f.busy()).toBe("false")
  })
}

test("source readiness loss clears prior verification and fences an old response after the same source returns", async () => {
  const f = fixture()
  await settle()
  await f.verify()
  f.pending[0].resolve(verified(30))
  await settle()
  expect(f.success()).toBe(true)
  f.setSource("ready", false)
  await settle()
  expect(f.success()).toBe(false)
  expect(f.text()).not.toContain("Verification result received locally at")
  f.setSource("ready", true)
  await settle()
  await f.verify()
  f.setSource("ready", false)
  await settle()
  f.setSource("ready", true)
  await settle()
  await f.verify()
  expect(f.pending).toHaveLength(3)
  f.pending[1].resolve(verified(99))
  await settle()
  expect(f.success()).toBe(false)
  expect(f.busy()).toBe("true")
  f.pending[2].resolve(verified(3))
  await settle()
  expect(f.text()).toContain("Audit chain verified: 3 records are intact.")
  expect(f.busy()).toBe("false")
})

test("typed principal record verification stays usable and never claims whole-profile chain continuity", async () => {
  const f = fixture("principal-records")
  await settle()
  await f.verify()
  f.pending[0]!.resolve({ ...verified(2), scope: "principal-records" })
  await settle()
  expect(f.text()).toContain("My audit records verified: 2 record digests are intact")
  expect(f.text()).toContain("Full profile chain continuity is not checked")
  expect(f.text()).not.toContain("Audit chain verified:")
  expect(f.text()).toContain("Scope: my records in the current process")
  await f.verify()
  f.pending[1]!.resolve({ valid: false, count: 2, headHash: "own-head", issue: "Owned digest mismatch", scope: "principal-records" })
  await settle()
  expect(f.text()).toContain("My audit record verification failed: Owned digest mismatch")
  expect(f.text()).not.toContain("Audit chain verification failed:")
  expect(f.busy()).toBe("false")
})

test("automatic snapshot verification result is labeled automatic and carries no user receipt time", async () => {
  const f = fixture()
  await settle()
  // The snapshot already contains an audit verification result, but that is an
  // automatic snapshot, not a user-initiated verification receipt.
  expect(f.text()).toContain("Chain status")
  expect(f.text()).toContain("Intact (1)")
  expect(f.text()).toContain("Automatic snapshot result")
  expect(f.text()).toContain("Scope: current process audit chain")
  expect(f.text()).not.toContain("User-initiated verification result")
  expect(f.text()).not.toContain("Verification result received locally at")
  expect(f.success()).toBe(false)
})

test("user verification receipt binds the result to its local time and never reuses it", async () => {
  const originalNow = Date.now
  let now = new Date("2026-11-08T02:30:00Z").getTime()
  Date.now = () => now
  try {
    const f = fixture()
    await settle()
    expect(f.text()).not.toContain("Verification result received locally at")

    // No result yet: no receipt time may be written.
    await f.verify()
    expect(f.text()).not.toContain("Verification result received locally at")
    f.pending[0].resolve(verified(30))
    await settle()
    const firstReceipt = "Verification result received locally at " + new Date(now).toLocaleTimeString("en")
    expect(f.text()).toContain("User-initiated verification result")
    expect(f.text()).toContain(firstReceipt)

    // A retry clears the old receipt; a failed request publishes no new time.
    now = new Date("2026-11-08T02:40:00Z").getTime()
    await f.verify()
    expect(f.text()).not.toContain("Verification result received locally at")
    f.pending[1].reject(new Error("Transport unavailable"))
    await settle()
    expect(f.text()).not.toContain("Verification result received locally at")
    expect(f.text()).not.toContain(firstReceipt)

    // A received failing result gets its own local receipt time, not the old one.
    now = new Date("2026-11-08T02:50:00Z").getTime()
    await f.verify()
    f.pending[2].resolve({ valid: false, count: 1, headHash: "head-1", issue: "Hash mismatch at record 1" })
    await settle()
    const failureReceipt = "Verification result received locally at " + new Date(now).toLocaleTimeString("en")
    expect(f.text()).toContain("Audit chain verification failed: Hash mismatch at record 1")
    expect(f.text()).toContain(failureReceipt)
    expect(f.text()).not.toContain(firstReceipt)
  } finally {
    Date.now = originalNow
  }
})
