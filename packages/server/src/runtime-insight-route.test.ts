import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { DurableAction } from "@arforge-ai/core/runtime/durable-action"
import { Mcp } from "@arforge-ai/schema/mcp"
import { mcpReconciliationHandle } from "./handlers/runtime-insight"

/**
 * Run the positive route probe in a fresh Bun process. The server's global
 * database flag is intentionally captured during module initialization, so a
 * child process gives this test an isolated SQLite path even when another
 * server test imported the API first. It also releases Windows SQLite handles
 * before the parent removes the temporary directory.
 */
test("runtime insight recovery inspection is wired through the live HTTP route", async () => {
  for (const mode of [
    "postimage",
    "preimage",
    "changed",
    "missing",
    "error",
    "review",
    "rollback",
    "blocked",
  ] as const) {
    const root = mkdtempSync(join(tmpdir(), `arforge-runtime-insight-route-${mode}-`))
    const databasePath = join(root, "actions.db")
    const workspace = join(root, "workspace")
    mkdirSync(workspace)

    try {
      const child = Bun.spawn(
        [process.execPath, join(import.meta.dir, "runtime-insight-route-child.ts"), databasePath, workspace, mode],
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

      if (exitCode !== 0)
        throw new Error(`live recovery route child failed for ${mode} (${exitCode}): ${stderr || stdout}`)
      expect(stdout).toContain(`runtime-insight-route-ok:${mode}`)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
}, 90_000)

test("runtime insight exposes only the identity handle for marked MCP child actions", () => {
  const child = {
    action: {
      parentActionID: "act_parent",
      resources: [Mcp.CHILD_ACTION_RESOURCE, "mcp-server:fixture", "args:secret-should-not-project"],
      intentDigest: "i".repeat(64),
      idempotencyKey: "mcp-idempotency",
    },
    observation: undefined,
    reconciliation: undefined,
  } as unknown as DurableAction.Snapshot

  expect(mcpReconciliationHandle(child)).toEqual({
    actionKind: "mcp",
    actionVersion: "1",
    intentDigest: "i".repeat(64),
    idempotencyKey: "mcp-idempotency",
    state: null,
    evidenceDigest: null,
    source: null,
    observedAt: null,
    summary: null,
    operatorRequired: true,
  })
  expect(mcpReconciliationHandle(child)).not.toHaveProperty("resources")
  expect(mcpReconciliationHandle(child)).not.toHaveProperty("args")

  expect(
    mcpReconciliationHandle({
      ...child,
      action: { ...child.action, parentActionID: undefined },
    } as unknown as DurableAction.Snapshot),
  ).toBeNull()
  expect(
    mcpReconciliationHandle({
      ...child,
      action: { ...child.action, intentDigest: undefined },
    } as unknown as DurableAction.Snapshot),
  ).toBeNull()
})
