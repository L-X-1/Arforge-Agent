import { PermissionV1 } from "@arforge-ai/core/v1/permission"
import { afterEach, describe, expect } from "bun:test"
import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { SessionV1 } from "@arforge-ai/core/v1/session"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { Cause, Config, Deferred, Effect, Exit, Fiber, Layer, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse, HttpRouter, HttpServer } from "effect/unstable/http"
import { layerWebSocketConstructorGlobal } from "effect/unstable/socket/Socket"
import { AppNodeBuilder } from "@arforge-ai/core/effect/app-node-builder"
import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@arforge-ai/core/cross-spawn-spawner"
import { Flag } from "@arforge-ai/core/flag/flag"
import { Ripgrep } from "@arforge-ai/core/ripgrep"
import { registerAdapter } from "../../src/control-plane/adapters"
import type { WorkspaceAdapter } from "../../src/control-plane/types"
import { Workspace } from "../../src/control-plane/workspace"

import { InstanceBootstrap as InstanceBootstrapService } from "../../src/project/bootstrap-service"
import { InstanceStore } from "../../src/project/instance-store"
import { Project } from "../../src/project/project"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import * as HttpSessionError from "../../src/server/routes/instance/httpapi/handlers/session-errors"
import { ExperimentalPaths } from "../../src/server/routes/instance/httpapi/groups/experimental"
import { SessionPaths } from "../../src/server/routes/instance/httpapi/groups/session"
import { Session } from "@/session/session"
import { MessageID, PartID, SessionID, type SessionID as SessionIDType } from "../../src/session/schema"
import { Database } from "@arforge-ai/core/database/database"
import { EventTable } from "@arforge-ai/core/event/sql"
import { SessionInputTable, SessionMessageTable, SessionTable } from "@arforge-ai/core/session/sql"
import { SessionMessage } from "@arforge-ai/core/session/message"
import { SessionExecution } from "@arforge-ai/core/session/execution"
import { SessionV2 } from "@arforge-ai/core/session"
import { Snapshot } from "@arforge-ai/core/snapshot"
import { Location } from "@arforge-ai/core/location"
import { AbsolutePath } from "@arforge-ai/core/schema"
import { LocationServiceMap } from "@arforge-ai/core/location-service-map"
import { ModelV2 } from "@arforge-ai/core/model"
import { ProviderV2 } from "@arforge-ai/core/provider"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { SessionExecutionFormal } from "../../src/session/execution-formal"
import * as RuntimeInvariants from "@arforge-ai/core/runtime/invariants"
import * as SessionRunnerEvidence from "@arforge-ai/core/session/runner/evidence"
import * as SessionRunnerHistory from "@arforge-ai/core/session/runner/history"
import * as DateTime from "effect/DateTime"
import { eq } from "drizzle-orm"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, provideInstanceEffect, TestInstance, tmpdirScoped } from "../fixture/fixture"
import { TestLLMServer } from "../lib/llm-server"
import { testProviderConfig } from "../lib/test-provider"
import { pollWithTimeout, testEffect } from "../lib/effect"

const originalWorkspaces = Flag.ARFORGE_EXPERIMENTAL_WORKSPACES
const noopBootstrapLayer = Layer.succeed(
  InstanceBootstrapService.Service,
  InstanceBootstrapService.Service.of({ run: Effect.void }),
)
const appLayer = AppNodeBuilder.build(
  LayerNode.group([
    InstanceStore.node,
    Project.node,
    Session.node,
    Workspace.node,
    Database.node,
    Ripgrep.node,
    SessionExecution.node,
    SessionV2.node,
    RuntimeInvariants.node,
    LocationServiceMap.node,
  ]),
  [
    [InstanceStore.bootstrapNode, noopBootstrapLayer],
    [SessionExecution.node, SessionExecutionFormal.node],
    [LocationServiceMap.node, HttpApiApp.locationServiceMapV2Node],
  ],
)
const servedRoutes: Layer.Layer<never, Config.ConfigError, HttpServer.HttpServer> = HttpRouter.serve(
  HttpApiApp.routes,
  {
    disableListenLog: true,
    disableLogger: true,
  },
)
const httpApiLayer = servedRoutes.pipe(
  Layer.provide(layerWebSocketConstructorGlobal),
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provideMerge(NodeServices.layer),
)
const it = testEffect(Layer.mergeAll(appLayer, httpApiLayer))

function pathFor(path: string, params: Record<string, string>) {
  return Object.entries(params).reduce((result, [key, value]) => result.replace(`:${key}`, value), path)
}

function createSession(input?: Session.CreateInput) {
  return Session.use.create(input)
}

const sessionEventIDs = (sessionID: string) =>
  Database.Service.use(({ db }) =>
    db
      .select({ id: EventTable.id })
      .from(EventTable)
      .where(eq(EventTable.aggregate_id, sessionID))
      .all()
      .pipe(
        Effect.orDie,
        Effect.map((rows) => rows.map((row) => row.id)),
      ),
  )

function createTextMessage(sessionID: SessionIDType, text: string) {
  return Effect.gen(function* () {
    const svc = yield* Session.Service
    const info = yield* svc.updateMessage({
      id: MessageID.ascending(),
      role: "user",
      sessionID,
      agent: "build",
      model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") },
      time: { created: Date.now() },
    })
    const part = yield* svc.updatePart({
      id: PartID.ascending(),
      sessionID,
      messageID: info.id,
      type: "text",
      text,
    })
    return { info, part }
  })
}

const localAdapter = (directory: string): WorkspaceAdapter => ({
  name: "Local Test",
  description: "Create a local test workspace",
  configure: (info) => ({ ...info, name: "local-test", directory }),
  create: async () => {
    await mkdir(directory, { recursive: true })
  },
  async remove() {},
  target: () => ({ type: "local" as const, directory }),
})

const createLocalWorkspace = (input: { projectID: Project.Info["id"]; type: string; directory: string }) =>
  Effect.acquireRelease(
    Effect.gen(function* () {
      registerAdapter(input.projectID, input.type, localAdapter(input.directory))
      return yield* Workspace.Service.use((svc) =>
        svc.create({
          type: input.type,
          branch: null,
          extra: null,
          projectID: input.projectID,
        }),
      )
    }),
    (info) => Workspace.use.remove(info.id).pipe(Effect.ignore),
  )

