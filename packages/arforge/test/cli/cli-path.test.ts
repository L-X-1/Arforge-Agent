import { describe, expect, test } from "bun:test"
import {
  buildCliEntryAudit,
  inspectCliCandidate,
  inspectPowerShellSnapshot,
  renderCliEntryAudit,
} from "../../src/cli/cmd/cli-path"
import path from "node:path"
import { mkdir, readFile, writeFile, unlink, symlink, rmdir } from "node:fs/promises"
import { tmpdir } from "../fixture/fixture"
import { spawnSync } from "node:child_process"
import { rejects } from "node:assert/strict"

const fixture = () =>
  tmpdir({
    init: async (directory) => {
      const root = path.join(directory, "中文 checkout")
      await mkdir(path.join(root, "bin"), { recursive: true })
      await mkdir(path.join(root, "packages/arforge/src"), { recursive: true })
      const repo = path.resolve(import.meta.dir, "../../../..")
      await writeFile(path.join(root, "arforge.cmd"), await readFile(path.join(repo, "arforge.cmd")))
      await writeFile(path.join(root, "bin/arforge.js"), await readFile(path.join(repo, "bin/arforge.js")))
      await writeFile(path.join(root, "packages/arforge/src/index.ts"), "export {}\n")
      await writeFile(
        path.join(root, "package.json"),
        JSON.stringify({ name: "arforge-agent", version: "1.0.0-test.1" }),
      )
      return root
    },
  })

const win = {
  productRoot: "E:\\Arforge-Agent",
  platform: "win32" as const,
  resolver: "where.exe" as const,
}

