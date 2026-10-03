import os from "node:os"
import path from "node:path"
import fs from "node:fs/promises"
import { createHash } from "node:crypto"
import { describe, expect } from "bun:test"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { Authorizer } from "@arforge-ai/core/authorizer"
import { DurableAction } from "@arforge-ai/core/runtime/durable-action"
import { Location } from "@arforge-ai/core/location"
import { LocationServiceMap } from "@arforge-ai/core/location-services"
import { AbsolutePath } from "@arforge-ai/core/schema"
import { Effect, Exit, Fiber } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { AppNodeBuilder } from "@arforge-ai/core/effect/app-node-builder"
import { FSUtil } from "@arforge-ai/core/fs-util"
import { SecretProvider } from "@arforge-ai/core/secret-provider"
import { EffectFlock } from "@arforge-ai/core/util/effect-flock"
import { CrossSpawnSpawner } from "@arforge-ai/core/cross-spawn-spawner"
import { Database } from "@arforge-ai/core/database/database"
import { EventTable } from "@arforge-ai/core/event/sql"
import { eq } from "drizzle-orm"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import type { ConfigMCPV1 } from "@arforge-ai/core/v1/config/mcp"
import { MCP } from "../../src/mcp/index"
import { makeIntentSealer } from "../../src/mcp/intent-key"
import { reloadInstance, TestInstance, tmpdirScoped } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      MCP.node,
      LocationServiceMap.node,
      FSUtil.node,
      SecretProvider.node,
      EffectFlock.node,
      Database.node,
      EventV2Bridge.node,
      CrossSpawnSpawner.node,
    ]),
  ),
)

const stdioFixture = path.join(import.meta.dir, "../fixture/mcp-lifecycle-stdio.ts")
// Repeated in-process Bun.build on Windows can reuse stale source handles
// after fixture cleanup (EISDIR / unrelated module text). Build the same SDK
// server in a scoped compiler process; this does not replace its runtime.
const bundleStdioFixture = Effect.fn("test.MCP.bundleStdioFixture")(function* (directory: string) {
  const compiler = yield* ChildProcess.make(
    process.execPath,
    ["build", stdioFixture, "--target=bun", "--format=esm", "--outfile", path.join(directory, "server.mjs")],
    { cwd: path.dirname(stdioFixture), stdin: "ignore", stdout: "ignore", stderr: "inherit" },
  )
  expect(yield* compiler.exitCode.pipe(Effect.timeout("30 seconds"))).toBe(ChildProcessSpawner.ExitCode(0))
})
const pidFile = (directory: string) => path.join(directory, "mcp-approval.pid")
// The startup config fixture is static, so its marker lives at a fixed temp
// path that the test initializer clears.
const startupMarker = path.join(os.tmpdir(), `arforge-local-approval-${process.pid}.pid`)
const disposeMarker = path.join(os.tmpdir(), `arforge-local-approval-dispose-${process.pid}.pid`)
const reloadDisableMarker = path.join(os.tmpdir(), `arforge-local-approval-reload-disable-${process.pid}.pid`)
const disposeConnectedMarker = path.join(os.tmpdir(), `arforge-local-approval-connected-${process.pid}.pid`)
const idempotentMarker = path.join(os.tmpdir(), `arforge-local-approval-idem-${process.pid}.pid`)

const inLocation = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    const locations = yield* LocationServiceMap.Service
    const locationContext = yield* locations.contextEffect(
      Location.Ref.make({ directory: AbsolutePath.make(test.directory) }),
    )
    return yield* Effect.provide(effect, locationContext)
  })

const pendingControl = () =>
  inLocation(
    Authorizer.Service.pipe(
      Effect.flatMap((authorizer) => authorizer.list()),
      Effect.map((list) => list.find((item) => "subject" in item && item.subject.type === "control-plane")),
    ),
  )

const replyPending = (reply: "once" | "reject") =>
  Effect.gen(function* () {
    const request = yield* pollWithTimeout(pendingControl(), "control approval never became pending")
    yield* inLocation(
      Authorizer.Service.pipe(Effect.flatMap((authorizer) => authorizer.reply({ requestID: request.id, reply }))),
    )
    return request
  })

const durableActions = () =>
  inLocation(DurableAction.Service.pipe(Effect.flatMap((durable) => durable.list({ limit: 2_000 }))))

const markerExists = (file: string) =>
  Effect.promise(async () => {
    const handle = Bun.file(file)
    return (await handle.exists()) ? Number(await handle.text()) : undefined
  })

const local = (directory: string, overrides: Record<string, unknown> = {}): ConfigMCPV1.Info & { type: "local" } => ({
  type: "local",
  command: [process.execPath, stdioFixture, "--marker"],
  environment: { MCP_LIFECYCLE_PID_FILE: pidFile(directory) },
  ...overrides,
})

const waitForStatus = (mcp: MCP.Interface, server: string, expected: string) =>
  pollWithTimeout(
    Effect.gen(function* () {
      const current = (yield* mcp.status())[server]
      if (expected === "connected" && current?.status === "failed") return yield* Effect.fail(new Error(current.error))
      return current?.status === expected ? current.status : undefined
    }),
    `${server} never reached ${expected}`,
  )

const controlPendingList = () =>
  inLocation(
    Authorizer.Service.pipe(
      Effect.flatMap((authorizer) => authorizer.list()),
      Effect.map((list) => list.filter((item) => "subject" in item && item.subject.type === "control-plane")),
    ),
  )

const pendingControlRequired = () => pollWithTimeout(pendingControl(), "control approval never became pending")
const onePendingControlRequired = () =>
  pollWithTimeout(
    Effect.map(controlPendingList(), (list) => (list.length === 1 ? list : undefined)),
    "control approval list never converged to one pending request",
  )

const replyWithExit = (requestID: string) =>
  inLocation(
    Authorizer.Service.pipe(
      Effect.flatMap((authorizer) => authorizer.reply({ requestID: requestID as never, reply: "once" })),
    ),
  ).pipe(Effect.exit)

const namedActions = (name: string) =>
  Effect.map(durableActions(), (actions) => actions.filter(({ action }) => action.name === name))

const isTerminalActionStatus = (status: AgentRuntime.ActionStatus | undefined) =>
  status === "settled" || status === "blocked" || status === "cancelled"

