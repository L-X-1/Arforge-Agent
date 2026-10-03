import { describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect, Exit } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { SandboxPolicy } from "@arforge-ai/core/sandbox/policy"
import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { SandboxRunner } from "@/sandbox/runner"
import { probeUnixNativeCapability } from "@/sandbox/unix-native-capability"

const waitFor = async (check: () => Promise<boolean>, timeoutMs = 8_000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`timed out after ${timeoutMs}ms while waiting for sandbox cleanup`)
}

const workspace = path.resolve("workspace", "project")
const command = ChildProcess.make("/bin/sh", ["-c", "printf sandbox"], {
  cwd: workspace,
  shell: undefined,
  stdin: "ignore",
})

describe("SandboxRunner", () => {
  test("does not treat a Unix executable path as live capability on another host", () => {
    const requestedPlatform = process.platform === "linux" ? "darwin" : "linux"
    const capability = probeUnixNativeCapability("bubblewrap", "C:\\missing\\bwrap", requestedPlatform)

    expect(capability.status).toBe("not-probed")
    expect(capability.liveProbe).toBe("not-run")
    expect(capability.reason).toContain("not the current host")
  })

  test("reports a path-only Unix candidate as unavailable instead of full", () => {
    const capability = probeUnixNativeCapability("bubblewrap", process.execPath, process.platform)

    expect(capability.status).toBe("unavailable")
    expect(capability.liveProbe).toBe("failed")
    expect(capability.reason).toContain("live isolation probe failed")
    expect(capability.version).toBeDefined()
    expect(capability.landlock?.enforcement).toBe("not-integrated")
  })

  test("resolves one canonical policy and keeps approved roots explicit", () => {
    const policy = SandboxPolicy.resolve({
      workspace,
      cwd: path.join(workspace, "src"),
      roots: [workspace, path.resolve("tmp", "approved"), path.join(workspace, "src")],
      profile: "workspace-write",
      network: "none",
    })

    expect(policy.workspace).toBe(workspace)
    expect(policy.cwd).toBe(path.join(workspace, "src"))
    expect(policy.roots).toEqual(
      [path.resolve("tmp", "approved"), workspace, path.join(workspace, "src")].sort((a, b) => a.localeCompare(b)),
    )
    expect(SandboxPolicy.contains(workspace, path.join(workspace, "src", "file.ts"))).toBe(true)
    expect(SandboxPolicy.contains(workspace, path.resolve("workspace", "project-old", "file.ts"))).toBe(false)
  })

  test("wraps a shell command with bubblewrap and disables network when policy says none", () => {
    const policy = SandboxPolicy.resolve({
      workspace,
      cwd: workspace,
      profile: "workspace-write",
      network: "none",
    })
    const prepared = SandboxRunner.prepareCommand(
      ChildProcess.make("/bin/sh", [], { shell: "/bin/sh", cwd: policy.cwd, stdin: "ignore" }),
      policy,
      { kind: "bubblewrap", executable: "/usr/bin/bwrap" },
    )

    expect(prepared.command).toBe("/usr/bin/bwrap")
    expect(prepared.options.shell).toBeUndefined()
    expect(prepared.args).toContain("--unshare-net")
    expect(prepared.args).toContain("--unshare-pid")
    expect(prepared.args).toContain("--bind")
    expect(prepared.args.slice(-3)).toEqual(["/bin/sh", "-c", "/bin/sh"])
  })

  test("uses read-only mounts for the read-only preset", () => {
    const policy = SandboxPolicy.resolve({
      workspace,
      cwd: workspace,
      profile: "read-only",
    })
    const prepared = SandboxRunner.prepareCommand(command, policy, {
      kind: "bubblewrap",
      executable: "/usr/bin/bwrap",
    })

    const projectMount = prepared.args.findIndex(
      (value, index) => value === "--ro-bind" && prepared.args[index + 1] === workspace,
    )
    expect(projectMount).toBeGreaterThan(-1)
    expect(prepared.args).not.toContain("--unshare-net")
  })

  test("detects the native Windows launcher without claiming complete isolation", () => {
    const backend = SandboxRunner.detectBackend("win32")
    if (backend.kind === "none") {
      expect(backend.reason).toMatch(/Bun|helper/)
      return
    }
    if (backend.kind !== "windows-native") return
    expect(backend.helper).toEndWith("windows-launcher.ts")

    const policy = SandboxPolicy.resolve({ workspace, cwd: workspace, profile: "read-only" })
    const prepared = SandboxRunner.prepareCommand(
      ChildProcess.make("cmd.exe", ["/d", "/c", "echo sandbox"], { cwd: workspace, stdin: "ignore" }),
      policy,
      backend,
    )
    expect(prepared.command).toBe(backend.executable)
    expect(prepared.args[0]).toBe(backend.helper)
    expect(prepared.args[1]).toMatch(/^[A-Za-z0-9_-]+$/)
    const payload = JSON.parse(Buffer.from(prepared.args[1]!, "base64url").toString("utf8")) as Record<string, unknown>
    expect(payload).toMatchObject({
      profile: "read-only",
      network: "inherit",
      workspace,
      cwd: workspace,
    })
    expect(payload).not.toHaveProperty("env")
  })

  test("exposes per-dimension native enforcement capabilities", async () => {
    if (process.platform !== "win32") return
    const backend = SandboxRunner.detectBackend("win32")
    if (backend.kind !== "windows-native") return
    const prepared = await Effect.runPromise(
      Effect.gen(function* () {
        const runner = yield* SandboxRunner.Service
        return yield* runner.prepare({
          command,
          workspace,
          cwd: workspace,
          profile: "read-only",
        })
      }).pipe(Effect.provide(LayerNode.compile(SandboxRunner.node))),
    )
    expect(prepared.report.capabilities).toEqual({
      processBoundary: "low-integrity-token",
      fileSystem: "low-integrity-only",
      network: "host",
      processTree: "job-kill-on-close",
    })
    expect(prepared.report.nativeBoundary?.api).toBe("processmodel")
  })

  test("fails closed when the live host has no backend and enforcement is required", async () => {
    if (process.platform !== "win32") return
    const backend = SandboxRunner.detectBackend("win32")
    if (backend.kind !== "windows-native") {
      if (backend.kind === "none") expect(backend.reason).toMatch(/Bun|helper/)
      return
    }
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const runner = yield* SandboxRunner.Service
        return yield* runner.prepare({
          command,
          workspace: "/workspace/project",
          cwd: "/workspace/project",
          requireEnforcement: true,
        })
      }).pipe(Effect.provide(LayerNode.compile(SandboxRunner.node))),
    )
    if (backend.baseContainer.status === "available") {
      expect(Exit.isSuccess(exit)).toBe(true)
    } else {
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(String(exit.cause)).toContain("path ACL")
    }
  })

  test("reports workspace-write enforcement truthfully and gates required isolation", async () => {
    if (process.platform !== "win32") return
    const backend = SandboxRunner.detectBackend("win32")
    if (backend.kind !== "windows-native") return

    const prepared = await Effect.runPromise(
      Effect.gen(function* () {
        const runner = yield* SandboxRunner.Service
        return yield* runner.prepare({
          command,
          workspace,
          cwd: workspace,
          profile: "workspace-write",
          network: "none",
        })
      }).pipe(Effect.provide(LayerNode.compile(SandboxRunner.node))),
    )
    if (backend.baseContainer.status === "available") {
      expect(prepared.report.enforcement).toBe("full")
      expect(prepared.report.capabilities).toEqual({
        processBoundary: "app-container",
        fileSystem: "app-container-paths",
        network: "app-container-policy",
        processTree: "job-kill-on-close",
      })
    } else {
      expect(prepared.report.enforcement).toBe("partial")
      expect(prepared.report.capabilities.network).toBe("host")
      expect(prepared.report.reason).toContain("network containment")
    }

    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const runner = yield* SandboxRunner.Service
        return yield* runner.prepare({
          command,
          workspace,
          cwd: workspace,
          profile: "workspace-write",
          network: "none",
          requireEnforcement: true,
        })
      }).pipe(Effect.provide(LayerNode.compile(SandboxRunner.node))),
    )
    if (backend.baseContainer.status === "available") {
      expect(Exit.isSuccess(exit)).toBe(true)
    } else {
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(String(exit.cause)).toContain("network containment")
    }
  })

  test("keeps Git Bash/MSYS on an explicit partial legacy path", async () => {
    if (process.platform !== "win32") return
    const backend = SandboxRunner.detectBackend("win32")
    if (backend.kind !== "windows-native" || backend.baseContainer.status !== "available") return

    const policy = SandboxPolicy.resolve({
      workspace,
      cwd: workspace,
      profile: "workspace-write",
      network: "none",
    })
    const prepared = await Effect.runPromise(
      Effect.gen(function* () {
        const runner = yield* SandboxRunner.Service
        return yield* runner.prepare({
          command: ChildProcess.make("echo test", [], {
            shell: "C:\\Program Files\\Git\\bin\\bash.exe",
            cwd: workspace,
            stdin: "ignore",
          }),
          workspace,
          cwd: workspace,
          profile: policy.profile,
          network: policy.network,
        })
      }).pipe(Effect.provide(LayerNode.compile(SandboxRunner.node))),
    )
    expect(prepared.report.enforcement).toBe("partial")
    expect(prepared.report.reason).toContain("Git Bash/MSYS")
    const payload = JSON.parse(Buffer.from(prepared.command.args[1]!, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >
    expect(payload.baseContainer).toBe(false)
  })

  test("native Windows read-only launcher blocks a medium-integrity file write", async () => {
    if (process.platform !== "win32") return
    const backend = SandboxRunner.detectBackend("win32")
    if (backend.kind !== "windows-native") return

    const directory = await mkdtemp(path.join(os.tmpdir(), "arforge-sandbox-"))
    const target = path.join(directory, "protected.txt")
    await writeFile(target, "before", "utf8")
    const payload = Buffer.from(
      JSON.stringify({
        command: process.env.ComSpec ?? "cmd.exe",
        args: ["/d", "/c", `echo blocked > ${target}`],
        cwd: directory,
      }),
    ).toString("base64url")

    try {
      const output = await new Promise<{ code: number | null; text: string }>((resolve, reject) => {
        const child = spawn(backend.executable, [backend.helper, payload], {
          cwd: directory,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        })
        let text = ""
        child.stdout?.on("data", (chunk) => (text += String(chunk)))
        child.stderr?.on("data", (chunk) => (text += String(chunk)))
        child.once("error", reject)
        child.once("close", (code) => resolve({ code, text }))
      })
      expect(output.code).not.toBe(0)
      expect(output.text.toLowerCase()).toContain("access is denied")
      expect(await readFile(target, "utf8")).toBe("before")
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("native Windows workspace-write launcher preserves writes and cleans per-run temp", async () => {
    if (process.platform !== "win32") return
    const backend = SandboxRunner.detectBackend("win32")
    if (backend.kind !== "windows-native") return

    const directory = await mkdtemp(path.join(os.tmpdir(), "arforge-sandbox-workspace-"))
    const target = path.join(directory, "created.txt")
    const payload = Buffer.from(
      JSON.stringify({
        command: `echo workspace>"${target}" & echo %TEMP%`,
        args: [],
        shell: process.env.ComSpec ?? "cmd.exe",
        cwd: directory,
        profile: "workspace-write",
        network: "inherit",
        workspace: directory,
        roots: [directory],
      }),
    ).toString("base64url")

    try {
      const output = await new Promise<{ code: number | null; text: string }>((resolve, reject) => {
        const child = spawn(backend.executable, [backend.helper, payload], {
          cwd: directory,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        })
        let text = ""
        child.stdout?.on("data", (chunk) => (text += String(chunk)))
        child.stderr?.on("data", (chunk) => (text += String(chunk)))
        child.once("error", reject)
        child.once("close", (code) => resolve({ code, text }))
      })
      expect(output.code).toBe(0)
      expect(await readFile(target, "utf8")).toMatch(/^workspace\s*$/u)
      expect(output.text).toContain(".arforge-sandbox-temp-")
      const remaining = await readdir(directory)
      expect(remaining.some((name) => name.startsWith(".arforge-sandbox-temp-"))).toBe(false)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("native Windows workspace-write rejects cwd traversal before launching", async () => {
    if (process.platform !== "win32") return
    const backend = SandboxRunner.detectBackend("win32")
    if (backend.kind !== "windows-native") return

    const directory = await mkdtemp(path.join(os.tmpdir(), "arforge-sandbox-traversal-"))
    const payload = Buffer.from(
      JSON.stringify({
        command: process.env.ComSpec ?? "cmd.exe",
        args: ["/d", "/c", "echo should-not-run"],
        cwd: `${directory}\\child\\..\\..\\outside`,
        profile: "workspace-write",
        network: "inherit",
        workspace: directory,
        roots: [directory],
      }),
    ).toString("base64url")

    try {
      const output = await new Promise<{ code: number | null; text: string }>((resolve, reject) => {
        const child = spawn(backend.executable, [backend.helper, payload], {
          cwd: directory,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        })
        let text = ""
        child.stdout?.on("data", (chunk) => (text += String(chunk)))
        child.stderr?.on("data", (chunk) => (text += String(chunk)))
        child.once("error", reject)
        child.once("close", (code) => resolve({ code, text }))
      })
      expect(output.code).not.toBe(0)
      expect(output.text).toContain("outside the approved roots")
      expect((await readdir(directory)).some((name) => name.startsWith(".arforge-sandbox-temp-"))).toBe(false)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("direct SBOX selection fails closed when the host feature gate is disabled", async () => {
    if (process.platform !== "win32") return
    const backend = SandboxRunner.detectBackend("win32")
    if (backend.kind !== "windows-native") return

    const directory = await mkdtemp(path.join(os.tmpdir(), "arforge-sandbox-sbox-gate-"))
    const payload = Buffer.from(
      JSON.stringify({
        command: process.env.ComSpec ?? "cmd.exe",
        args: ["/d", "/c", "echo should-not-run"],
        cwd: directory,
        profile: "workspace-write",
        network: "none",
        workspace: directory,
        roots: [directory],
        baseContainer: true,
      }),
    ).toString("base64url")

    try {
      const output = await new Promise<{ code: number | null; text: string }>((resolve, reject) => {
        const child = spawn(backend.executable, [backend.helper, payload], {
          cwd: directory,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        })
        let text = ""
        child.stdout?.on("data", (chunk) => (text += String(chunk)))
        child.stderr?.on("data", (chunk) => (text += String(chunk)))
        child.once("error", reject)
        child.once("close", (code) => resolve({ code, text }))
      })
      if (backend.baseContainer.status === "available") {
        expect(output.code).toBe(0)
      } else {
        expect(output.code).not.toBe(0)
        expect(output.text).toMatch(/BaseContainer|not available|not enabled/iu)
        expect((await readdir(directory)).some((name) => name.startsWith(".arforge-sandbox-temp-"))).toBe(false)
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("native Windows cancellation cleanup survives taskkill process-tree termination", async () => {
    if (process.platform !== "win32") return
    const backend = SandboxRunner.detectBackend("win32")
    if (backend.kind !== "windows-native") return

    const directory = await mkdtemp(path.join(os.tmpdir(), "arforge-sandbox-cancel-"))
    const payload = Buffer.from(
      JSON.stringify({
        command: process.env.ComSpec ?? "cmd.exe",
        args: ["/d", "/c", "ping -n 60 127.0.0.1 > nul"],
        cwd: directory,
        profile: "workspace-write",
        network: "inherit",
        workspace: directory,
        roots: [directory],
      }),
    ).toString("base64url")
    let child: ReturnType<typeof spawn> | undefined

    try {
      child = spawn(backend.executable, [backend.helper, payload], {
        cwd: directory,
        windowsHide: true,
        stdio: "ignore",
      })
      if (!child.pid) throw new Error("native sandbox helper did not expose a PID")
      await waitFor(async () => (await readdir(directory)).some((name) => name.startsWith(".arforge-sandbox-temp-")))

      await new Promise<void>((resolve) => {
        const killer = spawn("taskkill", ["/pid", String(child!.pid), "/t", "/f"], {
          windowsHide: true,
          stdio: "ignore",
        })
        killer.once("close", () => resolve())
        killer.once("error", () => resolve())
      })

      await waitFor(
        async () => !(await readdir(directory)).some((name) => name.startsWith(".arforge-sandbox-temp-")),
        12_000,
      )
    } finally {
      child?.kill()
      await rm(directory, { recursive: true, force: true })
    }
  })
})