describe("canonical CLI entry audit", () => {
  test("PowerShell metadata preserves function/alias shadowing without evaluating command bodies", async () => {
    await using tmp = await fixture()
    for (const kind of ["Alias", "Function"]) {
      const report = await inspectPowerShellSnapshot(
        JSON.stringify({
          schema_version: 1,
          commands: [
            { name: "arforge", command_type: kind },
            { name: "arforge.cmd", command_type: "Application", path: path.join(tmp.extra, "arforge.cmd") },
          ],
        }),
        tmp.extra,
      )
      expect(report.resolver).toBe("PowerShell:Get-Command")
      expect(report.status).toBe("blocked")
      expect(report.entries[0]?.role).toBe(`powershell-${kind.toLowerCase()}`)
      expect(report.entries[1]?.kind).toBe("canonical")
      expect(report.logical_cli_count).toBeNull()
    }
  })

  test("PowerShell snapshot rejects command bodies, oversized input and malformed path metadata", async () => {
    for (const input of [
      "x".repeat(32769),
      "{}",
      JSON.stringify({
        schema_version: 1,
        commands: [{ name: "arforge", command_type: "Function", definition: "secret body" }],
      }),
      JSON.stringify({
        schema_version: 1,
        commands: [{ name: "arforge", command_type: "Application", path: "relative.cmd" }],
      }),
    ]) {
      await rejects(inspectPowerShellSnapshot(input))
    }
    expect((await inspectPowerShellSnapshot('{"schema_version":1,"commands":[]}')).status).toBe("unavailable")
  })

  test("PowerShell metadata cannot redirect inspection to arbitrary files or UNC paths", async () => {
    await rejects(
      inspectPowerShellSnapshot(
        JSON.stringify({
          schema_version: 1,
          commands: [{ name: "arforge.cmd", command_type: "Application", path: "C:/private/credentials.txt" }],
        }),
      ),
    )
    const report = await inspectPowerShellSnapshot(
      JSON.stringify({
        schema_version: 1,
        commands: [
          { name: "arforge.cmd", command_type: "Application", path: "\\\\unavailable.invalid\\share\\arforge.cmd" },
        ],
      }),
    )
    expect(report.status).toBe("blocked")
    expect(report.entries[0]?.verification).toBeUndefined()
  })

  test("real CLI rejects malformed and oversized PowerShell stdin without echoing input", async () => {
    await using tmp = await tmpdir()
    const repo = path.resolve(import.meta.dir, "../../../..")
    const node = Bun.which("node")
    if (!node) throw new Error("Node is required for the canonical launcher smoke test")
    for (const input of ["DO-NOT-ECHO-INPUT", "DO-NOT-ECHO-INPUT".repeat(2200)]) {
      const result = spawnSync(node, [path.join(repo, "bin/arforge.js"), "cli-path", "--powershell-stdin", "--json"], {
        cwd: repo,
        env: {
          ...process.env,
          ARFORGE_HOME: tmp.path,
          ARFORGE_TEST_HOME: tmp.path,
          ARFORGE_DB: ":memory:",
          ARFORGE_DISABLE_PROJECT_CONFIG: "true",
          ARFORGE_DISABLE_MODELS_FETCH: "true",
        },
        input,
        encoding: "utf8",
        timeout: 30_000,
        windowsHide: true,
      })
      expect(result.error).toBeUndefined()
      expect(result.status).toBe(2)
      expect(JSON.parse(result.stdout).status).toBe("blocked")
      expect(result.stdout + result.stderr).not.toContain("DO-NOT-ECHO-INPUT")
    }
  }, 65_000)

  for (const kind of ["function", "alias", "none"] as const) {
    const powershellTest = process.platform === "win32" ? test : test.skip
    powershellTest(
      `real PowerShell helper inspects caller ${kind} without invoking it`,
      async () => {
        const shell = Bun.which("pwsh") ?? Bun.which("powershell")
        if (!shell) throw new Error("PowerShell is required for the current-session diagnostic test")
        await using tmp = await tmpdir()
        const repo = path.resolve(import.meta.dir, "../../../..")
        const setup =
          kind === "function"
            ? "function arforge { throw 'MUST-NOT-EXECUTE' }; "
            : kind === "alias"
              ? "function Invoke-FakeArforge { throw 'MUST-NOT-EXECUTE' }; Set-Alias arforge Invoke-FakeArforge; "
              : ""
        const script = setup + `& (Join-Path $env:ARFORGE_DIAG_REPO 'scripts/arforge-cli-path.ps1') -Json`
        const result = spawnSync(shell, ["-NoProfile", "-NonInteractive", "-Command", script], {
          cwd: repo,
          env: {
            ...process.env,
            ARFORGE_DIAG_REPO: repo,
            ARFORGE_HOME: tmp.path,
            ARFORGE_TEST_HOME: tmp.path,
            ARFORGE_DB: ":memory:",
            ARFORGE_DISABLE_PROJECT_CONFIG: "true",
            ARFORGE_DISABLE_MODELS_FETCH: "true",
          },
          encoding: "utf8",
          timeout: 30_000,
          windowsHide: true,
        })
        expect(result.error).toBeUndefined()
        const report = JSON.parse(result.stdout)
        expect(report.resolver).toBe("PowerShell:Get-Command")
        if (kind === "none") {
          expect(["canonical", "canonical-shim"]).toContain(report.entries[0]?.kind)
          expect(result.status).toBe(0)
        } else {
          expect(report.entries[0]?.role).toBe(`powershell-${kind}`)
          expect(result.status).toBe(1)
        }
        expect(result.stderr).not.toContain("MUST-NOT-EXECUTE")
      },
      40_000,
    )
  }
  const windowsTest = process.platform === "win32" ? test : test.skip
  windowsTest(
    "Windows npm CMD in a spaced path reaches the same diagnostic as the direct TS launcher",
    async () => {
      await using tmp = await tmpdir()
      const repo = path.resolve(import.meta.dir, "../../../..")
      const prefix = path.join(tmp.path, "npm 中文 prefix")
      await mkdir(path.join(prefix, "node_modules"), { recursive: true })
      await symlink(repo, path.join(prefix, "node_modules/arforge-agent"), "junction")
      const entry = path.join(prefix, "arforge.cmd")
      await writeFile(entry, await readFile(path.join(import.meta.dir, "fixtures/npm-shim/arforge.cmd")))
      const env = {
        ...process.env,
        ARFORGE_HOME: tmp.path,
        ARFORGE_TEST_HOME: tmp.path,
        ARFORGE_DB: ":memory:",
        ARFORGE_DISABLE_PROJECT_CONFIG: "true",
        ARFORGE_DISABLE_MODELS_FETCH: "true",
        NO_COLOR: "1",
      }
      const node = Bun.which("node")
      if (!node) throw new Error("Node is required for the canonical launcher smoke test")
      const wrapped = spawnSync(process.env.COMSPEC ?? "cmd.exe", ["/d", "/s", "/c", `""${entry}" cli-path --json"`], {
        cwd: repo,
        env,
        encoding: "utf8",
        windowsHide: true,
        windowsVerbatimArguments: true,
        timeout: 30_000,
      })
      const direct = spawnSync(node, [path.join(repo, "bin/arforge.js"), "cli-path", "--json"], {
        cwd: repo,
        env,
        encoding: "utf8",
        windowsHide: true,
        timeout: 30_000,
      })
      expect(wrapped.error).toBeUndefined()
      expect(direct.error).toBeUndefined()
      const report = JSON.parse(wrapped.stdout)
      expect(report.command).toBe("arforge")
      expect(report).toEqual(JSON.parse(direct.stdout))
      expect(wrapped.status).toBe(direct.status)
      expect(wrapped.status).toBe(report.status === "ok" ? 0 : 1)
    },
    65_000,
  )
  for (const mode of [
    "stale-checkout",
    "missing-package",
    "changed-wrapper",
    "wrong-package",
    "changed-launcher",
  ] as const) {
    test(`does not certify an npm shim with ${mode}`, async () => {
      await using tmp = await fixture()
      await using other = await fixture()
      const prefix = path.join(tmp.path, "npm prefix")
      await mkdir(path.join(prefix, "node_modules"), { recursive: true })
      if (mode !== "missing-package")
        await symlink(
          mode === "stale-checkout" ? other.extra : tmp.extra,
          path.join(prefix, "node_modules/arforge-agent"),
          process.platform === "win32" ? "junction" : "dir",
        )
      const entry = path.join(prefix, "arforge.cmd")
      const template = await readFile(path.join(import.meta.dir, "fixtures/npm-shim/arforge.cmd"), "utf8")
      await writeFile(entry, template + (mode === "changed-wrapper" ? "\necho unexpected\n" : ""))
      if (mode === "wrong-package")
        await writeFile(path.join(tmp.extra, "package.json"), JSON.stringify({ name: "other", version: "1.0.0" }))
      if (mode === "changed-launcher")
        await writeFile(path.join(tmp.extra, "bin/arforge.js"), "throw new Error('must not execute')")
      const candidate = await inspectCliCandidate(entry, tmp.extra)
      expect(candidate.verification).toBeUndefined()
      expect(
        buildCliEntryAudit([candidate], { productRoot: tmp.extra, platform: process.platform }).logical_cli_count,
      ).toBeNull()
    })
  }

  test("CRLF npm templates retain the same reviewed identity and bind package version", async () => {
    await using tmp = await fixture()
    const prefix = path.join(tmp.path, "npm")
    await mkdir(path.join(prefix, "node_modules"), { recursive: true })
    await symlink(
      tmp.extra,
      path.join(prefix, "node_modules/arforge-agent"),
      process.platform === "win32" ? "junction" : "dir",
    )
    const entry = path.join(prefix, "arforge.cmd")
    const template = await readFile(path.join(import.meta.dir, "fixtures/npm-shim/arforge.cmd"), "utf8")
    await writeFile(entry, template.replaceAll("\r\n", "\n").replaceAll("\n", "\r\n"))
    const candidate = await inspectCliCandidate(entry, tmp.extra)
    expect(candidate.verification?.package_version).toBe("1.0.0-test.1")
    expect(candidate.verification?.package_root).toBe(tmp.extra)
    expect(candidate.verification?.package_digest).toMatch(/^[a-f0-9]{64}$/)
  })
  test("verified npm CMD, shell and PowerShell shims share the repository target through npm link", async () => {
    await using tmp = await fixture()
    const prefix = path.join(tmp.path, "npm prefix")
    await mkdir(path.join(prefix, "node_modules"), { recursive: true })
    await symlink(
      tmp.extra,
      path.join(prefix, "node_modules/arforge-agent"),
      process.platform === "win32" ? "junction" : "dir",
    )
    const candidates = [await inspectCliCandidate(path.join(tmp.extra, "arforge.cmd"), tmp.extra)]
    for (const name of ["arforge.cmd", "arforge", "arforge.ps1"]) {
      const entry = path.join(prefix, name)
      await writeFile(entry, await readFile(path.join(import.meta.dir, "fixtures/npm-shim", name)))
      candidates.push(await inspectCliCandidate(entry, tmp.extra))
    }
    const report = buildCliEntryAudit(candidates, { productRoot: tmp.extra, platform: process.platform })
    expect(report.status).toBe("ok")
    expect(report.logical_cli_count).toBe(1)
    expect(report.canonical_entry_count).toBe(4)
    expect(report.entries.map((entry) => entry.kind)).toEqual([
      "canonical",
      "canonical-shim",
      "canonical-shim",
      "canonical-shim",
    ])
  })
  test("real CLI emits a read-only JSON diagnostic under an isolated profile", async () => {
    await using tmp = await tmpdir()
    const repo = path.resolve(import.meta.dir, "../../../..")
    const node = Bun.which("node")
    if (!node) throw new Error("Node is required for the canonical launcher smoke test")
    const result = Bun.spawnSync([node, path.join(repo, "bin/arforge.js"), "cli-path", "--json"], {
      cwd: repo,
      env: {
        ...process.env,
        ARFORGE_HOME: tmp.path,
        ARFORGE_TEST_HOME: tmp.path,
        ARFORGE_DB: ":memory:",
        ARFORGE_DISABLE_PROJECT_CONFIG: "true",
        ARFORGE_DISABLE_MODELS_FETCH: "true",
      },
      timeout: 30_000,
    })
    const report = JSON.parse(new TextDecoder().decode(result.stdout))
    expect(report.command).toBe("arforge")
    expect(report.schema_version).toBe(2)
    expect(result.exitCode).toBe(report.status === "ok" ? 0 : 1)
    if (process.platform === "win32")
      expect(report.entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "canonical",
            verification: expect.objectContaining({
              launcher_digest: expect.stringMatching(/^[a-f0-9]{64}$/),
            }),
          }),
        ]),
      )
  }, 40_000)
  test("does not trust a Python wrapper just because it is inside the repository", () => {
    const report = buildCliEntryAudit(
      [{ path: "E:\\Arforge-Agent\\arforge.cmd", content: "@echo off\npython main.py %*" }],
      win,
    )
    expect(report.entries[0]?.kind).toBe("legacy-python")
    expect(report.status).toBe("blocked")
  })

  test("does not equate path substrings or uninspected repository scripts with a verified target", () => {
    const report = buildCliEntryAudit(
      [
        { path: "E:\\Arforge-Agent\\arforge.cmd", content: "echo fake" },
        { path: "C:\\npm\\arforge.cmd", content: "rem node_modules/arforge-agent/bin/arforge.js\nnode old.js" },
      ],
      win,
    )
    expect(report.canonical_entry_count).toBe(0)
    expect(report.logical_cli_count).toBeNull()
    expect(report.status).toBe("blocked")
  })
  test("does not claim npm shim equivalence without inspecting its actual target", () => {
    const report = buildCliEntryAudit(
      [
        { path: "E:\\Arforge-Agent\\arforge.cmd", content: "call bin\\arforge.js" },
        {
          path: "C:\\Users\\tester\\AppData\\Roaming\\npm\\arforge.cmd",
          content: 'node "%dp0%\\node_modules\\arforge-agent\\bin\\arforge.js" %*',
        },
        {
          path: "C:\\Users\\tester\\AppData\\Roaming\\npm\\arforge",
          content: 'exec node "$basedir/node_modules/arforge-agent/bin/arforge.js" "$@"',
        },
      ],
      win,
    )

    expect(report).toMatchObject({
      status: "blocked",
      canonical_entry_count: 0,
      legacy_entry_count: 0,
      external_entry_count: 3,
      logical_cli_count: null,
    })
    expect(report.entries.map((entry) => entry.kind)).toEqual(["unknown", "unknown", "unknown"])
    expect(renderCliEntryAudit(report)).toContain("逻辑 CLI=未确定")
  })

  test("blocks a stale Python executable and provides an actionable recommendation", () => {
    const report = buildCliEntryAudit(
      [
        { path: "E:\\Arforge-Agent\\arforge.cmd", content: "call bin\\arforge.js" },
        { path: "D:\\PYTHON\\Scripts\\arforge.exe" },
      ],
      win,
    )

    expect(report.status).toBe("blocked")
    expect(report.legacy_entry_count).toBe(1)
    expect(report.external_entry_count).toBe(1)
    expect(report.entries[1]).toMatchObject({ kind: "legacy-python", role: "legacy-python-entry" })
    expect(renderCliEntryAudit(report)).toContain("请将旧 Python")
  })

  test("verifies the real repository CMD chain with source digests in a Chinese path with spaces", async () => {
    await using tmp = await fixture()
    const candidate = await inspectCliCandidate(path.join(tmp.extra, "arforge.cmd"), tmp.extra)
    const report = buildCliEntryAudit([candidate, candidate], { productRoot: tmp.extra, platform: process.platform })
    expect(report.status).toBe("ok")
    expect(report.logical_cli_count).toBe(1)
    expect(report.entries).toHaveLength(1)
    expect(report.entries[0]?.verification?.source_digest).toMatch(/^[a-f0-9]{64}$/)
    expect(report.entries[0]?.verification?.target).toBe(path.join(tmp.extra, "packages/arforge/src/index.ts"))
  })

  test("missing source or changed launcher fails closed without executing a wrapper", async () => {
    await using tmp = await fixture()
    const root = tmp.extra
    const inspect = async () =>
      buildCliEntryAudit([await inspectCliCandidate(path.join(root, "arforge.cmd"), root)], {
        productRoot: root,
        platform: process.platform,
      })
    await writeFile(path.join(root, "bin/arforge.js"), "throw new Error('must never execute')")
    expect((await inspect()).status).toBe("blocked")
    await writeFile(
      path.join(root, "bin/arforge.js"),
      await readFile(path.resolve(import.meta.dir, "../../../../bin/arforge.js")),
    )
    await unlink(path.join(root, "packages/arforge/src/index.ts"))
    expect((await inspect()).canonical_entry_count).toBe(0)
  })

  test("a shim in another checkout cannot borrow current-checkout identity", async () => {
    await using first = await fixture()
    await using second = await fixture()
    const candidate = await inspectCliCandidate(path.join(first.extra, "arforge.cmd"), second.extra)
    expect(candidate.verification).toBeUndefined()
  })

  test("rejects an extra command even if the canonical launcher command remains", async () => {
    await using tmp = await fixture()
    const file = path.join(tmp.extra, "arforge.cmd")
    await writeFile(file, (await readFile(file, "utf8")) + "\necho unexpected\n")
    expect((await inspectCliCandidate(file, tmp.extra)).verification).toBeUndefined()
  })

  test("rejects launcher directories redirected to another checkout", async () => {
    await using tmp = await fixture()
    await using outside = await fixture()
    const bin = path.join(tmp.extra, "bin")
    await unlink(path.join(bin, "arforge.js"))
    await rmdir(bin)
    await symlink(path.join(outside.extra, "bin"), bin, process.platform === "win32" ? "junction" : "dir")
    expect((await inspectCliCandidate(path.join(tmp.extra, "arforge.cmd"), tmp.extra)).verification).toBeUndefined()
  })

  test("fails closed for an uninspectable shim or missing resolver result", () => {
    const unknown = buildCliEntryAudit([{ path: "C:\\Tools\\arforge.cmd" }], win)
    expect(unknown.status).toBe("blocked")
    expect(unknown.entries[0]?.kind).toBe("unknown")

    const unavailable = buildCliEntryAudit([], win)
    expect(unavailable).toMatchObject({
      status: "unavailable",
      canonical_entry_count: 0,
      logical_cli_count: 0,
    })
  })
})
