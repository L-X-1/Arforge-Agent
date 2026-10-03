import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

/**
 * Exercise the public control surface in a fresh process.  A separate process
 * keeps the database and LocationServiceMap isolated from other HTTP tests and
 * releases SQLite handles before Windows removes the temporary directory.
 */
for (const mode of ["private", "users"] as const)
  test(`parent-scoped child control over HTTP (${mode})`, async () => {
    const root = mkdtempSync(join(tmpdir(), "arforge-subagent-control-route-"))
    const databasePath = join(root, "arforge.db")
    const workspace = join(root, "workspace")
    mkdirSync(workspace)

    try {
      const child = Bun.spawn(
        [process.execPath, join(import.meta.dir, "subagent-control-route-child.ts"), databasePath, workspace, mode],
        {
          cwd: join(import.meta.dir, ".."),
          env: {
            ...process.env,
            ARFORGE_DB: databasePath,
            ARFORGE_DISABLE_CHANNEL_DB: "1",
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      )
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      if (exitCode !== 0) throw new Error(`subagent control route child failed (${exitCode}): ${stderr || stdout}`)
      expect(stdout).toContain(mode === "users" ? "subagent-control-auth-route-ok" : "subagent-control-route-ok")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 120_000)
