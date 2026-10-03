import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

test("authenticated artifact owner context enforces profile and tenant roles over HTTP", async () => {
  const root = mkdtempSync(join(tmpdir(), "arforge-artifact-auth-route-"))
  const databasePath = join(root, "arforge.db")
  const home = join(root, "home")
  mkdirSync(home, { recursive: true })

  try {
    const child = Bun.spawn(
      [process.execPath, join(import.meta.dir, "artifact-auth-route-child.ts"), databasePath, home],
      {
        cwd: join(import.meta.dir, ".."),
        env: {
          ...process.env,
          ARFORGE_DB: databasePath,
          ARFORGE_DB_URL: "",
          ARFORGE_DB_ADMIN_URL: "",
          ARFORGE_DISABLE_CHANNEL_DB: "1",
          ARFORGE_HOME: home,
          ARFORGE_AUTH_MODE: "users",
          ARFORGE_AUTH_SECRET: "artifact-auth-route-test-secret-with-32-characters",
          ARFORGE_AUTH_EXPOSE_TOKENS: "true",
          ARFORGE_PUBLIC_URL: "http://localhost",
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
    if (exitCode !== 0) throw new Error(`authenticated artifact route child failed (${exitCode}): ${stderr || stdout}`)
    expect(stdout).toContain("artifact-auth-route-ok")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}, 120_000)