const insertLegacyAssistantMessage = (sessionID: SessionIDType, seq = 1, time = seq) =>
  Effect.gen(function* () {
    const message = SessionMessage.Assistant.make({
      id: SessionMessage.ID.create(),
      type: "assistant",
      agent: "build",
      model: {
        id: ModelV2.ID.make("model"),
        providerID: ProviderV2.ID.make("provider"),
        variant: ModelV2.VariantID.make("default"),
      },
      time: { created: DateTime.makeUnsafe(time) },
      content: [],
    })
    const { db } = yield* Database.Service
    yield* db
      .insert(SessionMessageTable)
      .values([
        {
          id: message.id,
          session_id: sessionID,
          type: message.type,
          seq,
          time_created: time,
          data: {
            time: { created: time },
            agent: message.agent,
            model: message.model,
            content: message.content,
          } as NonNullable<(typeof SessionMessageTable.$inferInsert)["data"]>,
        },
      ])
      .run()
      .pipe(Effect.orDie)
    return message
  })

const insertCorruptV2Message = (sessionID: SessionIDType, time = 1) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(SessionMessageTable)
      .values([
        {
          id: SessionMessage.ID.create(),
          session_id: sessionID,
          type: "assistant",
          seq: time,
          time_created: time,
          data: {} as NonNullable<(typeof SessionMessageTable.$inferInsert)["data"]>,
        },
      ])
      .run()
      .pipe(Effect.orDie)
  })

const setLegacySummaryDiff = (sessionID: SessionIDType) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .update(SessionTable)
      .set({
        summary_additions: 1,
        summary_deletions: 0,
        summary_files: 1,
        summary_diffs: [{ additions: 1, deletions: 0 }],
      })
      .where(eq(SessionTable.id, sessionID))
      .run()
      .pipe(Effect.orDie)
  })

const getWorkspaceID = (sessionID: SessionIDType) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    return yield* db
      .select({ workspaceID: SessionTable.workspace_id })
      .from(SessionTable)
      .where(eq(SessionTable.id, sessionID))
      .get()
      .pipe(Effect.orDie)
  })

const clearSessionPath = (sessionID: SessionIDType) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db.update(SessionTable).set({ path: null }).where(eq(SessionTable.id, sessionID)).run().pipe(Effect.orDie)
  })

function request(path: string, init?: RequestInit) {
  const url = new URL(path, "http://localhost")
  return HttpClientRequest.fromWeb(new Request(url, init)).pipe(
    HttpClientRequest.setUrl(url.pathname),
    HttpClient.execute,
  )
}

function json<T>(response: HttpClientResponse.HttpClientResponse) {
  if (response.status !== 200) return response.text.pipe(Effect.flatMap((text) => Effect.die(new Error(text))))
  return response.json.pipe(Effect.map((value) => value as T))
}

function responseJson(response: HttpClientResponse.HttpClientResponse) {
  return response.json
}

function requestJson<T>(path: string, init?: RequestInit) {
  return request(path, init).pipe(Effect.flatMap(json<T>))
}

afterEach(async () => {
  Flag.ARFORGE_EXPERIMENTAL_WORKSPACES = originalWorkspaces
  // End-to-end handlers can fork instance-scoped execution/summary work. Close
  // those scopes before resetting the process-wide SQLite file so no late
  // fiber observes a partially torn-down Database service.
  await disposeAllInstances()
  await resetDatabase()
})

