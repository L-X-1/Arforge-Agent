import { expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

type WorkerRecord = {
  readonly actionID: string
  readonly intentDigest: string
  readonly idempotencyKey: string
  readonly transportCalls: number
  readonly bindingPresent?: boolean
  readonly killedAfterTimeout?: boolean
  readonly replayBlocked?: boolean
  readonly hookCalls?: number
  readonly sequence?: number
  readonly output?: unknown
  readonly replayedOutput?: unknown
  readonly decision?: {
    readonly kind: string
    readonly state: string
    readonly automaticRetryAllowed: false
    readonly source: string
    readonly evidenceDigest: string
    readonly lookupCalls?: number
  }
}

const runWorker = async (worker: string, databasePath: string, markerPath: string) => {
  const killMarker =
    worker === "seed-timeout-kill"
      ? "timeout-persisted"
      : worker === "seed-hook-kill"
        ? "post-result-hook-started"
        : undefined
  let killRequested = false
  let timedOut = false
  const child = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, "../fixture/mcp-reconciliation-worker.ts"),
      databasePath,
      worker,
      markerPath,
    ],
    {
      cwd: join(import.meta.dir, ".."),
      env: {
        ...process.env,
        ARFORGE_DB: databasePath,
        ARFORGE_DB_URL: "",
        ARFORGE_DB_ADMIN_URL: "",
      },
      stdout: "pipe",
      stderr: "pipe",
      ...(killMarker
        ? {
            ipc: (message: unknown, subprocess: Pick<Bun.Subprocess, "kill">) => {
              if (
                typeof message !== "object" ||
                message === null ||
                !("type" in message) ||
                message.type !== killMarker
              )
                return
              killRequested = true
              subprocess.kill("SIGKILL")
            },
          }
        : {}),
    },
  )
  const guard = setTimeout(() => {
    timedOut = true
    child.kill("SIGKILL")
  }, 20000)
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]).finally(() => clearTimeout(guard))
  if (timedOut) throw new Error(`MCP ${worker} worker exceeded its bounded test deadline`)
  if (killMarker) {
    expect(killRequested).toBe(true)
    expect(child.killed).toBe(true)
    expect(exitCode).not.toBe(0)
  } else if (exitCode !== 0) throw new Error(`MCP ${worker} worker failed (${exitCode}): ${stderr || stdout}`)
  return JSON.parse(readFileSync(markerPath, "utf8")) as WorkerRecord
}

test("rebuilds MCP unknown reconciliation in a cold process without replaying transport", async () => {
  const root = mkdtempSync(join(tmpdir(), "arforge-mcp-cold-reconcile-"))
  const databasePath = join(root, "mcp.db")
  const markerPath = join(root, "marker.json")
  try {
    const seeded = await runWorker("seed", databasePath, markerPath)
    expect(seeded.transportCalls).toBe(1)
    expect(seeded.actionID).toMatch(/^act_[A-Za-z0-9._:-]+$/)
    expect(seeded.intentDigest).toMatch(/^[a-f0-9]{64}$/)
    expect(seeded.idempotencyKey).toBe(seeded.actionID)

    const cold = await runWorker("read", databasePath, markerPath)
    expect(cold).toMatchObject({
      actionID: seeded.actionID,
      intentDigest: seeded.intentDigest,
      idempotencyKey: seeded.idempotencyKey,
      transportCalls: 0,
      decision: {
        kind: "manual_review",
        state: "unknown",
        automaticRetryAllowed: false,
        source: "mcp-durable-action",
      },
    })
    expect(cold.decision?.evidenceDigest).toMatch(/^[a-f0-9]{64}$/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("rebuilds an automatically bound MCP task reference in a cold process without task payload replay", async () => {
  const root = mkdtempSync(join(tmpdir(), "arforge-mcp-cold-task-binding-"))
  const databasePath = join(root, "mcp.db")
  const markerPath = join(root, "marker.json")
  try {
    const seeded = await runWorker("seed-task", databasePath, markerPath)
    expect(seeded.transportCalls).toBe(1)
    expect(seeded.bindingPresent).toBe(true)

    const cold = await runWorker("read-task", databasePath, markerPath)
    expect(cold).toMatchObject({
      actionID: seeded.actionID,
      intentDigest: seeded.intentDigest,
      idempotencyKey: seeded.idempotencyKey,
      transportCalls: 0,
      decision: {
        kind: "confirmed",
        state: "known_success",
        automaticRetryAllowed: false,
        source: "mcp-server-task",
        lookupCalls: 1,
      },
    })
    expect(cold.decision?.evidenceDigest).toMatch(/^[a-f0-9]{64}$/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("real SDK timeout survives SIGKILL and a new process refuses to replay the invocation", async () => {
  const root = mkdtempSync(join(tmpdir(), "arforge-mcp-cold-timeout-"))
  const databasePath = join(root, "mcp.db")
  const markerPath = join(root, "marker.json")
  try {
    const seeded = await runWorker("seed-timeout-kill", databasePath, markerPath)
    expect(seeded.transportCalls).toBe(1)
    expect(seeded.killedAfterTimeout).toBe(true)
    const cold = await runWorker("read-timeout", databasePath, markerPath)
    expect(cold).toMatchObject({
      actionID: seeded.actionID,
      intentDigest: seeded.intentDigest,
      idempotencyKey: seeded.idempotencyKey,
      transportCalls: 0,
      replayBlocked: true,
      decision: { kind: "manual_review", state: "unknown", automaticRetryAllowed: false, source: "mcp-durable-action" },
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("SIGKILL during a post-result hook preserves the MCP result without repeating transport or hooks", async () => {
  const root = mkdtempSync(join(tmpdir(), "arforge-mcp-cold-post-hook-"))
  const databasePath = join(root, "mcp.db")
  const markerPath = join(root, "marker.json")
  try {
    const seeded = await runWorker("seed-hook-kill", databasePath, markerPath)
    expect(seeded.transportCalls).toBe(1)
    expect(seeded.hookCalls).toBe(1)
    expect(seeded.output).toEqual({ content: [{ type: "text", text: "committed remote result" }] })
    const cold = await runWorker("read-hook", databasePath, markerPath)
    expect(cold).toMatchObject({
      actionID: seeded.actionID,
      intentDigest: seeded.intentDigest,
      idempotencyKey: seeded.idempotencyKey,
      transportCalls: 0,
      hookCalls: 0,
      sequence: seeded.sequence,
      replayedOutput: seeded.output,
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
