// Focused rendered check for the read-only local-operations cards.
// Run explicitly from packages/app with:
//   bun test --conditions=browser --preload ./happydom.ts test-browser/local-operations-snapshot.isolated.ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { plugin } from "bun"
import { createRequire } from "node:module"
import { createComponent, type JSX } from "solid-js"
import { render } from "solid-js/web"
import type { LocalOperationsOverview } from "@/components/control-center/local-operations-snapshot"

type SnapshotModule = typeof import("@/components/control-center/local-operations-snapshot")

let copy: SnapshotModule
const disposals: (() => void)[] = []

beforeAll(async () => {
  const require = createRequire(import.meta.resolve("vite-plugin-solid"))
  const babel = require("@babel/core") as {
    transformSync(source: string, options: Record<string, unknown>): { code?: string | null } | null
  }
  const solid = require("babel-preset-solid")
  await plugin({
    name: "local-operations-snapshot-solid-dom",
    setup(build) {
      build.onLoad({ filter: /[\\/]packages[\\/]app[\\/]src[\\/]components[\\/]control-center[\\/]local-operations-snapshot\.tsx$/ }, async ({ path }) => {
        const result = babel.transformSync(await Bun.file(path).text(), {
          filename: path,
          configFile: false,
          babelrc: false,
          parserOpts: { plugins: ["typescript", "jsx"] },
          presets: [[solid.default ?? solid, { generate: "dom" }]],
        })
        if (!result?.code) throw new Error(`Solid compilation failed: ${path}`)
        return { contents: result.code, loader: "ts" }
      })
    },
  })
  copy = await import("@/components/control-center/local-operations-snapshot")
})

afterAll(() => {
  for (const dispose of disposals.splice(0)) dispose()
})

function mount(element: () => JSX.Element) {
  const host = document.createElement("div")
  document.body.append(host)
  const dispose = render(element, host)
  disposals.push(() => {
    dispose()
    host.remove()
  })
  return host
}

const t = (message: string) => message