// These end-to-end cases intentionally share the process-wide SQLite file and
// app runtime. Serialise the group so one test's afterEach teardown cannot
// delete the database while another test is still serving a request.
describe.serial("session HttpApi", () => {
  testEffect(Layer.empty).effect("builds the HTTP location map with its declared database dependency", () =>
    Effect.gen(function* () {
      const locations = yield* LocationServiceMap.Service
      expect(typeof locations.get).toBe("function")
    }).pipe(
      Effect.provide(
        AppNodeBuilder.build(LocationServiceMap.node, [[LocationServiceMap.node, HttpApiApp.locationServiceMapV2Node]]),
      ),
    ),
  )

  testEffect(Layer.empty).effect("maps busy sessions to public session busy errors", () =>
    Effect.gen(function* () {
      const sessionID = SessionID.descending()
      const exit = yield* HttpSessionError.mapBusy(Effect.fail(new Session.BusyError({ sessionID }))).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Cause.squash(exit.cause)).toMatchObject({
          _tag: "SessionBusyError",
          sessionID,
          message: `Session is busy: ${sessionID}`,
        })
      }
    }),
  )

  it.instance(
    "returns declared not found errors for read routes",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-arforge-directory": test.directory }
        const missingSession = SessionID.descending()
        const missingSessionBody = {
          name: "NotFoundError",
          data: { message: `Session not found: ${missingSession}` },
        }

        const missingDiff = yield* request(pathFor(SessionPaths.diff, { sessionID: missingSession }), { headers })
        expect(missingDiff.status).toBe(404)
        expect(yield* responseJson(missingDiff)).toEqual(missingSessionBody)

        const get = yield* request(pathFor(SessionPaths.get, { sessionID: missingSession }), { headers })
        expect(get.status).toBe(404)
        expect(yield* responseJson(get)).toEqual(missingSessionBody)

        const children = yield* request(pathFor(SessionPaths.children, { sessionID: missingSession }), { headers })
        expect(children.status).toBe(404)
        expect(yield* responseJson(children)).toEqual(missingSessionBody)

        const todo = yield* request(pathFor(SessionPaths.todo, { sessionID: missingSession }), { headers })
        expect(todo.status).toBe(404)
        expect(yield* responseJson(todo)).toEqual(missingSessionBody)

        const messages = yield* request(pathFor(SessionPaths.messages, { sessionID: missingSession }), { headers })
        expect(messages.status).toBe(404)
        expect(yield* responseJson(messages)).toEqual(missingSessionBody)

        const remove = yield* request(pathFor(SessionPaths.remove, { sessionID: missingSession }), {
          headers,
          method: "DELETE",
        })
        expect(remove.status).toBe(404)
        expect(yield* responseJson(remove)).toEqual(missingSessionBody)

        const prompt = yield* request(pathFor(SessionPaths.prompt, { sessionID: missingSession }), {
          headers: { ...headers, "content-type": "application/json" },
          method: "POST",
          body: JSON.stringify({ agent: "build", noReply: true, parts: [{ type: "text", text: "hello" }] }),
        })
        expect(prompt.status).toBe(404)
        expect(yield* responseJson(prompt)).toEqual(missingSessionBody)

        const abort = yield* request(pathFor(SessionPaths.abort, { sessionID: missingSession }), {
          headers,
          method: "POST",
        })
        expect(abort.status).toBe(200)
        expect(yield* responseJson(abort)).toBe(true)

        const session = yield* createSession({ title: "missing message" })
        const missingMessage = MessageID.ascending()
        const message = yield* request(
          pathFor(SessionPaths.message, { sessionID: session.id, messageID: missingMessage }),
          { headers },
        )
        expect(message.status).toBe(404)
        expect(yield* responseJson(message)).toEqual({
          name: "NotFoundError",
          data: { message: `Message not found: ${missingMessage}` },
        })
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "serves canonical snapshot patches through the diff route without legacy summaries",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-arforge-directory": test.directory }
        const session = yield* createSession({ title: "Core snapshot HTTP" })
        const locations = yield* LocationServiceMap.Service
        const location = locations.get(Location.Ref.make({ directory: AbsolutePath.make(test.directory) }))
        const snapshots = yield* Snapshot.Service.pipe(Effect.provide(location))
        const start = yield* snapshots.capture()
        yield* Effect.promise(() => writeFile(path.join(test.directory, "http-diff.txt"), "http-patch-content\n"))
        const end = yield* snapshots.capture()
        expect(start).toBeDefined()
        expect(end).toBeDefined()
        // Deliberately seed persisted Core history to test the HTTP reader independently
        // of execution. The actual tool-to-snapshot flow is covered by prompt.test.ts.
        const assistant = yield* insertLegacyAssistantMessage(session.id)
        const encoded = Schema.encodeSync(SessionMessage.Assistant)({ ...assistant, snapshot: { start, end } })
        const { db } = yield* Database.Service
        yield* db
          .update(SessionMessageTable)
          .set({
            data: encoded,
          })
          .where(eq(SessionMessageTable.id, assistant.id))
          .run()
          .pipe(Effect.orDie)
        const url = pathFor(SessionPaths.diff, { sessionID: session.id })
        const diffs = yield* requestJson<Array<{ file: string; patch: string; additions: number }>>(url, { headers })
        expect(diffs).toHaveLength(1)
        expect(diffs[0]?.file).toBe("http-diff.txt")
        expect(diffs[0]?.patch).toContain("http-patch-content")
        expect(diffs[0]?.additions).toBe(1)
        const before = yield* sessionEventIDs(session.id)
        expect(yield* requestJson(url, { headers })).toEqual(diffs)
        expect(yield* sessionEventIDs(session.id)).toEqual(before)
      }),
    { git: true, config: { formatter: false, lsp: false } },
    20000,
  )

  it.instance(
    "rejects message deletion while the canonical execution slot is occupied",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-arforge-directory": test.directory }
        const session = yield* createSession({ title: "Canonical mutation busy" })
        const message = yield* createTextMessage(session.id, "Keep this message while busy")
        const execution = yield* SessionExecution.Service
        const ready = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const work = yield* execution
          .exclusive(
            SessionV2.ID.make(session.id),
            Deferred.succeed(ready, undefined).pipe(Effect.andThen(Deferred.await(release))),
          )
          .pipe(Effect.forkChild)
        yield* Deferred.await(ready).pipe(Effect.timeout("5 seconds"))
        const before = yield* sessionEventIDs(session.id)
        const url = pathFor(SessionPaths.deleteMessage, { sessionID: session.id, messageID: message.info.id })
        const denied = yield* request(url, { headers, method: "DELETE" })
        expect(denied.status).toBe(409)
        expect(yield* responseJson(denied)).toMatchObject({ _tag: "SessionBusyError", sessionID: session.id })
        expect(yield* sessionEventIDs(session.id)).toEqual(before)
        yield* Deferred.succeed(release, undefined)
        expect(yield* Fiber.join(work)).toBe(true)
        expect((yield* request(url, { headers, method: "DELETE" })).status).toBe(200)
      }),
    { git: true, config: { formatter: false, lsp: false } },
    20000,
  )

  it.instance(
    "serves read routes",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-arforge-directory": test.directory }
        const parent = yield* createSession({ title: "parent" })
        const child = yield* createSession({ title: "child", parentID: parent.id })
        const message = yield* createTextMessage(parent.id, "hello")
        yield* createTextMessage(parent.id, "world")

        const listed = yield* requestJson<Session.Info[]>(`${SessionPaths.list}?roots=true`, { headers })
        expect(listed.map((item) => item.id)).toContain(parent.id)
        expect(Object.hasOwn(listed[0]!, "parentID")).toBe(false)

        expect(yield* requestJson<Record<string, unknown>>(SessionPaths.status, { headers })).toEqual({})

        expect(
          yield* requestJson<Session.Info>(pathFor(SessionPaths.get, { sessionID: parent.id }), { headers }),
        ).toMatchObject({ id: parent.id, title: "parent" })

        expect(
          (yield* requestJson<Session.Info[]>(pathFor(SessionPaths.children, { sessionID: parent.id }), {
            headers,
          })).map((item) => item.id),
        ).toEqual([child.id])

        expect(
          yield* requestJson<unknown[]>(pathFor(SessionPaths.todo, { sessionID: parent.id }), { headers }),
        ).toEqual([])

        expect(
          yield* requestJson<unknown[]>(pathFor(SessionPaths.diff, { sessionID: parent.id }), { headers }),
        ).toEqual([])

        const messages = yield* request(`${pathFor(SessionPaths.messages, { sessionID: parent.id })}?limit=1`, {
          headers,
        })
        const messagePage = yield* json<SessionV1.WithParts[]>(messages)
        const nextCursor = messages.headers["x-next-cursor"]
        expect(nextCursor).toBeTruthy()
        expect(messagePage[0]?.parts[0]).toMatchObject({ type: "text" })

        expect(
          (yield* request(`${pathFor(SessionPaths.messages, { sessionID: parent.id })}?before=${nextCursor}`, {
            headers,
          })).status,
        ).toBe(400)
        expect(
          (yield* request(`${pathFor(SessionPaths.messages, { sessionID: parent.id })}?limit=1&before=invalid`, {
            headers,
          })).status,
        ).toBe(400)

        expect(
          yield* requestJson<SessionV1.WithParts>(
            pathFor(SessionPaths.message, { sessionID: parent.id, messageID: message.info.id }),
            { headers },
          ),
        ).toMatchObject({ info: { id: message.info.id } })

        yield* insertLegacyAssistantMessage(parent.id)

        expect(
          (yield* requestJson<{ data: SessionMessage.Message[] }>(`/api/session/${parent.id}/message`, {
            headers,
          })).data,
        ).toMatchObject([{ type: "assistant" }])
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.live(
    "uses the persisted session directory and settles durable execution after verification",
    () =>
      Effect.gen(function* () {
        const llm = yield* TestLLMServer
        yield* llm.text("ok", { usage: { input: 1, output: 1 } })

        const config = testProviderConfig(llm.url)
        const sessionDirectory = yield* tmpdirScoped({ git: true, config })
        const requestDirectory = yield* tmpdirScoped({ git: true, config })
        const session = yield* createSession({ title: "directory regression" }).pipe(
          provideInstanceEffect(sessionDirectory),
        )

        const response = yield* request(
          `${pathFor(SessionPaths.prompt, { sessionID: session.id })}?directory=${encodeURIComponent(requestDirectory)}`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              agent: "build",
              model: { providerID: "test", modelID: "test-model" },
              parts: [{ type: "text", text: "which directory?" }],
            }),
          },
        )

        expect(response.status).toBe(200)
        const reply = yield* json<SessionV1.WithParts>(response)
        expect(reply.info.role === "assistant" ? reply.info.path : undefined).toEqual({
          cwd: sessionDirectory,
          root: sessionDirectory,
        })

        const invariants = yield* RuntimeInvariants.Service
        expect(invariants.list("session-runner").map((item) => item.key)).toEqual([
          "execution-input",
          "checkpoint-cursor",
          "mature-checkpoint",
          "request-projection",
          "terminal",
        ])

        const messages = yield* Session.use
          .messages({ sessionID: session.id })
          .pipe(provideInstanceEffect(sessionDirectory), Effect.orDie)
        expect(messages.filter((message) => message.info.role === "assistant")).toHaveLength(0)
        const allEvents = yield* Database.Service.use(({ db }) =>
          db
            .select({
              id: EventTable.id,
              aggregateID: EventTable.aggregate_id,
              seq: EventTable.seq,
              type: EventTable.type,
              data: EventTable.data,
            })
            .from(EventTable)
            .all()
            .pipe(Effect.orDie),
        )
        const runID = allEvents.find(
          (event) => event.type === "agent.run.created.1" && event.data.sessionID === session.id,
        )?.aggregateID
        expect(runID).toBeDefined()
        expect(
          allEvents.filter((event) => event.type === "agent.run.created.1" && event.data.sessionID === session.id),
        ).toHaveLength(1)
        if (!runID) throw new Error("formal durable run was not persisted")
        const typedRunID = AgentRuntime.RunID.make(runID)
        const historyRows = yield* Database.Service.use(({ db }) =>
          SessionRunnerHistory.runnerEventRowSourceFromDatabase(db).collect({
            sessionID: session.id,
            runID: typedRunID,
          }),
        )
        const history = SessionRunnerHistory.fromEventRows(historyRows, { sessionID: session.id, runID: typedRunID })
        expect(history.runCreated?.runID as string | undefined).toBe(runID)
        expect(history.checkpoint).toBeDefined()
        expect(history.formalRequest).toBeDefined()
        expect(history.matureBinding).toBeUndefined()
        const terminalHistory = SessionRunnerHistory.assertTerminalHistory(history, {
          status: "completed",
          attempt: 1,
        })
        expect(terminalHistory).toMatchObject({ status: "completed", attempt: 1, checkpointPresent: true })
        const runEvents = allEvents.filter((event) => event.aggregateID === runID).toSorted((a, b) => a.seq - b.seq)
        const checkpointState = history.checkpoint?.checkpoint.state
        const checkpointForMatch = checkpointState === undefined ? undefined : structuredClone(checkpointState)
        const checkpointCursorForMatch = checkpointState === undefined ? undefined : structuredClone(checkpointState)
        expect(checkpointForMatch).toMatchObject({
          version: 1,
          kind: "session-agent-loop",
          phase: "idle",
          nextStep: 2,
          needsContinuation: false,
          lastTurn: {
            turnStep: 1,
            requestDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
            contextDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
            toolSetRevision: expect.stringMatching(/^[0-9a-f]{64}$/),
            routeConfigRevision: expect.stringMatching(/^[0-9a-f]{64}$/),
            compilerRevision: expect.any(String),
          },
        })
        expect(checkpointCursorForMatch).not.toHaveProperty("admittedThroughSequence")
        const requestData = history.formalRequest
        const requestDataForMatch = requestData === undefined ? undefined : structuredClone(requestData)
        expect(requestDataForMatch).toMatchObject({
          runID,
          turnStep: 1,
          attempt: 1,
          requestDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
          envelope: expect.any(String),
        })
        expect(requestData).toBeDefined()
        if (!requestData) throw new Error("formal request envelope event was not persisted")
        const formalProjection = SessionRunnerEvidence.fromFormalEvent(requestData, typedRunID)
        expect(formalProjection).toMatchObject({
          runID: typedRunID,
          turnStep: 1,
          attempt: 1,
        })
        expect(SessionRunnerEvidence.compareRequestProjection(formalProjection, formalProjection)).toEqual([])
        const initialBudget = history.runCreated?.run.budget
        expect(initialBudget).toBeDefined()
        if (!initialBudget || !checkpointState) throw new Error("formal durable evidence inputs were not persisted")
        const formalEvidence = SessionRunnerHistory.formalEvidenceFromHistory(history)
        expect(formalEvidence.execution.checkpoint).toMatchObject({
          phase: "idle",
          nextStep: 2,
          needsContinuation: false,
        })
        expect(formalEvidence.execution.budget.attemptsUsed).toBe(1)
        const attemptFinished = runEvents.findIndex((event) => event.type === "agent.run.attempt-finished.1")
        const verifying = runEvents.findIndex(
          (event) => event.type === "agent.run.state-changed.1" && event.data.to === "verifying",
        )
        const completed = runEvents.findIndex(
          (event) => event.type === "agent.run.state-changed.1" && event.data.to === "completed",
        )
        const leaseReleased = runEvents.findIndex((event) => event.type === "agent.run.lease-released.1")
        expect(attemptFinished).toBeGreaterThanOrEqual(0)
        expect(verifying).toBeGreaterThan(attemptFinished)
        expect(completed).toBeGreaterThan(verifying)
        expect(leaseReleased).toBeGreaterThan(completed)
      }).pipe(Effect.provide(TestLLMServer.layer), Effect.provide(AppNodeBuilder.build(CrossSpawnSpawner.node))),
    30_000,
  )

  it.instance(
    "returns v2 public request errors for cursor and workspace query failures",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-arforge-directory": test.directory }
        const session = yield* createSession({ title: "v2 cursor" })
        const firstMessage = yield* insertLegacyAssistantMessage(session.id, 1, 2)
        const secondMessage = yield* insertLegacyAssistantMessage(session.id, 2, 1)

        const sessionPage = yield* request(
          `/api/session?${new URLSearchParams({
            limit: "1",
            order: "asc",
            directory: test.directory,
            search: "v2",
          })}`,
          { headers },
        )
        const sessionCursor = (yield* json<{ data: Session.Info[]; cursor: { next?: string } }>(sessionPage)).cursor
          .next
        expect(sessionCursor).toBeTruthy()
        expect(JSON.parse(Buffer.from(sessionCursor!, "base64url").toString("utf8"))).toMatchObject({
          order: "asc",
          directory: test.directory,
          search: "v2",
          anchor: { id: session.id, direction: "next" },
        })

        const sessionNextPage = yield* request(`/api/session?cursor=${sessionCursor}`, { headers })
        expect(sessionNextPage.status).toBe(200)

        const invalidSessionCursor = yield* request(`/api/session?cursor=invalid`, { headers })
        expect(invalidSessionCursor.status).toBe(400)
        expect(yield* responseJson(invalidSessionCursor)).toMatchObject({
          _tag: "InvalidCursorError",
          message: "Invalid cursor",
        })

        const invalidWorkspace = yield* request(`/api/session?workspace=bad`, { headers })
        expect(invalidWorkspace.status).toBe(400)
        expect(yield* responseJson(invalidWorkspace)).toMatchObject({
          _tag: "InvalidRequestError",
          kind: "Query",
        })

        const messagePage = yield* request(`/api/session/${session.id}/message?limit=1`, { headers })
        const messageBody = yield* json<{ data: SessionMessage.Message[]; cursor: { next?: string } }>(messagePage)
        const messageCursor = messageBody.cursor.next
        expect(messageCursor).toBeTruthy()
        expect(messageBody.data.map((message) => message.id)).toEqual([secondMessage.id])
        expect(JSON.parse(Buffer.from(messageCursor!, "base64url").toString("utf8"))).toEqual({
          id: secondMessage.id,
          order: "desc",
          direction: "next",
        })

        const nextMessagePage = yield* request(`/api/session/${session.id}/message?cursor=${messageCursor}`, {
          headers,
        })
        expect(
          (yield* json<{ data: SessionMessage.Message[] }>(nextMessagePage)).data.map((message) => message.id),
        ).toEqual([firstMessage.id])

        const legacyMessageCursor = Buffer.from(
          JSON.stringify({ id: secondMessage.id, time: 1, order: "desc", direction: "next" }),
        ).toString("base64url")
        const legacyMessagePage = yield* request(`/api/session/${session.id}/message?cursor=${legacyMessageCursor}`, {
          headers,
        })
        expect(
          (yield* json<{ data: SessionMessage.Message[] }>(legacyMessagePage)).data.map((message) => message.id),
        ).toEqual([firstMessage.id])

        const messageCursorWithOrder = yield* request(
          `/api/session/${session.id}/message?cursor=${messageCursor}&order=asc`,
          { headers },
        )
        expect(messageCursorWithOrder.status).toBe(400)
        expect(yield* responseJson(messageCursorWithOrder)).toMatchObject({
          _tag: "InvalidCursorError",
          message: "Cursor cannot be combined with order",
        })

        const invalidMessageCursor = yield* request(`/api/session/${session.id}/message?cursor=invalid`, { headers })
        expect(invalidMessageCursor.status).toBe(400)
        expect(yield* responseJson(invalidMessageCursor)).toMatchObject({
          _tag: "InvalidCursorError",
          message: "Invalid cursor",
        })
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "returns v2 public not found errors for missing sessions",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-arforge-directory": test.directory }
        const missing = SessionID.descending()
        const expected = {
          _tag: "SessionNotFoundError",
          sessionID: missing,
          message: `Session not found: ${missing}`,
        }

        const messages = yield* request(`/api/session/${missing}/message`, { headers })
        expect(messages.status).toBe(404)
        expect(yield* responseJson(messages)).toEqual(expected)

        const context = yield* request(`/api/session/${missing}/context`, { headers })
        expect(context.status).toBe(404)
        expect(yield* responseJson(context)).toEqual(expected)

        const compact = yield* request(`/api/session/${missing}/compact`, { method: "POST", headers })
        expect(compact.status).toBe(404)
        expect(yield* responseJson(compact)).toEqual(expected)

        const wait = yield* request(`/api/session/${missing}/wait`, { method: "POST", headers })
        expect(wait.status).toBe(404)
        expect(yield* responseJson(wait)).toEqual(expected)

        const prompt = yield* request(`/api/session/${missing}/prompt`, {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ prompt: { text: "hello" } }),
        })
        expect(prompt.status).toBe(404)
        expect(yield* responseJson(prompt)).toEqual(expected)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "durably records one v2 prompt for exact message-ID retries",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-arforge-directory": test.directory }
        const session = yield* createSession({ title: "v2 prompt recording" })

        const recordPrompt = () =>
          request(`/api/session/${session.id}/prompt`, {
            method: "POST",
            headers: { ...headers, "content-type": "application/json" },
            body: JSON.stringify({ id: "msg_http_prompt", prompt: { text: "hello" }, resume: false }),
          })
        const first = yield* recordPrompt()
        const retried = yield* recordPrompt()
        type PromptBody = { id: string; prompt: { text: string }; delivery: string; promotedSeq?: number }
        const firstBody = yield* json<{ data: PromptBody }>(first)
        const retriedBody = yield* json<{ data: PromptBody }>(retried)
        expect(first.status).toBe(200)
        expect(retried.status).toBe(200)
        expect(retriedBody).toEqual(firstBody)
        expect(firstBody).toMatchObject({
          data: { id: "msg_http_prompt", prompt: { text: "hello" }, delivery: "steer" },
        })

        const messages = yield* requestJson<{ data: PromptBody[] }>(`/api/session/${session.id}/message`, {
          headers,
        })
        expect(messages.data).toHaveLength(0)
        const admitted = yield* Database.Service.use(({ db }) =>
          db
            .select()
            .from(SessionInputTable)
            .where(eq(SessionInputTable.id, SessionMessage.ID.make("msg_http_prompt")))
            .get()
            .pipe(Effect.orDie),
        )
        expect(admitted).toMatchObject({
          id: "msg_http_prompt",
          session_id: session.id,
          delivery: "steer",
          promoted_seq: null,
        })
        const conflict = yield* request(`/api/session/${session.id}/prompt`, {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ id: "msg_http_prompt", prompt: { text: "goodbye" } }),
        })
        expect(conflict.status).toBe(409)
        expect(yield* responseJson(conflict)).toEqual({
          _tag: "ConflictError",
          message: "Prompt message ID conflicts with an existing durable record: msg_http_prompt",
          resource: "msg_http_prompt",
        })

        const wakeID = SessionMessage.ID.make("msg_http_wake")
        const wake = yield* request(`/api/session/${session.id}/prompt`, {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ id: wakeID, prompt: { text: "hello again" } }),
        })
        expect(wake.status).toBe(200)
        const settled = yield* request(`/api/session/${session.id}/wait`, { method: "POST", headers })
        expect(settled.status).toBe(204)
        const message = yield* pollWithTimeout(
          requestJson<{ data: SessionMessage.Message[] }>(`/api/session/${session.id}/message`, { headers }).pipe(
            Effect.map(({ data }) => data.find((message) => message.id === wakeID)),
          ),
          "V2 prompt was not promoted after wake",
          "10 seconds",
        )
        expect(message).toMatchObject({ id: wakeID, type: "user" })
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "supports wait while compact remains unavailable",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-arforge-directory": test.directory }
        const session = yield* createSession({ title: "v2 unavailable" })

        const compact = yield* request(`/api/session/${session.id}/compact`, { method: "POST", headers })
        expect(compact.status).toBe(503)
        expect(yield* responseJson(compact)).toEqual({
          _tag: "ServiceUnavailableError",
          message: "Session compact is not available yet",
          service: "session.compact",
        })

        const wait = yield* request(`/api/session/${session.id}/wait`, { method: "POST", headers })
        expect(wait.status).toBe(204)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "fails closed every v2 revert mutation before touching the worktree",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-arforge-directory": test.directory, "content-type": "application/json" }
        const session = yield* createSession({ title: "v2 controlled restore unavailable" })
        const guardedFile = path.join(test.directory, "v2-revert-guard.txt")
        yield* Effect.promise(() => writeFile(guardedFile, "unchanged"))
        const eventsBefore = yield* sessionEventIDs(session.id)

        const requests = [
          {
            operation: "revert.stage",
            path: `/api/session/${session.id}/revert/stage`,
            body: JSON.stringify({ messageID: MessageID.ascending(), files: true }),
          },
          { operation: "revert.clear", path: `/api/session/${session.id}/revert/clear` },
          { operation: "revert.commit", path: `/api/session/${session.id}/revert/commit` },
        ] as const

        for (const target of requests) {
          const response = yield* request(target.path, {
            method: "POST",
            headers,
            body: "body" in target ? target.body : undefined,
          })
          expect({ status: response.status, body: yield* responseJson(response) }).toEqual({
            status: 503,
            body: {
              _tag: "ServiceUnavailableError",
              message: `Session ${target.operation} is disabled until controlled restore runs through a sealed ControlRun worker`,
              service: `session.${target.operation}`,
            },
          })
        }

        expect(yield* Effect.promise(() => readFile(guardedFile, "utf8"))).toBe("unchanged")
        expect((yield* Session.use.get(session.id)).revert).toBeUndefined()
        expect(yield* sessionEventIDs(session.id)).toEqual(eventsBefore)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "returns safe v2 unknown errors for corrupt projected messages",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const session = yield* createSession({ title: "v2 corrupt message" })
        yield* insertCorruptV2Message(session.id)

        const messages = yield* request(`/api/session/${session.id}/message`, {
          headers: { "x-arforge-directory": test.directory },
        })
        const messagesBody = yield* responseJson(messages)
        expect(messages.status).toBe(500)
        expect(messagesBody).toMatchObject({
          _tag: "UnknownError",
          message: "Unexpected server error. Check server logs for details.",
        })
        expect((messagesBody as { ref?: unknown }).ref).toMatch(/^err_[0-9a-f-]{8}$/)
        expect(JSON.stringify(messagesBody)).not.toContain("assistant")

        const context = yield* request(`/api/session/${session.id}/context`, {
          headers: { "x-arforge-directory": test.directory },
        })
        const contextBody = yield* responseJson(context)
        expect(context.status).toBe(500)
        expect(contextBody).toMatchObject({
          _tag: "UnknownError",
          message: "Unexpected server error. Check server logs for details.",
        })
        expect((contextBody as { ref?: unknown }).ref).toMatch(/^err_[0-9a-f-]{8}$/)
        expect(JSON.stringify(contextBody)).not.toContain("assistant")
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "serves sessions with migrated summary diffs missing file details",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const session = yield* createSession({ title: "legacy diff" })
        yield* setLegacySummaryDiff(session.id)

        const response = yield* request(pathFor(SessionPaths.get, { sessionID: session.id }), {
          headers: { "x-arforge-directory": test.directory },
        })

        expect(response.status).toBe(200)
        expect((yield* json<Session.Info>(response)).summary?.diffs).toEqual([{ additions: 1, deletions: 0 }])
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "serves lifecycle mutation routes",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-arforge-directory": test.directory, "content-type": "application/json" }

        const createdEmpty = yield* requestJson<Session.Info>(SessionPaths.create, {
          method: "POST",
          headers,
        })
        expect(createdEmpty.id).toBeTruthy()

        const created = yield* requestJson<Session.Info>(SessionPaths.create, {
          method: "POST",
          headers,
          body: JSON.stringify({ title: "created" }),
        })
        expect(created.title).toBe("created")

        const updated = yield* requestJson<Session.Info>(pathFor(SessionPaths.update, { sessionID: created.id }), {
          method: "PATCH",
          headers,
          body: JSON.stringify({ title: "updated", time: { archived: 1 } }),
        })
        expect(updated).toMatchObject({ id: created.id, title: "updated", time: { archived: 1 } })

        const forked = yield* requestJson<Session.Info>(pathFor(SessionPaths.fork, { sessionID: created.id }), {
          method: "POST",
          headers,
        })
        expect(forked.id).not.toBe(created.id)

        const forkedWithoutContentType = yield* requestJson<Session.Info>(
          pathFor(SessionPaths.fork, { sessionID: created.id }),
          {
            method: "POST",
            headers: { "x-arforge-directory": test.directory },
          },
        )
        expect(forkedWithoutContentType.id).not.toBe(created.id)

        const invalidFork = yield* request(pathFor(SessionPaths.fork, { sessionID: created.id }), {
          method: "POST",
          headers,
          body: "{",
        })
        expect(invalidFork.status).toBe(400)

        const forkedWhitespace = yield* requestJson<Session.Info>(
          pathFor(SessionPaths.fork, { sessionID: created.id }),
          {
            method: "POST",
            headers,
            body: "  \n",
          },
        )
        expect(forkedWhitespace.id).not.toBe(created.id)

        expect(
          yield* requestJson<boolean>(pathFor(SessionPaths.abort, { sessionID: created.id }), {
            method: "POST",
            headers,
          }),
        ).toBe(true)

        expect(
          yield* requestJson<boolean>(pathFor(SessionPaths.remove, { sessionID: created.id }), {
            method: "DELETE",
            headers,
          }),
        ).toBe(true)
      }),
    { git: true, config: { formatter: false, lsp: false, share: "disabled" } },
  )

  it.instance(
    "persists selected workspace id when creating a session",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        Flag.ARFORGE_EXPERIMENTAL_WORKSPACES = true
        const project = yield* Project.use.fromDirectory(test.directory)
        const workspace = yield* createLocalWorkspace({
          projectID: project.project.id,
          type: "session-create-workspace",
          directory: path.join(test.directory, ".workspace-local"),
        })

        const created = yield* requestJson<Session.Info>(`${SessionPaths.create}?workspace=${workspace.id}`, {
          method: "POST",
          headers: { "x-arforge-directory": test.directory, "content-type": "application/json" },
          body: JSON.stringify({ title: "workspace session" }),
        })
        const messages = yield* request(
          `${pathFor(SessionPaths.messages, { sessionID: created.id })}?workspace=${workspace.id}`,
          {
            headers: { "x-arforge-directory": test.directory },
          },
        )

        expect(created).toMatchObject({ id: created.id, workspaceID: workspace.id })
        expect(messages.status).toBe(200)
        expect(yield* getWorkspaceID(created.id)).toEqual({ workspaceID: workspace.id })
      }),
    { git: true, config: { formatter: false, lsp: false, share: "disabled" } },
  )

  it.instance(
    "validates archived timestamp values",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-arforge-directory": test.directory, "content-type": "application/json" }
        const session = yield* createSession({ title: "archived" })
        const body = JSON.stringify({ time: { archived: -1 } })

        const response = yield* request(pathFor(SessionPaths.update, { sessionID: session.id }), {
          method: "PATCH",
          headers,
          body,
        })
        expect(response.status).toBe(200)
        expect((yield* json<Session.Info>(response)).time.archived).toBe(-1)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "uses project-scoped path and directory precedence",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const currentDir = path.join(test.directory, "packages", "arforge", "src")
        yield* Effect.promise(() => mkdir(currentDir, { recursive: true }))

        const store = yield* InstanceStore.Service
        const { pathSession, pathlessSession } = yield* store.provide(
          { directory: currentDir },
          Effect.gen(function* () {
            return {
              pathSession: yield* createSession(),
              pathlessSession: yield* createSession(),
            }
          }).pipe(Effect.provideService(TestInstance, { directory: currentDir })),
        )
        yield* clearSessionPath(pathlessSession.id)

        const query = new URLSearchParams({
          scope: "project",
          path: "packages/arforge/src",
          directory: currentDir,
        })
        const headers = { "x-arforge-directory": test.directory }
        const sessions = (yield* json<Session.Info[]>(
          yield* request(`${SessionPaths.list}?${query}`, { headers }),
        )).map((item) => item.id)

        expect(sessions).toContain(pathSession.id)
        expect(sessions).not.toContain(pathlessSession.id)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "lists sessions created through an equivalent directory hint",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const hint = test.directory + path.sep
        const headers = { "x-arforge-directory": hint, "content-type": "application/json" }
        const created = yield* requestJson<Session.Info>(SessionPaths.create, {
          method: "POST",
          headers,
          body: JSON.stringify({ title: "hinted" }),
        })

        const query = new URLSearchParams({ directory: hint, roots: "true" })
        const listed = yield* requestJson<Session.Info[]>(`${SessionPaths.list}?${query}`, { headers })
        expect(listed.map((item) => item.id)).toContain(created.id)

        const globalQuery = new URLSearchParams({ directory: hint })
        const global = yield* requestJson<Session.Info[]>(`${ExperimentalPaths.session}?${globalQuery}`, { headers })
        expect(global.map((item) => item.id)).toContain(created.id)
      }),
    { git: true, config: { formatter: false, lsp: false, share: "disabled" } },
  )

  it.instance(
    "lists Windows sessions for equivalent directory spellings",
    () =>
      Effect.gen(function* () {
        if (process.platform !== "win32") return
        const test = yield* TestInstance
        const headers = { "x-arforge-directory": test.directory, "content-type": "application/json" }
        const created = yield* requestJson<Session.Info>(SessionPaths.create, {
          method: "POST",
          headers,
          body: JSON.stringify({ title: "windows spelling" }),
        })

        const forwardSlashes = test.directory.replaceAll("\\", "/")
        const lowercaseDrive = test.directory.replace(/^[A-Z]:/, (drive) => drive.toLowerCase())
        const trailingSeparator = `${test.directory}\\`
        for (const spelling of [forwardSlashes, lowercaseDrive, trailingSeparator]) {
          const query = new URLSearchParams({ directory: spelling, roots: "true" })
          const listed = yield* requestJson<Session.Info[]>(`${SessionPaths.list}?${query}`, { headers })
          expect({ spelling, ids: listed.map((item) => item.id) }).toEqual({ spelling, ids: [created.id] })
        }
      }),
    { git: true, config: { formatter: false, lsp: false, share: "disabled" } },
    { timeout: 15000 },
  )

  it.instance(
    "lists Windows sessions created through the global worktree sentinel",
    () =>
      Effect.gen(function* () {
        if (process.platform !== "win32") return
        const globalWorktreeSentinel = "/"
        const headers = { "x-arforge-directory": globalWorktreeSentinel, "content-type": "application/json" }
        const driveRootSession = yield* requestJson<Session.Info>(SessionPaths.create, {
          method: "POST",
          headers,
          body: JSON.stringify({ title: "created at drive root" }),
        })
        expect(driveRootSession.directory).toMatch(/^[A-Za-z]:\\$/)

        const query = new URLSearchParams({ directory: globalWorktreeSentinel, roots: "true" })
        const listed = yield* requestJson<Session.Info[]>(`${SessionPaths.list}?${query}`, { headers })
        expect(listed.map((item) => item.id)).toContain(driveRootSession.id)
      }),
    { git: true, config: { formatter: false, lsp: false, share: "disabled" } },
    { timeout: 15000 },
  )

  it.instance(
    "serves paginated message link headers",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-arforge-directory": test.directory }
        const session = yield* createSession({ title: "messages" })
        yield* createTextMessage(session.id, "first")
        yield* createTextMessage(session.id, "second")
        const route = `${pathFor(SessionPaths.messages, { sessionID: session.id })}?limit=1`

        const response = yield* request(route, { headers })

        expect(response.headers["x-next-cursor"]).toBeTruthy()
        expect(response.headers["link"]).toContain("limit=1")
        expect(response.headers["access-control-expose-headers"]?.toLowerCase()).toContain("x-next-cursor")
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "serves message mutation routes",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-arforge-directory": test.directory, "content-type": "application/json" }
        const session = yield* createSession({ title: "messages" })
        const first = yield* createTextMessage(session.id, "first")
        const second = yield* createTextMessage(session.id, "second")

        const updated = yield* requestJson<SessionV1.Part>(
          pathFor(SessionPaths.updatePart, {
            sessionID: session.id,
            messageID: first.info.id,
            partID: first.part.id,
          }),
          {
            method: "PATCH",
            headers,
            body: JSON.stringify({ ...first.part, text: "updated" }),
          },
        )
        expect(updated).toMatchObject({ id: first.part.id, type: "text", text: "updated" })

        expect(
          yield* requestJson<boolean>(
            pathFor(SessionPaths.deletePart, {
              sessionID: session.id,
              messageID: first.info.id,
              partID: first.part.id,
            }),
            { method: "DELETE", headers },
          ),
        ).toBe(true)

        expect(
          yield* requestJson<boolean>(
            pathFor(SessionPaths.deleteMessage, { sessionID: session.id, messageID: second.info.id }),
            { method: "DELETE", headers },
          ),
        ).toBe(true)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "rejects part updates whose path and body ids disagree",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-arforge-directory": test.directory, "content-type": "application/json" }
        const session = yield* createSession({ title: "part mismatch" })
        const message = yield* createTextMessage(session.id, "first")
        const response = yield* request(
          pathFor(SessionPaths.updatePart, {
            sessionID: session.id,
            messageID: message.info.id,
            partID: message.part.id,
          }),
          {
            method: "PATCH",
            headers,
            body: JSON.stringify({ ...message.part, id: PartID.ascending() }),
          },
        )

        expect(response.status).toBe(400)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "fails closed legacy share and restore mutations without changing session or files",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-arforge-directory": test.directory, "content-type": "application/json" }
        const session = yield* createSession({ title: "remaining" })
        const guardedFile = path.join(test.directory, "legacy-guard.txt")
        yield* Effect.promise(() => writeFile(guardedFile, "unchanged"))
        const eventsBefore = yield* sessionEventIDs(session.id)

        const revert = yield* request(pathFor(SessionPaths.revert, { sessionID: session.id }), {
          method: "POST",
          headers,
          body: JSON.stringify({ messageID: MessageID.ascending() }),
        })
        expect({ status: revert.status, body: yield* responseJson(revert) }).toEqual({
          status: 503,
          body: {
            _tag: "ServiceUnavailableError",
            message:
              "Legacy session revert is disabled until controlled restore runs through a sealed ControlRun worker",
            service: "session.revert",
          },
        })

        const unrevert = yield* request(pathFor(SessionPaths.unrevert, { sessionID: session.id }), {
          method: "POST",
          headers,
        })
        expect({ status: unrevert.status, body: yield* responseJson(unrevert) }).toEqual({
          status: 503,
          body: {
            _tag: "ServiceUnavailableError",
            message:
              "Legacy session unrevert is disabled until controlled restore runs through a sealed ControlRun worker",
            service: "session.unrevert",
          },
        })

        const share = yield* request(pathFor(SessionPaths.share, { sessionID: session.id }), {
          method: "POST",
          headers,
        })
        expect({ status: share.status, body: yield* responseJson(share) }).toEqual({
          status: 503,
          body: {
            _tag: "ServiceUnavailableError",
            message:
              "Legacy session share is disabled until controlled publishing runs through a sealed ControlRun worker",
            service: "session.share",
          },
        })

        const unshare = yield* request(pathFor(SessionPaths.share, { sessionID: session.id }), {
          method: "DELETE",
          headers,
        })
        expect({ status: unshare.status, body: yield* responseJson(unshare) }).toEqual({
          status: 503,
          body: {
            _tag: "ServiceUnavailableError",
            message:
              "Legacy session unshare is disabled until controlled publishing runs through a sealed ControlRun worker",
            service: "session.unshare",
          },
        })

        expect(yield* Effect.promise(() => readFile(guardedFile, "utf8"))).toBe("unchanged")
        expect(yield* Session.use.get(session.id)).toMatchObject({
          id: session.id,
          share: undefined,
          revert: undefined,
        })
        expect(yield* sessionEventIDs(session.id)).toEqual(eventsBefore)

        const permissionID = String(PermissionV1.ID.ascending())
        const permission = yield* request(
          pathFor(SessionPaths.permissions, {
            sessionID: session.id,
            permissionID,
          }),
          {
            method: "POST",
            headers,
            body: JSON.stringify({ response: "once" }),
          },
        )
        expect(permission.status).toBe(404)
        expect(yield* responseJson(permission)).toEqual({
          _tag: "PermissionNotFoundError",
          requestID: permissionID,
          message: `Permission request not found: ${permissionID}`,
        })
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )
})
