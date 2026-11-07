import { expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync } from "node:fs"
import { isAbsolute, join, relative, resolve } from "node:path"
import { tmpdir } from "node:os"
import { randomBytes } from "node:crypto"

for (const mode of ["owner", "http", "reasoning"] as const)
  test(
    mode === "reasoning"
      ? "typed reasoning save/catalog/request round-trip across all three supported adapters"
      : `provider configuration after existing bootstrap (${mode}): no-key, encrypted key, cache, disconnect and host boundary`,
    async () => {
      const root = mkdtempSync(join(tmpdir(), "arforge-provider-configuration-"))
      mkdirSync(join(root, "workspace"))
      const environment = {
        ...process.env,
        ARFORGE_DISABLE_CHANNEL_DB: "1",
        ARFORGE_PROVIDER_FIXTURE_KEY: randomBytes(32).toString("hex"),
      }
      try {
        const child = Bun.spawn(
          [process.execPath, join(import.meta.dir, "provider-configuration.test-child.ts"), root, mode],
          {
            cwd: join(import.meta.dir, ".."),
            env: environment,
            stdout: "pipe",
            stderr: "pipe",
          },
        )
        const [code, output, error] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ])
        if (code !== 0)
          throw new Error(`Provider configuration fixture failed (${code}): ${(error || output).slice(-12000)}`)
        expect(output).toContain(`provider-configuration-${mode}-ok`)
        if (mode === "owner") {
          // A new process has a new config-CAS HMAC, but uses the same real owned
          // encrypted profile. Provider target binding must remain usable.
          const restart = Bun.spawn(
            [process.execPath, join(import.meta.dir, "provider-configuration.test-child.ts"), root, "relaunch"],
            { cwd: join(import.meta.dir, ".."), env: environment, stdout: "pipe", stderr: "pipe" },
          )
          const [restartCode, restartOut, restartError] = await Promise.all([
            restart.exited,
            new Response(restart.stdout).text(),
            new Response(restart.stderr).text(),
          ])
          if (restartCode !== 0)
            throw new Error(`Owned provider relaunch failed: ${(restartError || restartOut).slice(-8000)}`)
          expect(restartOut).toContain("provider-configuration-relaunch-ok")
        }
      } finally {
        const owned = relative(resolve(tmpdir()), resolve(root))
        if (!owned || owned.startsWith("..") || isAbsolute(owned) || !root.includes("arforge-provider-configuration-"))
          throw new Error("Unsafe fixture cleanup")
        rmSync(root, { recursive: true, force: true })
      }
    },
    90_000,
  )