const serializedActionEvents = (actionID: AgentRuntime.ActionID) =>
  Database.Service.pipe(
    Effect.flatMap(({ db }) =>
      db
        .select({ type: EventTable.type, data: EventTable.data })
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, actionID))
        .all(),
    ),
    Effect.map((rows) => JSON.stringify(rows)),
  )

const isProcessAlive = (pid: number) =>
  Effect.promise(() =>
    Promise.resolve().then(() => {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    }),
  )

describe("MCP local connect authorization", () => {
  for (const phase of ["startup", "request"] as const)
    it.instance(`changing the ${phase} timeout retires the prior local approval without spawning`, () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const mcp = yield* MCP.Service
        const timeout = { startup: 5000, request: 1000 }
        const config = local(test.directory, { timeout })
        yield* mcp.add("timeout-change", config)
        const first = yield* pendingControlRequired()
        yield* mcp.add("timeout-change", { ...config, timeout: { ...timeout, [phase]: timeout[phase] + 1 } })
        const second = yield* pendingControlRequired()
        expect(second.id).not.toBe(first.id)
        expect(second.resources).not.toEqual(first.resources)
        expect(yield* controlPendingList()).toHaveLength(1)
        expect(yield* markerExists(pidFile(test.directory))).toBeUndefined()
        yield* replyPending("reject")
        expect(yield* namedActions("mcp.connect:timeout-change")).toHaveLength(2)
        expect(yield* markerExists(pidFile(test.directory))).toBeUndefined()
      }),
    )

  for (const runtime of ["bun", "node"] as const)
    it.instance(
      `explicit read dependencies are approved, frozen and used by the original MCP connection: ${runtime}`,
      () =>
        Effect.gen(function* () {
          const test = yield* TestInstance
          const mcp = yield* MCP.Service
          const library = yield* tmpdirScoped()
          const unapproved = yield* tmpdirScoped()
          yield* bundleStdioFixture(library)
          const paths = [path.relative(test.directory, library)]
          const executable = runtime === "bun" ? process.execPath : Bun.which("node")
          if (!executable) throw new Error("Node is required for the cross-runtime MCP fixture")
          const timeout = { startup: 10_000, request: 1000 }
          const config = local(test.directory, {
            command: [
              executable,
              ...(runtime === "node" ? ["--preserve-symlinks", "--preserve-symlinks-main"] : []),
              path.join(library, "server.mjs"),
              "--marker",
              "--noisy-stderr",
              "--connect-delay-ms",
              "200",
            ],
            read_only_paths: paths,
            timeout,
          })
          yield* mcp.add("read-dependency", config)
          expect((yield* mcp.status())["read-dependency"]?.status).toBe("needs_approval")
          expect(yield* markerExists(pidFile(test.directory))).toBeUndefined()
          const ask = yield* pendingControlRequired()
          expect(ask.resources).toContain(`read-only:${library}`)
          expect(ask.resources).not.toContain(`read-only:${unapproved}`)
          paths.splice(0, paths.length, unapproved)
          timeout.startup = 1
          timeout.request = 1
          yield* replyPending("once")
          yield* waitForStatus(mcp, "read-dependency", "connected")
          expect(Object.keys(yield* mcp.tools())).toEqual(["read-dependency_current_directory"])
          expect((yield* mcp.tools())["read-dependency_current_directory"]?.timeout).toBe(1000)
          const actions = yield* namedActions("mcp.connect:read-dependency")
          expect(actions).toHaveLength(1)
          const pid = yield* markerExists(pidFile(test.directory))
          expect(pid).toBeDefined()
          yield* mcp.disconnect("read-dependency")
          yield* pollWithTimeout(
            Effect.map(isProcessAlive(pid!), (alive) => (alive ? undefined : true)),
            "read-dependency process did not exit",
          )

          yield* mcp.add("read-dependency", { ...config, read_only_paths: [unapproved] })
          const nextAsk = yield* pendingControlRequired()
          expect(nextAsk.id).not.toBe(ask.id)
          expect(nextAsk.resources).toContain(`read-only:${unapproved}`)
          expect(nextAsk.resources).not.toContain(`read-only:${library}`)
          yield* replyPending("reject")
          expect(yield* namedActions("mcp.connect:read-dependency")).toHaveLength(2)
        }),
    )

  it.instance("replacing an approved read directory blocks the child before any side effect", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const mcp = yield* MCP.Service
      const library = path.join(test.directory, "dependency")
      const retired = path.join(test.directory, "dependency-retired")
      const marker = pidFile(test.directory)
      yield* Effect.promise(() => fs.mkdir(library))
      yield* mcp.add(
        "read-directory-drift",
        local(test.directory, {
          command: [
            process.execPath,
            "-e",
            "require('node:fs').writeFileSync(process.env.MCP_LIFECYCLE_PID_FILE, String(process.pid))",
          ],
          read_only_paths: [library],
        }),
      )
      expect((yield* mcp.status())["read-directory-drift"]?.status).toBe("needs_approval")
      // Both paths are newly created siblings inside this fixture, never user data.
      yield* Effect.promise(async () => {
        await fs.rename(library, retired)
        await fs.mkdir(library)
      })
      yield* replyPending("once")
      yield* waitForStatus(mcp, "read-directory-drift", "failed")
      expect((yield* mcp.status())["read-directory-drift"]).toMatchObject({
        status: "failed",
        error: expect.stringContaining("重新审批"),
      })
      expect(yield* markerExists(marker)).toBeUndefined()
      expect(Object.keys(yield* mcp.tools())).toEqual([])
    }),
  )

  it.instance("invalid explicit read dependencies fail before requesting approval", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const mcp = yield* MCP.Service
      for (const dependency of ["missing-dependency", "", "bad\0path"]) {
        const result = yield* mcp.add("invalid-read", local(test.directory, { read_only_paths: [dependency] }))
        expect(result.status).toMatchObject({
          "invalid-read": { status: "failed", error: expect.stringContaining("read_only_paths") },
        })
        expect(yield* controlPendingList()).toHaveLength(0)
        expect(yield* markerExists(pidFile(test.directory))).toBeUndefined()
      }
    }),
  )

  it.instance("a noisy startup failure drains stderr and exposes only a safe diagnostic", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const mcp = yield* MCP.Service
      const secret = "MCP_STARTUP_FIXTURE_SECRET"
      yield* mcp.add(
        "startup-error",
        local(test.directory, {
          command: [
            process.execPath,
            "-e",
            `process.stderr.write("x".repeat(512 * 1024) + "${secret} CouldntReadCurrentDirectory\\n", () => process.exit(1))`,
          ],
        }),
      )
      expect((yield* mcp.status())["startup-error"]?.status).toBe("needs_approval")
      yield* replyPending("once")
      yield* waitForStatus(mcp, "startup-error", "failed")
      const status = (yield* mcp.status())["startup-error"]
      expect(status?.status).toBe("failed")
      if (status?.status !== "failed") throw new Error("expected an observable startup failure")
      expect(status.error).toContain("已授权")
      expect(status.error).not.toContain(secret)
      expect(status.error.length).toBeLessThan(256)
      expect(JSON.stringify(yield* durableActions())).not.toContain(secret)
      expect(Object.keys(yield* mcp.tools())).toEqual([])
      yield* mcp.disconnect("startup-error")
      expect((yield* mcp.status())["startup-error"]?.status).toBe("disabled")
    }),
  )

  it.instance("the default backend connects a complete MCP server inside its approved workspace", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const mcp = yield* MCP.Service
      const runtimeDirectory = path.join(test.directory, "mcp-runtime")
      yield* bundleStdioFixture(runtimeDirectory)
      // Bundle the original SDK server, not a replacement protocol stub.
      // Source/runtime reads stay inside the explicitly approved workspace;
      // the existing external-source cases remain separate and unchanged.
      yield* mcp.add(
        "workspace-server",
        local(test.directory, {
          command: [process.execPath, path.join(runtimeDirectory, "server.mjs"), "--marker", "--noisy-stderr"],
        }),
      )
      expect((yield* mcp.status())["workspace-server"]?.status).toBe("needs_approval")
      expect(yield* markerExists(pidFile(test.directory))).toBeUndefined()
      yield* replyPending("once")
      yield* waitForStatus(mcp, "workspace-server", "connected")
      const pid = yield* markerExists(pidFile(test.directory))
      expect(pid).toBeDefined()
      expect(Object.keys(yield* mcp.tools())).toEqual(["workspace-server_current_directory"])
      yield* mcp.disconnect("workspace-server")
      yield* pollWithTimeout(
        Effect.map(isProcessAlive(pid!), (alive) => (alive ? undefined : true)),
        "the approved workspace MCP process did not exit after disconnect",
      )
      expect((yield* mcp.status())["workspace-server"]?.status).toBe("disabled")
    }),
  )

  it.instance("declared local tool scope binds the frozen config with a protected persistent HMAC", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const mcp = yield* MCP.Service
      const secret = "MCP_SCOPE_SECRET_must_not_escape"
      const base = local(test.directory, {
        command: [process.execPath, stdioFixture, "--scope", "alpha", "--token", secret],
      })

      yield* mcp.add("scope-alpha", base)
      yield* mcp.add("scope-beta", {
        ...base,
        command: [process.execPath, stdioFixture, "--scope", "beta", "--token", secret],
      })
      const alpha = yield* mcp.declaredScope("scope-alpha")
      const beta = yield* mcp.declaredScope("scope-beta")

      expect(alpha).toBeDefined()
      expect(beta).toBeDefined()
      expect(alpha!.endpoint).toStartWith("exec:")
      expect(alpha!.endpoint).toContain("#")
      // Same executable but different argv/configurations must never share a
      // tool-call authorization or durable child-action identity.
      expect(alpha!.endpoint).not.toBe(beta!.endpoint)
      const serialized = JSON.stringify({ alpha, beta })
      expect(serialized).not.toContain(secret)
      expect(serialized).not.toContain("--scope")
      // HMAC-SHA256 is base64url (43 chars), not the naked 64-hex canonical
      // SHA hash that would allow offline dictionary attacks on argv values.
      const fingerprint = alpha!.endpoint.slice(alpha!.endpoint.lastIndexOf("#") + 1)
      expect(fingerprint).toMatch(/^[A-Za-z0-9_-]{43}$/)
      expect(fingerprint).not.toMatch(/^[a-f0-9]{64}$/)
    }),
  )

  it.instance("concurrent intent-key initialization converges on one protected persistent key", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const keyFile = path.join(test.directory, "mcp-intent-key.json")
      const sealers = yield* Effect.all(
        Array.from({ length: 8 }, () => makeIntentSealer(keyFile)),
        { concurrency: "unbounded" },
      )
      const digests = sealers.map((seal) => seal({ purpose: "concurrency-regression", value: 42 }))
      expect(new Set(digests).size).toBe(1)
      const raw = yield* Effect.promise(() => Bun.file(keyFile).text())
      expect(raw).toContain("arforge-protected-json")
      expect(raw).not.toContain(digests[0]!)
      const afterRestart = yield* makeIntentSealer(keyFile)
      expect(afterRestart({ purpose: "concurrency-regression", value: 42 })).toBe(digests[0])
    }),
  )

  it.instance(
    "startup with an enabled local server reports needs_approval and never spawns before approval",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const mcp = yield* MCP.Service
        expect((yield* mcp.status()).demo?.status).toBe("needs_approval")
        expect(yield* markerExists(startupMarker)).toBeUndefined()
        expect(yield* mcp.tools()).toEqual({})

        const request = yield* replyPending("once")
        if (!("subject" in request)) throw new Error("expected a control-plane pending request")
        // The pending approval carries the real request identity, the
        // control-plane subject (never a sessionID), and the server/action
        // reason in metadata.
        expect(request.id).toStartWith("per_")
        expect("sessionID" in request).toBe(false)
        expect(request.subject.type).toBe("control-plane")
        expect(request.subject.actor).toBe("user")
        expect(String(request.subject.location)).toBe(test.directory)
        expect(request.metadata).toMatchObject({
          actionID: expect.any(String),
          intentDigest: expect.any(String),
        })
        expect(request.metadata).not.toHaveProperty("server")

        yield* waitForStatus(mcp, "demo", "connected")
        expect(yield* markerExists(startupMarker)).toBeDefined()
        expect(Object.keys(yield* mcp.tools())).toEqual(["demo_current_directory"])
      }),
    {
      init: (directory) =>
        Effect.promise(() => Bun.$`rm -f ${startupMarker}`.quiet().catch(() => undefined)).pipe(Effect.asVoid),
      config: {
        mcp: {
          demo: {
            type: "local",
            command: [process.execPath, stdioFixture, "--marker"],
            environment: { MCP_LIFECYCLE_PID_FILE: startupMarker },
            enabled: true,
          },
        },
      },
    },
  )

  it.instance("reject and retry keep the spawn at 0 until the fresh approval", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const mcp = yield* MCP.Service
      yield* mcp.add("rejected", local(test.directory))
      expect((yield* mcp.status()).rejected?.status).toBe("needs_approval")
      expect(yield* markerExists(pidFile(test.directory))).toBeUndefined()

      yield* replyPending("reject")
      yield* waitForStatus(mcp, "rejected", "failed")
      expect(yield* markerExists(pidFile(test.directory))).toBeUndefined()

      // A new real attempt asks afresh and can be approved.
      yield* mcp.connect("rejected")
      expect((yield* mcp.status()).rejected?.status).toBe("needs_approval")
      yield* replyPending("once")
      yield* waitForStatus(mcp, "rejected", "connected")
      expect(yield* markerExists(pidFile(test.directory))).toBeDefined()
    }),
  )

  it.instance("interrupting a pending attempt keeps the spawn at 0", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const mcp = yield* MCP.Service
      yield* mcp.add("interrupted", local(test.directory))
      expect((yield* mcp.status()).interrupted?.status).toBe("needs_approval")
      yield* mcp.disconnect("interrupted")
      expect((yield* mcp.status()).interrupted?.status).toBe("disabled")
      expect(yield* markerExists(pidFile(test.directory))).toBeUndefined()
      expect(yield* mcp.tools()).toEqual({})
    }),
  )

  it.instance("a forged asked event cannot start a local process", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const mcp = yield* MCP.Service
      // Replying to a forged request that never went through the gateway must
      // not spawn anything.
      const forged = AgentRuntime.ControlRequest.make({
        id: "per_forged" as never,
        subject: AgentRuntime.ControlPlaneSubject.make({
          type: "control-plane",
          id: AgentRuntime.ControlPlaneID.create(),
          location: AbsolutePath.make(test.directory),
          project: "global" as never,
          actor: "user",
          principalRef: AgentRuntime.ControlPrincipalRef.make("prn_test"),
          requestID: AgentRuntime.ControlPlaneRequestID.create(),
        }),
        action: "mcp.connect",
        resources: [],
      })
      yield* inLocation(
        Authorizer.Service.pipe(
          Effect.flatMap((authorizer) => authorizer.reply({ requestID: forged.id, reply: "once" })),
        ),
      ).pipe(Effect.exit, Effect.ignore)
      expect(yield* mcp.tools()).toEqual({})
      expect(yield* markerExists(pidFile(test.directory))).toBeUndefined()
    }),
  )

  it.instance("concurrent connects share one pending approval and one spawn", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const mcp = yield* MCP.Service
      const [first, second] = yield* Effect.all([
        mcp.add("concurrent", local(test.directory)),
        mcp.add("concurrent", local(test.directory)),
      ])
      expect(first.status).toMatchObject({ concurrent: { status: "needs_approval" } })
      expect(second.status).toMatchObject({ concurrent: { status: "needs_approval" } })
      const pending = yield* inLocation(
        Authorizer.Service.pipe(
          Effect.flatMap((authorizer) => authorizer.list()),
          Effect.map((list) => list.filter((item) => "subject" in item && item.subject.type === "control-plane")),
        ),
      )
      expect(pending).toHaveLength(1)
      yield* replyPending("once")
      yield* waitForStatus(mcp, "concurrent", "connected")
      expect(yield* markerExists(pidFile(test.directory))).toBeDefined()
    }),
  )

  it.instance("concurrent user retries around a fast approval retain one local generation", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const mcp = yield* MCP.Service
      const config = local(test.directory)

      // Start the first caller, then schedule a second user retry and approve
      // immediately. Depending on the scheduler, the second caller either
      // observes the pending attempt or the already connected one; both paths
      // must retain the same durable action and process generation.
      const first = yield* mcp.add("fast-concurrent", config).pipe(Effect.forkChild)
      yield* waitForStatus(mcp, "fast-concurrent", "needs_approval")
      const second = yield* mcp.add("fast-concurrent", config).pipe(Effect.forkChild)
      yield* replyPending("once")
      yield* Fiber.join(first)
      yield* Fiber.join(second)

      yield* waitForStatus(mcp, "fast-concurrent", "connected")
      expect(yield* namedActions("mcp.connect:fast-concurrent")).toHaveLength(1)
      expect(yield* controlPendingList()).toHaveLength(0)
      expect(yield* markerExists(pidFile(test.directory))).toBeDefined()
    }),
  )

  it.instance("approval executes the frozen argv, timeout, and final environment despite caller mutation", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const mcp = yield* MCP.Service
      const approvedMarker = path.join(test.directory, "frozen-approved.pid")
      const mutatedMarker = path.join(test.directory, "frozen-mutated.pid")
      // The delayed handshake makes timeout capture observable: if the spawn
      // re-read the caller's mutated 1ms timeout, this connection must fail.
      const command = [process.execPath, stdioFixture, "--marker", "--connect-delay-ms", "100"]
      const environment: Record<string, string> = { MCP_LIFECYCLE_PID_FILE: approvedMarker }
      const mutable = { type: "local" as const, command, environment, timeout: 10_000 }

      yield* mcp.add("frozen", mutable)
      expect((yield* mcp.status()).frozen?.status).toBe("needs_approval")
      command.splice(1, command.length - 1, "missing-after-approval.ts")
      environment.MCP_LIFECYCLE_PID_FILE = mutatedMarker
      mutable.timeout = 1

      yield* replyPending("once")
      yield* waitForStatus(mcp, "frozen", "connected")
      expect(yield* markerExists(approvedMarker)).toBeDefined()
      expect(yield* markerExists(mutatedMarker)).toBeUndefined()
    }),
  )

  it.instance("executable identity changes after approval intent creation require a fresh approval", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const mcp = yield* MCP.Service
      const executable = path.join(test.directory, process.platform === "win32" ? "frozen-bun.exe" : "frozen-bun")
      const marker = path.join(test.directory, "identity-change.pid")
      yield* Effect.promise(() => Bun.write(executable, Bun.file(process.execPath))).pipe(Effect.asVoid)
      if (process.platform !== "win32")
        yield* Effect.promise(() => Bun.$`chmod 755 ${executable}`.quiet()).pipe(Effect.asVoid)

      yield* mcp.add("identity-change", {
        type: "local",
        command: [executable, stdioFixture, "--marker"],
        environment: { MCP_LIFECYCLE_PID_FILE: marker },
      })
      expect((yield* mcp.status())["identity-change"]?.status).toBe("needs_approval")
      yield* Effect.promise(() => Bun.write(executable, "changed-after-approval")).pipe(Effect.asVoid)

      yield* replyPending("once")
      yield* waitForStatus(mcp, "identity-change", "failed")
      expect(yield* markerExists(marker)).toBeUndefined()
      expect((yield* mcp.status())["identity-change"]).toMatchObject({
        status: "failed",
        error: expect.stringContaining("重新审批"),
      })
    }),
  )

  it.instance("config, command, args, env key, and workdir changes never reuse the old grant", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const mcp = yield* MCP.Service
      yield* mcp.add("mutating", local(test.directory))
      yield* replyPending("once")
      yield* waitForStatus(mcp, "mutating", "connected")
      const firstAction = (yield* durableActions()).find(({ action }) => action.name === "mcp.connect:mutating")
      expect(firstAction).toBeDefined()

      yield* mcp.disconnect("mutating")
      // A different environment key set changes the intent and therefore the
      // durable action identity: the old approval cannot gate the new spawn.
      const secret = "S3CRET_VALUE_xyz"
      yield* mcp.add("mutating", {
        ...local(test.directory),
        environment: { MCP_LIFECYCLE_PID_FILE: pidFile(test.directory), EXTRA_KEY: secret },
      })
      expect((yield* mcp.status()).mutating?.status).toBe("needs_approval")
      const secondAction = (yield* durableActions()).find(({ action }) => action.name === "mcp.connect:mutating")
      expect(secondAction?.action.id).not.toBe(firstAction?.action.id)
      if (!secondAction) throw new Error("missing changed MCP durable action")
      const auditSurface = JSON.stringify({
        snapshot: secondAction,
        pending: yield* pendingControl(),
        durableEvents: yield* serializedActionEvents(secondAction.action.id),
      })
      const nakedSecretSha = createHash("sha256").update(secret).digest("hex")
      expect(auditSurface).not.toContain(secret)
      expect(auditSurface).not.toContain(nakedSecretSha)
      yield* replyPending("once")
      yield* waitForStatus(mcp, "mutating", "connected")
      // The bound resources carry the env key names but never their values.
      const bound = secondAction?.action.resources
      expect(bound).toContain("env:EXTRA_KEY")
      expect(bound?.some((resource) => resource.includes("S3CRET_VALUE"))).toBe(false)
      expect(bound?.some((resource) => /#[a-f\d]{64}$/i.test(resource))).toBe(false)
    }),
  )

  it.instance("process exit cleans up the connection and reports failed", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const mcp = yield* MCP.Service
      yield* mcp.add("dying", local(test.directory))
      yield* replyPending("once")
      yield* waitForStatus(mcp, "dying", "connected")
      const pid = yield* markerExists(pidFile(test.directory))
      expect(pid).toBeDefined()
      yield* Effect.promise(() => Promise.resolve(process.kill(pid!, "SIGTERM")).catch(() => undefined))
      yield* waitForStatus(mcp, "dying", "failed")
      expect(yield* mcp.tools()).toEqual({})
    }),
  )

  it.instance(
    "awaiting-approval recovery binds one durable action and one request identity across runtime rebuilds",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const mcp = yield* MCP.Service
        // Startup init uses the recovery initiator and reports needs_approval
        // without spawning.
        expect((yield* mcp.status()).demo?.status).toBe("needs_approval")
        expect(yield* markerExists(startupMarker)).toBeUndefined()
        const firstName = "mcp.connect:demo"
        const first = (yield* namedActions(firstName))[0]
        expect(first).toBeDefined()
        const actionID = first!.action.id
        const firstSubject = "subject" in first!.action ? first!.action.subject : undefined
        const requestID = firstSubject?.type === "control-plane" ? firstSubject?.requestID : undefined
        expect(requestID).toBeDefined()
        // P1-4: the startup/recovery attempt carries the recovery initiator.
        expect(first!.action.initiator).toBe("recovery")
        expect(first!.action.resources).toContain(`cwd:${test.directory}`)
        const firstAsk = yield* pendingControlRequired()
        expect(firstAsk?.id).toBeDefined()

        // More than 500 newer real durable actions bury this pending action
        // beyond the legacy fixed scan window. Recovery must still locate
        // the exact original identity rather than minting a duplicate.
        yield* inLocation(
          EventV2Bridge.Service.pipe(
            Effect.flatMap((events) =>
              Effect.forEach(
                Array.from({ length: 550 }, (_, index) => index),
                (index) => {
                  const noiseID = AgentRuntime.ActionID.create()
                  const action = AgentRuntime.Action.make({
                    ...first!.action,
                    id: noiseID,
                    name: `mcp-recovery-noise:${index}`,
                    // An ActionProposed event is the initial aggregate fact;
                    // its embedded action must not copy the source action's
                    // later awaiting_approval replay state.
                    status: "proposed",
                  })
                  return events.publish(AgentRuntime.Event.ActionProposed, {
                    actionID: noiseID,
                    ...(firstSubject ? { subject: firstSubject } : {}),
                    action,
                  })
                },
                { concurrency: 8, discard: true },
              ),
            ),
          ),
        )
        expect((yield* durableActions()).length).toBeGreaterThan(500)

        // Rebuild twice before approval: the SAME durable action is
        // re-presented under the SAME request identity, no duplicate action,
        // and exactly one pending ask at a time.
        for (let rebuild = 0; rebuild < 2; rebuild++) {
          yield* reloadInstance({ directory: test.directory })
          yield* waitForStatus(mcp, "demo", "needs_approval")
          expect(yield* markerExists(startupMarker)).toBeUndefined()
          const current = yield* namedActions(firstName)
          expect(current).toHaveLength(1)
          expect(current[0]!.action.id).toBe(actionID)
          expect(current[0]!.action.status).toBe("awaiting_approval")
          const subject = "subject" in current[0]!.action ? current[0]!.action.subject : undefined
          expect(subject?.type === "control-plane" ? subject?.requestID : undefined).toBe(requestID)
          const asks = yield* controlPendingList()
          expect(asks).toHaveLength(1)
          expect(asks[0]!.id).not.toBe(firstAsk?.id)
          const askSubject = "subject" in asks[0]! ? asks[0]!.subject : undefined
          expect(askSubject?.type === "control-plane" ? askSubject?.requestID : undefined).toBe(requestID)
        }

        // The abandoned pre-rebuild ask can never be replied into a spawn.
        const staleReply = yield* replyWithExit(firstAsk!.id)
        expect(Exit.isSuccess(staleReply)).toBe(false)
        expect(yield* markerExists(startupMarker)).toBeUndefined()

        // Only the current pending ask can authorize the single spawn, and
        // it settles the SAME durable action.
        const finalAsk = yield* pendingControlRequired()
        yield* inLocation(
          Authorizer.Service.pipe(
            Effect.flatMap((authorizer) => authorizer.reply({ requestID: finalAsk!.id, reply: "once" })),
          ),
        )
        const terminalStatus = yield* pollWithTimeout(
          Effect.map(mcp.status(), (statuses) => {
            const status = statuses.demo
            return status?.status === "needs_approval" ? undefined : status
          }),
          "demo approval never reached a terminal status",
          "15 seconds",
        )
        expect(terminalStatus).toMatchObject({ status: "connected" })
        expect(yield* markerExists(startupMarker)).toBeDefined()
        const final = yield* namedActions(firstName)
        expect(final).toHaveLength(1)
        expect(final[0]!.action.id).toBe(actionID)
        expect(final[0]!.action.status).toBe("settled")
      }),
    {
      init: (directory) =>
        Effect.promise(() => Bun.$`rm -f ${startupMarker}`.quiet().catch(() => undefined)).pipe(Effect.asVoid),
      config: {
        mcp: {
          demo: {
            type: "local",
            command: [process.execPath, stdioFixture, "--marker"],
            environment: { MCP_LIFECYCLE_PID_FILE: startupMarker },
            enabled: true,
          },
        },
      },
    },
    60_000,
  )

  it.instance("disabling a pending server atomically cancels it: the abandoned ask can never spawn", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const mcp = yield* MCP.Service
      yield* mcp.add("disabled", local(test.directory))
      expect((yield* mcp.status()).disabled?.status).toBe("needs_approval")
      const ask = yield* pendingControlRequired()
      expect(ask?.id).toBeDefined()
      const oldAction = (yield* namedActions("mcp.connect:disabled"))[0]

      // Disabling cancels the attempt and makes the durable action terminal.
      yield* mcp.add("disabled", { ...local(test.directory), enabled: false })
      expect((yield* mcp.status()).disabled?.status).toBe("disabled")
      expect(yield* markerExists(pidFile(test.directory))).toBeUndefined()
      yield* pollWithTimeout(
        Effect.map(namedActions("mcp.connect:disabled"), (actions) =>
          isTerminalActionStatus(actions[0]?.action.status) ? actions[0]!.action.status : undefined,
        ),
        "old action never became terminal",
      )

      // The old requestID can never be replied into a grant or a spawn; no
      // new pending ask exists after the cancel.
      const staleReply = yield* replyWithExit(ask!.id)
      expect(Exit.isSuccess(staleReply)).toBe(false)
      expect(yield* markerExists(pidFile(test.directory))).toBeUndefined()
      expect(yield* mcp.tools()).toEqual({})
      expect(yield* controlPendingList()).toHaveLength(0)
      expect(yield* namedActions("mcp.connect:disabled")).toHaveLength(1)
      void oldAction
    }),
  )

  it.instance(
    "replacement cancels an approved in-flight start before its side effect and terminates the old action",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const mcp = yield* MCP.Service
        const oldMarker = path.join(test.directory, "approval-race-old.pid")
        const newMarker = path.join(test.directory, "approval-race-new.pid")
        const readyMarker = path.join(test.directory, "approval-race-ready.pid")
        const releaseMarker = path.join(test.directory, "approval-race-release")
        const name = "mcp.connect:approval-race"
        yield* mcp.add("approval-race", {
          type: "local",
          command: [process.execPath, stdioFixture, "--marker"],
          environment: {
            MCP_LIFECYCLE_PID_FILE: oldMarker,
            MCP_MARKER_READY_FILE: readyMarker,
            MCP_MARKER_RELEASE_FILE: releaseMarker,
          },
        })
        const oldAsk = yield* pendingControlRequired()
        const oldAction = (yield* namedActions(name))[0]
        expect(oldAsk).toBeDefined()
        expect(oldAction).toBeDefined()

        // Approve the real spawn and wait until the child reaches the barrier
        // immediately before its marker side effect. Replacement must interrupt
        // and compensate that approved in-flight attempt before returning.
        yield* replyPending("once")
        const approvedPID = yield* pollWithTimeout(
          markerExists(readyMarker),
          "approved child never reached its side-effect barrier",
        )
        expect(approvedPID).toBeDefined()
        if (approvedPID === undefined) throw new Error("approved child PID is missing")
        yield* mcp.add("approval-race", {
          type: "local",
          command: [process.execPath, stdioFixture, "--marker"],
          environment: { MCP_LIFECYCLE_PID_FILE: newMarker },
        })

        expect((yield* mcp.status())["approval-race"]?.status).toBe("needs_approval")
        expect(yield* markerExists(oldMarker)).toBeUndefined()
        const afterReplacement = yield* namedActions(name)
        const oldSnapshot = afterReplacement.find(({ action }) => action.id === oldAction!.action.id)
        expect(oldSnapshot).toBeDefined()
        if (!oldSnapshot) throw new Error("old durable action is missing after replacement")
        expect(["settled", "blocked", "cancelled"]).toContain(oldSnapshot.action.status)
        const currentAsk = yield* pollWithTimeout(
          Effect.map(controlPendingList(), (list) => list.find((item) => item.id !== oldAsk.id)),
          "replacement approval never became pending",
        )
        expect(currentAsk?.id).not.toBe(oldAsk?.id)
        yield* pollWithTimeout(
          Effect.map(isProcessAlive(approvedPID), (alive) => (alive ? undefined : false)),
          "cancelled approved child process remained alive",
          "10 seconds",
        )

        yield* replyPending("once")
        yield* waitForStatus(mcp, "approval-race", "connected")
        expect(yield* markerExists(newMarker)).toBeDefined()
        expect(yield* markerExists(oldMarker)).toBeUndefined()
      }),
    20_000,
  )

  it.instance(
    "a pending env value change cancels the old attempt; only the new approval spawns the new configuration",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const mcp = yield* MCP.Service
        const pidA = path.join(test.directory, "env-a.pid")
        const pidB = path.join(test.directory, "env-b.pid")
        const name = "mcp.connect:envchange"
        yield* mcp.add("envchange", { ...local(test.directory), environment: { MCP_LIFECYCLE_PID_FILE: pidA } })
        expect((yield* mcp.status()).envchange?.status).toBe("needs_approval")
        const firstAsk = yield* pendingControlRequired()
        const firstAction = (yield* namedActions(name))[0]

        // Same env KEY, different VALUE: the canonical intent changes (digest)
        // while the bound resources stay identical, so only a fresh action can
        // ask — never a reuse of the old pending.
        yield* mcp.add("envchange", { ...local(test.directory), environment: { MCP_LIFECYCLE_PID_FILE: pidB } })
        expect((yield* mcp.status()).envchange?.status).toBe("needs_approval")
        yield* pollWithTimeout(
          Effect.map(namedActions(name), (actions) =>
            actions.some(({ action }) => isTerminalActionStatus(action.status))
              ? actions.find(({ action }) => isTerminalActionStatus(action.status))!.action.status
              : undefined,
          ),
          "old action never became terminal",
        )
        const after = yield* namedActions(name)
        expect(after).toHaveLength(2)
        const newAction = after.find(({ action }) => action.id !== firstAction?.action.id)
        expect(newAction?.action.id).not.toBe(firstAction?.action.id)
        const secondAsk = yield* pollWithTimeout(
          Effect.map(controlPendingList(), (list) => list.find((item) => item.id !== firstAsk.id)),
          "replacement approval never became pending",
        )
        expect(secondAsk?.id).not.toBe(firstAsk?.id)

        // The old request reply cannot spawn the old configuration.
        const staleReply = yield* replyWithExit(firstAsk!.id)
        expect(Exit.isSuccess(staleReply)).toBe(false)
        expect(yield* markerExists(pidA)).toBeUndefined()

        // Only the new pending ask spawns the new configuration.
        yield* inLocation(
          Authorizer.Service.pipe(
            Effect.flatMap((authorizer) => authorizer.reply({ requestID: secondAsk!.id, reply: "once" })),
          ),
        )
        yield* waitForStatus(mcp, "envchange", "connected")
        expect(yield* markerExists(pidB)).toBeDefined()
        expect(yield* markerExists(pidA)).toBeUndefined()
        const terminal = (yield* namedActions(name)).filter(({ action }) => isTerminalActionStatus(action.status))
        expect(terminal).toHaveLength(2)
      }),
  )

  it.instance("switching a pending local server to remote never spawns the old local configuration", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const mcp = yield* MCP.Service
      yield* mcp.add("switch", local(test.directory))
      expect((yield* mcp.status()).switch?.status).toBe("needs_approval")
      const ask = yield* pendingControlRequired()
      expect(ask?.id).toBeDefined()

      // local → remote abandons the local attempt atomically; the remote
      // connect is unreachable and fails closed.
      yield* mcp.add("switch", { type: "remote", url: "http://127.0.0.1:1" })
      yield* waitForStatus(mcp, "switch", "failed")
      expect(yield* markerExists(pidFile(test.directory))).toBeUndefined()
      yield* pollWithTimeout(
        Effect.map(namedActions("mcp.connect:switch"), (actions) =>
          isTerminalActionStatus(actions[0]?.action.status) ? actions[0]!.action.status : undefined,
        ),
        "old local action never became terminal",
      )

      const staleReply = yield* replyWithExit(ask!.id)
      expect(Exit.isSuccess(staleReply)).toBe(false)
      expect(yield* markerExists(pidFile(test.directory))).toBeUndefined()
      expect(yield* mcp.tools()).toEqual({})
    }),
  )

  it.instance(
    "disposing a pending instance abandons the attempt without a spawn or a stale ask",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const mcp = yield* MCP.Service
        expect((yield* mcp.status()).disposed?.status).toBe("needs_approval")
        expect(yield* markerExists(disposeMarker)).toBeUndefined()

        // App shutdown/rebuild interrupts the attempt: no spawn, no rescued
        // execution, no stale ask; the rebuild re-presents the SAME pending
        // action under the same identity.
        yield* reloadInstance({ directory: test.directory })
        yield* waitForStatus(mcp, "disposed", "needs_approval")
        expect(yield* markerExists(disposeMarker)).toBeUndefined()
        yield* onePendingControlRequired()
        expect(yield* namedActions("mcp.connect:disposed")).toHaveLength(1)

        yield* replyPending("once")
        yield* waitForStatus(mcp, "disposed", "connected")
        expect(yield* markerExists(disposeMarker)).toBeDefined()
        void test
      }),
    {
      init: (directory) =>
        Effect.promise(() => Bun.$`rm -f ${disposeMarker}`.quiet().catch(() => undefined)).pipe(Effect.asVoid),
      config: {
        mcp: {
          disposed: {
            type: "local",
            command: [process.execPath, stdioFixture, "--marker"],
            environment: { MCP_LIFECYCLE_PID_FILE: disposeMarker },
            enabled: true,
          },
        },
      },
    },
  )

  it.instance(
    "an explicit disable after reload terminalizes the preserved pending action without re-proposing it",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const mcp = yield* MCP.Service
        expect((yield* mcp.status()).reload_disabled?.status).toBe("needs_approval")
        const originalRequest = yield* pendingControlRequired()

        // Reload preserves the same human decision. A later explicit user
        // disable is stronger: it cancels that durable intent and no stale
        // approval can create the process.
        yield* reloadInstance({ directory: test.directory })
        yield* mcp.add("reload_disabled", {
          type: "local",
          command: [process.execPath, stdioFixture, "--marker"],
          environment: { MCP_LIFECYCLE_PID_FILE: reloadDisableMarker },
          enabled: false,
        })
        yield* waitForStatus(mcp, "reload_disabled", "disabled")
        expect(yield* namedActions("mcp.connect:reload_disabled")).toHaveLength(1)
        expect(isTerminalActionStatus((yield* namedActions("mcp.connect:reload_disabled"))[0]?.action.status)).toBe(
          true,
        )
        expect(Exit.isSuccess(yield* replyWithExit(originalRequest!.id))).toBe(false)
        expect(yield* markerExists(reloadDisableMarker)).toBeUndefined()

        // Persist the explicit disable, then prove recovery does not recreate
        // a replacement runner or a second approval action.
        yield* Effect.promise(() =>
          Bun.write(
            path.join(test.directory, "arforge.json"),
            JSON.stringify({
              $schema: "urn:arforge:config",
              mcp: {
                reload_disabled: {
                  type: "local",
                  command: [process.execPath, stdioFixture, "--marker"],
                  environment: { MCP_LIFECYCLE_PID_FILE: reloadDisableMarker },
                  enabled: false,
                },
              },
            }),
          ),
        )
        yield* reloadInstance({ directory: test.directory })
        expect((yield* mcp.status()).reload_disabled?.status).toBe("disabled")
        expect(yield* namedActions("mcp.connect:reload_disabled")).toHaveLength(1)
        expect(yield* controlPendingList()).toHaveLength(0)
      }),
    {
      init: () =>
        Effect.promise(() => Bun.$`rm -f ${reloadDisableMarker}`.quiet().catch(() => undefined)).pipe(Effect.asVoid),
      config: {
        mcp: {
          reload_disabled: {
            type: "local",
            command: [process.execPath, stdioFixture, "--marker"],
            environment: { MCP_LIFECYCLE_PID_FILE: reloadDisableMarker },
            enabled: true,
          },
        },
      },
    },
  )

  it.instance(
    "disposing after a successful connect terminates the real server process and re-asks on rebuild",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const mcp = yield* MCP.Service
        expect((yield* mcp.status()).killed?.status).toBe("needs_approval")
        yield* replyPending("once")
        yield* waitForStatus(mcp, "killed", "connected")
        const pid = yield* markerExists(disposeConnectedMarker)
        expect(pid).toBeDefined()
        expect(yield* isProcessAlive(pid!)).toBe(true)

        yield* reloadInstance({ directory: test.directory })
        // The real child process is terminated by the disposal.
        yield* pollWithTimeout(
          Effect.map(isProcessAlive(pid!), (alive) => (alive ? undefined : (false as const))),
          "server process survives disposal",
        )
        yield* waitForStatus(mcp, "killed", "needs_approval")
        expect(Object.keys(yield* mcp.tools())).toEqual([])
        void test
      }),
    {
      init: (directory) =>
        Effect.promise(() => Bun.$`rm -f ${disposeConnectedMarker}`.quiet().catch(() => undefined)).pipe(Effect.asVoid),
      config: {
        mcp: {
          killed: {
            type: "local",
            command: [process.execPath, stdioFixture, "--marker"],
            environment: { MCP_LIFECYCLE_PID_FILE: disposeConnectedMarker },
            enabled: true,
          },
        },
      },
    },
  )

  it.instance("a fast-failing connect leaves no stale connecting entry or process", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const mcp = yield* MCP.Service
      const missing = path.join(os.tmpdir(), "arforge-missing-mcp-binary")
      yield* mcp.add("missing", { ...local(test.directory), command: [missing, "--marker"] })
      expect((yield* mcp.status()).missing?.status).toBe("failed")
      expect(yield* controlPendingList()).toHaveLength(0)
      expect(yield* markerExists(pidFile(test.directory))).toBeUndefined()

      // No stale connecting entry: re-configuring with a valid command asks
      // afresh and connects normally.
      yield* mcp.add("missing", local(test.directory))
      expect((yield* mcp.status()).missing?.status).toBe("needs_approval")
      yield* pollWithTimeout(
        Effect.map(controlPendingList(), (list) => (list.length === 1 ? list : undefined)),
        "replacement approval never became pending",
      )
      yield* replyPending("once")
      yield* waitForStatus(mcp, "missing", "connected")
      expect(yield* markerExists(pidFile(test.directory))).toBeDefined()
    }),
  )

  it.instance(
    "repeated disconnect and rebuild are idempotent",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const mcp = yield* MCP.Service
        expect((yield* mcp.status()).idempotent?.status).toBe("needs_approval")
        yield* mcp.disconnect("idempotent")
        expect((yield* mcp.status()).idempotent?.status).toBe("disabled")
        yield* mcp.disconnect("idempotent")
        expect((yield* mcp.status()).idempotent?.status).toBe("disabled")
        expect(yield* markerExists(idempotentMarker)).toBeUndefined()

        yield* reloadInstance({ directory: test.directory })
        yield* waitForStatus(mcp, "idempotent", "needs_approval")
        yield* mcp.disconnect("idempotent")
        expect((yield* mcp.status()).idempotent?.status).toBe("disabled")
        yield* mcp.disconnect("idempotent")
        expect((yield* mcp.status()).idempotent?.status).toBe("disabled")
        expect(yield* markerExists(idempotentMarker)).toBeUndefined()
        void test
      }),
    {
      init: (directory) =>
        Effect.promise(() => Bun.$`rm -f ${idempotentMarker}`.quiet().catch(() => undefined)).pipe(Effect.asVoid),
      config: {
        mcp: {
          idempotent: {
            type: "local",
            command: [process.execPath, stdioFixture, "--marker"],
            environment: { MCP_LIFECYCLE_PID_FILE: idempotentMarker },
            enabled: true,
          },
        },
      },
    },
  )
})