function overview(overrides: {
  backup?: Partial<LocalOperationsOverview["backup"]>
  recoveryDrill?: Partial<LocalOperationsOverview["recoveryDrill"]>
  windowsBackupTasks?: LocalOperationsOverview["windowsBackupTasks"]
} = {}): LocalOperationsOverview {
  return {
    schemaVersion: 1,
    generatedAt: "2026-11-08T00:00:00.000Z",
    readOnly: true,
    doctor: { ok: true, passed: 1, failed: 0, checks: [] },
    usage: {
      sessions: 0,
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    backup: {
      available: true,
      createdAt: "2026-11-08T00:00:00.000Z",
      database: "arforge",
      bytes: 2048,
      encrypted: true,
      checksumVerified: true,
      restoreListVerified: true,
      fileState: "available",
      checksumState: "verified",
      catalogState: "recorded",
      ...overrides.backup,
    },
    recoveryDrill: {
      available: true,
      completedAt: "2026-11-08T00:10:00.000Z",
      passed: true,
      tables: 7,
      sourceRows: 1234,
      restoredRows: 1234,
      differences: 0,
      state: "verified",
      bound: true,
      ...overrides.recoveryDrill,
    },
    secrets: { filesScanned: 0, filesSkipped: 0, findingFiles: 0, findings: 0, truncated: false },
    logs: { retentionDays: 30, cutoff: "2026-10-09T00:00:00.000Z", files: 0, bytes: 0 },
    windowsBackupTasks: overrides.windowsBackupTasks ?? [
      {
        name: "Arforge PostgreSQL Backup",
        status: "succeeded",
        lastRunAt: "2026-11-08T02:00:00.000Z",
        exitCode: 0,
      },
      {
        name: "Arforge Private PostgreSQL Backup",
        status: "failed",
        lastRunAt: "2026-11-08T03:00:00.000Z",
        exitCode: 1,
      },
    ],
  }
}

const intl = () => "en-US"

describe("local operations cards render truthful states", () => {
  test("renders verified archive, checksum and recorded catalog states separately", () => {
    const host = mount(() => createComponent(copy.BackupSnapshot, { overview: overview(), t }))
    const text = host.textContent ?? ""
    expect(text).toContain("备份文件")
    expect(text).toContain("存在")
    expect(text).toContain("SHA-256 校验")
    expect(text).toContain("已核验")
    expect(text).toContain("归档校验")
    expect(text).toContain("已记录")
    expect(text).toContain("2048 B")
  })

  test("renders a digest mismatch and missing archive without any verified label", () => {
    const mismatch = mount(() =>
      createComponent(copy.BackupSnapshot, {
        overview: overview({
          backup: {
            fileState: "missing",
            checksumState: "mismatch",
            catalogState: "missing",
            checksumVerified: false,
            restoreListVerified: false,
            available: false,
          },
        }),
        t,
      }),
    )
    const mismatchText = mismatch.textContent ?? ""
    expect(mismatchText).toContain("缺失")
    expect(mismatchText).toContain("不匹配")
    expect(mismatchText).not.toContain("已核验")
    expect(mismatchText).not.toContain("已记录")
  })

  test("renders verified, unbound, failed and pending recovery evidence distinctly", () => {
    const verified = mount(() => createComponent(copy.RecoveryDrillSnapshot, { overview: overview(), t }))
    expect(verified.textContent).toContain("演练已验证")
    expect(verified.textContent).toContain("7 tables")
    expect(verified.textContent).toContain("1234/1234 rows")

    const unbound = mount(() =>
      createComponent(copy.RecoveryDrillSnapshot, {
        overview: overview({
          recoveryDrill: { state: "unbound", bound: false, passed: false, completedAt: "2026-11-01T00:00:00.000Z" },
        }),
        t,
      }),
    )
    expect(unbound.textContent).toContain("未绑定当前备份")
    expect(unbound.textContent).not.toContain("演练已验证")
    expect(unbound.textContent).not.toContain("rows")

    const failed = mount(() =>
      createComponent(copy.RecoveryDrillSnapshot, {
        overview: overview({ recoveryDrill: { state: "failed", passed: false, differences: 2, restoredRows: 1200 } }),
        t,
      }),
    )
    expect(failed.textContent).toContain("演练失败")
    expect(failed.textContent).not.toContain("演练已验证")

    const pending = mount(() =>
      createComponent(copy.RecoveryDrillSnapshot, {
        overview: overview({ recoveryDrill: { state: "pending", available: false, passed: false } }),
        t,
      }),
    )
    expect(pending.textContent).toContain("尚无演练")
    expect(pending.textContent).not.toContain("rows")
  })

  test("renders both known Windows backup tasks with their last result and exit code", () => {
    const host = mount(() =>
      createComponent(copy.WindowsBackupSnapshot, { tasks: overview().windowsBackupTasks, t, intl }),
    )
    const text = host.textContent ?? ""
    expect(text).toContain("Windows 备份计划任务")
    expect(text).toContain("Arforge PostgreSQL Backup")
    expect(text).toContain("Arforge Private PostgreSQL Backup")
    expect(text).toContain("成功")
    expect(text).toContain("失败")
    expect(text).toContain("退出码 1")
    expect(text).toContain("最近运行")
  })

  test("renders unknown task state instead of a pass when the scheduler is unreadable", () => {
    const host = mount(() => createComponent(copy.WindowsBackupSnapshot, { tasks: undefined, t, intl }))
    expect(host.textContent).toContain("计划任务状态未知")
  })

  test("renders a historical drill report without showing it as passed", () => {
    const host = mount(() =>
      createComponent(copy.RecoveryDrillSnapshot, {
        overview: overview({
          backup: {
            fileState: "available",
            checksumState: "mismatch",
            checksumVerified: false,
            restoreListVerified: false,
          },
          recoveryDrill: { state: "historical", bound: true, passed: false },
        }),
        t,
      }),
    )
    const text = host.textContent ?? ""
    expect(text).toContain("历史演练报告（当前归档未核验）")
    expect(text).not.toContain("演练已验证")
    expect(text).not.toContain("rows")
  })

  test("degrades missing state fields from a mixed-version server to unknown, unverified and unbound", () => {
    const legacy = overview()
    const host = mount(() =>
      createComponent(copy.BackupSnapshot, {
        overview: {
          ...legacy,
          backup: {
            available: true,
            bytes: 1024,
            encrypted: true,
            checksumVerified: true,
            restoreListVerified: true,
            createdAt: "2026-11-01T00:00:00.000Z",
            database: "arforge",
          },
        },
        t,
      }),
    )
    const text = host.textContent ?? ""
    expect(text).toContain("未知")
    expect(text).toContain("未核验")
    expect(text).not.toContain("已核验")
    expect(text).not.toContain("已记录")
    expect(text).not.toContain("存在")

    const legacyDrill = mount(() =>
      createComponent(copy.RecoveryDrillSnapshot, {
        overview: {
          ...legacy,
          recoveryDrill: {
            available: true,
            completedAt: "2026-11-01T00:01:00.000Z",
            passed: true,
            tables: 4,
            sourceRows: 10,
            restoredRows: 10,
            differences: 0,
          },
        },
        t,
      }),
    )
    expect(legacyDrill.textContent).toContain("未绑定当前备份")
    expect(legacyDrill.textContent).not.toContain("演练已验证")
    expect(legacyDrill.textContent).not.toContain("rows")
  })
})
