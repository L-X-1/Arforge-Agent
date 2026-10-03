import { expect, test } from "bun:test"
import path from "node:path"
import { ChildProcess } from "effect/unstable/process"
import { allowlistedChildEnvironment } from "@arforge-ai/core/secret-environment"
import { SandboxPolicy } from "@arforge-ai/core/sandbox/policy"
import { SandboxRunner } from "../../src/sandbox/runner"
import { tmpdir } from "../fixture/fixture"

test.skipIf(process.platform !== "win32")(
  "native launches a module from its explicit read-only dependency directory",
  async () => {
    await using workspace = await tmpdir()
    await using library = await tmpdir()
    const entry = path.join(library.path, "entry.mjs")
    await Bun.write(entry, 'console.log("READ_ONLY_MODULE_READY")')
    const command = SandboxRunner.prepareCommand(
      ChildProcess.make(process.execPath, [entry]),
      SandboxPolicy.resolve({ workspace: workspace.path, cwd: workspace.path, readOnlyRoots: [library.path] }),
      SandboxRunner.detectBackend(),
    )
    const child = Bun.spawn([command.command, ...command.args], {
      cwd: workspace.path,
      env: allowlistedChildEnvironment(process.env),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
    const timer = setTimeout(() => child.kill(), 10_000)
    try {
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: "READ_ONLY_MODULE_READY\n", stderr: "" })
    } finally {
      clearTimeout(timer)
      child.kill()
      await child.exited
    }
  },
)

test.skipIf(process.platform !== "win32")("native explicit dependency reads never become writable grants", async () => {
  await using workspace = await tmpdir()
  await using library = await tmpdir()
  await using privateDirectory = await tmpdir()
  const libraryFile = path.join(library.path, "fixture.txt")
  const privateFile = path.join(privateDirectory.path, "fixture.txt")
  await Bun.write(libraryFile, "approved dependency")
  await Bun.write(privateFile, "unapproved fixture")
  const backend = SandboxRunner.detectBackend()
  expect(backend.kind).toBe("windows-native")
  if (backend.kind !== "windows-native") throw new Error("native backend required for this Windows regression")
  expect(backend.baseContainer.status).toBe("available")
  const policy = SandboxPolicy.resolve({
    workspace: workspace.path,
    cwd: workspace.path,
    readOnlyRoots: [library.path],
    profile: "workspace-write",
  })
  expect(SandboxRunner.statusReport(policy, backend).readOnlyRoots).toEqual([library.path])
  const command = SandboxRunner.prepareCommand(
    ChildProcess.make(process.execPath, [
      "-e",
      'const fs = require("node:fs"); const [library, privateFile] = process.argv.slice(1); const read = fs.readFileSync(library,"utf8"); let wrote = false, readPrivate = false; try { fs.writeFileSync(library,"changed"); wrote = true } catch {} try { fs.readFileSync(privateFile); readPrivate = true } catch {} console.log(JSON.stringify({read,wrote,readPrivate}))',
      libraryFile,
      privateFile,
    ]),
    policy,
    backend,
  )
  const child = Bun.spawn([command.command, ...command.args], {
    cwd: workspace.path,
    env: allowlistedChildEnvironment(process.env),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const timer = setTimeout(() => child.kill(), 10_000)
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" })
    expect(JSON.parse(stdout)).toEqual({ read: "approved dependency", wrote: false, readPrivate: false })
    expect(await Bun.file(libraryFile).text()).toBe("approved dependency")
    expect(await Bun.file(privateFile).text()).toBe("unapproved fixture")
  } finally {
    clearTimeout(timer)
    child.kill()
    await child.exited
  }
})
