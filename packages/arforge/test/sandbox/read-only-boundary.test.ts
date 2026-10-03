import { expect, test } from "bun:test"
import path from "node:path"
import { allowlistedChildEnvironment } from "@arforge-ai/core/secret-environment"
import { tmpdir } from "../fixture/fixture"

for (const [flag, backend, enforcement] of [
  ["ARFORGE_SANDBOX_DISABLE_WINDOWS_NATIVE", "none", "unavailable"],
  ["ARFORGE_SANDBOX_DISABLE_BASE_CONTAINER", "windows-native", "partial"],
] as const)
  test.skipIf(process.platform !== "win32")(`explicit read grants refuse the ${backend} fallback`, async () => {
    await using workspace = await tmpdir()
    await using library = await tmpdir()
    // Capability flags are confined to this owned probe; the parent and the
    // user's default sandbox policy are unchanged.
    const probe = Bun.spawn(
      [
        process.execPath,
        path.join(import.meta.dir, "../fixture/sandbox-read-boundary.ts"),
        workspace.path,
        library.path,
      ],
      {
        env: {
          ...allowlistedChildEnvironment(process.env),
          ARFORGE_SANDBOX_DISABLE_WINDOWS_NATIVE: "0",
          ARFORGE_SANDBOX_DISABLE_BASE_CONTAINER: "0",
          [flag]: "1",
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const timer = setTimeout(() => probe.kill(), 15_000)
    try {
      const [code, stdout, stderr] = await Promise.all([
        probe.exited,
        new Response(probe.stdout).text(),
        new Response(probe.stderr).text(),
      ])
      expect({ code, stderr }).toEqual({ code: 0, stderr: "" })
      expect(JSON.parse(stdout)).toEqual({
        backend,
        results: [
          { status: "prepared", enforcement },
          { status: "prepared", enforcement },
          {
            status: "rejected",
            tag: "SandboxRunner.UnavailableError",
            message: expect.stringContaining("cannot enforce"),
          },
        ],
      })
      expect(await Bun.file(path.join(library.path, "unexpected.txt")).exists()).toBe(false)
    } finally {
      clearTimeout(timer)
      probe.kill()
      await probe.exited
    }
  })

test.skipIf(process.platform !== "win32")(
  "native helper refuses read grants without its filesystem boundary",
  async () => {
    await using workspace = await tmpdir()
    await using library = await tmpdir()
    const marker = path.join(library.path, "unexpected.txt")
    const payload = Buffer.from(
      JSON.stringify({
        command: process.execPath,
        args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'spawned')`],
        workspace: workspace.path,
        cwd: workspace.path,
        roots: [workspace.path],
        readOnlyRoots: [library.path],
        profile: "workspace-write",
        network: "inherit",
        baseContainer: false,
      }),
    ).toString("base64url")
    const probe = Bun.spawn(
      [process.execPath, path.join(import.meta.dir, "../../src/sandbox/windows-launcher.ts"), payload],
      {
        env: allowlistedChildEnvironment(process.env),
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const timer = setTimeout(() => probe.kill(), 15_000)
    try {
      const [code, stdout, stderr] = await Promise.all([
        probe.exited,
        new Response(probe.stdout).text(),
        new Response(probe.stderr).text(),
      ])
      expect(code).not.toBe(0)
      expect(stdout).toBe("")
      expect(stderr).toContain("read-only dependency")
      expect(await Bun.file(marker).exists()).toBe(false)
    } finally {
      clearTimeout(timer)
      probe.kill()
      await probe.exited
    }
  },
)
