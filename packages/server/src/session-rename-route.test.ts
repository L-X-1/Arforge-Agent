import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { isAbsolute, join, relative, resolve } from "node:path"
import { tmpdir } from "node:os"

for (const mode of ["private", "basic", "users"] as const) {
  test(`typed rename route, auth, canonical source, durable event and rollback (${mode})`, async () => {
    const root = mkdtempSync(join(tmpdir(), "arforge-session-rename-route-"))
    const workspace = join(root, "workspace")
    mkdirSync(workspace)
    try {
      const child = Bun.spawn(
        [
          process.execPath,
          join(import.meta.dir, "session-rename-route.test-child.ts"),
          join(root, "route.db"),
          workspace,
          mode,
        ],
        {
          cwd: join(import.meta.dir, ".."),
          env: { ...process.env, ARFORGE_DISABLE_CHANNEL_DB: "1" },
          stdout: "pipe",
          stderr: "pipe",
        },
      )
      const [exit, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      if (exit !== 0) throw new Error(`rename fixture ${mode} failed (${exit}): ${(stderr || stdout).slice(-16000)}`)
      expect(stdout).toContain(`session-rename-route-ok:${mode}`)
    } finally {
      // Only the confirmed temporary fixture, after all child SQLite handles exit.
      const owned = relative(resolve(tmpdir()), resolve(root))
      if (!owned || owned.startsWith("..") || isAbsolute(owned) || !root.includes("arforge-session-rename-route-"))
        throw new Error("Unsafe fixture cleanup path")
      rmSync(root, { recursive: true, force: true })
    }
  }, 90_000)
}
