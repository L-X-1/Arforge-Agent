import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { isAbsolute, join, relative, resolve } from "node:path"
import { tmpdir } from "node:os"

for (const mode of ["private", "basic", "users"] as const) {
  test(`current session command public HTTP fields, auth, source, retry and typed status (${mode})`, async () => {
    const root = mkdtempSync(join(tmpdir(), "arforge-session-command-route-"))
    const workspace = join(root, "workspace")
    mkdirSync(workspace)
    try {
      const child = Bun.spawn([process.execPath, join(import.meta.dir, "session-command-route.test-child.ts"), join(root, "route.db"), workspace, mode], {
        cwd: join(import.meta.dir, ".."), env: { ...process.env, ARFORGE_DISABLE_CHANNEL_DB: "1" }, stdout: "pipe", stderr: "pipe",
      })
      const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
      if (exit !== 0) throw new Error(`command fixture ${mode} failed (${exit}): ${(stderr || stdout).slice(-16000)}`)
      expect(stdout).toContain(`session-command-route-ok:${mode}`)
    } finally {
      const owned = relative(resolve(tmpdir()), resolve(root))
      if (!owned || owned.startsWith("..") || isAbsolute(owned) || !root.includes("arforge-session-command-route-")) throw new Error("Unsafe fixture cleanup path")
      rmSync(root, { recursive: true, force: true })
    }
  }, 90_000)
}
