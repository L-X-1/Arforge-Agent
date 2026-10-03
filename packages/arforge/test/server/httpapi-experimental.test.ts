import { afterEach, describe, expect } from "bun:test"
import * as fs from "fs/promises"
import path from "path"
import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { Deferred, Effect, Fiber, Layer } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { eq } from "drizzle-orm"
import { GlobalBus, type GlobalEvent } from "@/bus/global"
import { ExperimentalPaths } from "../../src/server/routes/instance/httpapi/groups/experimental"
import { Session } from "@/session/session"
import { SessionTable } from "@arforge-ai/core/session/sql"
import { Database } from "@arforge-ai/core/database/database"
import { AccountV2 } from "@arforge-ai/core/account"
import { AccountTable } from "@arforge-ai/core/account/sql"
import { Worktree } from "../../src/worktree"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, TestInstance, tmpdirScoped } from "../fixture/fixture"
import { InstanceStore } from "@/project/instance-store"
import { InstanceBootstrap } from "@/project/bootstrap"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

const it = testEffect(
  Layer.mergeAll(
    LayerNode.compile(LayerNode.group([Session.node, Database.node, InstanceStore.node, Worktree.node]), [
      [InstanceStore.bootstrapNode, InstanceBootstrap.node],
    ]),
    httpApiLayer,
  ),
)
const testWorktreeMutations = it.instance

function request(path: string, directory: string, init: RequestInit = {}) {
  return requestInDirectory(path, directory, init)
}

function createSession(input?: Session.CreateInput) {
  return Session.use.create(input)
}

function json<T>(response: HttpClientResponse.HttpClientResponse) {
  return response.json.pipe(Effect.map((value) => value as T))
}

type ControlOperationKind = "worktree.create" | "worktree.remove" | "worktree.reset"
type ControlOperationStatus = {
  runID: string
  actionID: string
  requestID: string
  operation: ControlOperationKind
  phase: string
  recovery: string
  canApprove: boolean
  result?:
    | { kind: "worktree.create"; name: string; directory: string; branch: string }
    | { kind: "worktree.remove"; completed: true }
    | { kind: "worktree.reset"; completed: true }
}

function controlOperationFor(pathname: string, init: RequestInit): ControlOperationKind {
  if (pathname === ExperimentalPaths.worktreeReset) return "worktree.reset"
  return init.method === "DELETE" ? "worktree.remove" : "worktree.create"
}

function readControlOperationStatus(directory: string, requestID: string, operation: ControlOperationKind) {
  return request(
    `${ExperimentalPaths.controlOperationStatus.replace(":requestID", encodeURIComponent(requestID))}?operation=${operation}`,
    directory,
  ).pipe(Effect.flatMap(json<ControlOperationStatus>))
}

/**
 * Drive the same public list/reply contract used by the desktop control-plane
 * UI. The mutation returns an accepted status immediately; this helper then
 * performs the explicit approval and polls the read-only status contract.
 */
function requestWithControlApproval(
  path: string,
  directory: string,
  requestID: string,
  init: RequestInit,
  reply: "once" | "reject" = "once",
) {
  return Effect.gen(function* () {
    const operation = controlOperationFor(path, init)
    const response = yield* request(path, directory, init)
    expect(response.status).toBe(200)
    const accepted = yield* json<ControlOperationStatus>(response)
    expect(accepted).toMatchObject({ requestID, operation })
    const approval = yield* pollWithTimeout(
      request(`${ExperimentalPaths.controlApproval}?${new URLSearchParams({ requestID })}`, directory).pipe(
        Effect.flatMap(json<Array<{ id: string; subject: { requestID: string } }>>),
        Effect.map((items) => items.find((item) => item.subject.requestID === requestID)),
      ),
      `control-plane approval was not published for ${requestID}`,
    )
    const replied = yield* request(
      ExperimentalPaths.controlApprovalReply.replace(":requestID", encodeURIComponent(approval.id)),
      directory,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reply }),
      },
    )
    expect(replied.status).toBe(200)
    expect(yield* json(replied)).toBe(true)
    return yield* pollWithTimeout(
      readControlOperationStatus(directory, requestID, operation).pipe(
        Effect.flatMap((status) => {
          if (reply === "once") {
            if (["failed", "cancelled", "paused"].includes(status.phase))
              return Effect.fail(new Error(`${operation} stopped in ${status.phase}`))
            return Effect.succeed(status.phase === "completed" ? status : undefined)
          }
          if (status.phase === "completed") return Effect.fail(new Error(`${operation} executed after rejection`))
          return Effect.succeed(["failed", "cancelled"].includes(status.phase) ? status : undefined)
        }),
      ),
      `${operation} did not reach its expected terminal phase`,
      "15 seconds",
    )
  })
}

function waitReady(input: { directory?: string; name?: string }) {
  return Effect.gen(function* () {
    const ready = yield* Deferred.make<void>()
    const on = (event: GlobalEvent) => {
      if (event.payload.type !== Worktree.Event.Ready.type) return
      if (input.directory && event.directory !== input.directory) return
      if (input.name && event.payload.properties.name !== input.name) return
      Deferred.doneUnsafe(ready, Effect.void)
    }

    GlobalBus.on("event", on)
    yield* Effect.addFinalizer(() => Effect.sync(() => GlobalBus.off("event", on)))

    return yield* Deferred.await(ready).pipe(
      Effect.timeoutOrElse({
        duration: "10 seconds",
        orElse: () => Effect.fail(new Error("timed out waiting for worktree.ready")),
      }),
    )
  })
}

function insertAccount() {
  return Effect.acquireRelease(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .insert(AccountTable)
        .values({
          id: AccountV2.ID.make("account-test"),
          email: "test@example.com",
          url: "https://console.example.com",
          access_token: AccountV2.AccessToken.make("access"),
          refresh_token: AccountV2.RefreshToken.make("refresh"),
          time_created: Date.now(),
          time_updated: Date.now(),
        })
        .run()
        .pipe(Effect.orDie)
      return "account-test"
    }),
    (id) =>
      Database.Service.use(({ db }) =>
        db
          .delete(AccountTable)
          .where(eq(AccountTable.id, AccountV2.ID.make(id)))
          .run()
          .pipe(Effect.orDie),
      ),
  )
}

function setSessionUpdated(session: Session.Info, updated: number) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .update(SessionTable)
      .set({ time_updated: updated })
      .where(eq(SessionTable.id, session.id))
      .run()
      .pipe(Effect.orDie)
  })
}

function withCreatedWorktree(
  directory: string,
  use: (
    info: Worktree.Info,
  ) => Effect.Effect<void, unknown, HttpClient.HttpClient | InstanceStore.Service | Worktree.Service>,
) {
  const name = "api-test"
  const headers = { "content-type": "application/json" }
  return Effect.acquireUseRelease(
    Effect.gen(function* () {
      const ready = yield* waitReady({ name }).pipe(Effect.forkScoped)
      const created = yield* requestWithControlApproval(ExperimentalPaths.worktree, directory, "cpr_create_api_test", {
        method: "POST",
        headers,
        body: JSON.stringify({ name, requestID: "cpr_create_api_test" }),
      })

      if (created.result?.kind !== "worktree.create")
        return yield* Effect.fail(new Error("create completed without its terminal result"))
      const info: Worktree.Info = {
        name: created.result.name,
        directory: created.result.directory,
        branch: created.result.branch,
      }
      expect(info).toMatchObject({ name, branch: "arforge/api-test" })
      // The same user gesture replays its durable result and never creates a
      // second branch/worktree or runs startup scripts again.
      const replayed = yield* request(ExperimentalPaths.worktree, directory, {
        method: "POST",
        headers,
        body: JSON.stringify({ name, requestID: "cpr_create_api_test" }),
      })
      expect(replayed.status).toBe(200)
      expect(yield* json<ControlOperationStatus>(replayed)).toMatchObject({
        runID: created.runID,
        actionID: created.actionID,
        phase: "completed",
        result: info,
      })
      yield* Fiber.join(ready)
      return info
    }),
    use,
    (info) =>
      Effect.gen(function* () {
        const removed = yield* requestWithControlApproval(
          ExperimentalPaths.worktree,
          directory,
          "cpr_remove_api_test",
          {
            method: "DELETE",
            headers,
            body: JSON.stringify({ directory: info.directory, requestID: "cpr_remove_api_test" }),
          },
        )
        if (removed.result?.kind !== "worktree.remove")
          return yield* Effect.fail(new Error(`failed to remove worktree ${info.directory}`))
      }),
  )
}

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("experimental HttpApi", () => {
  it.instance(
    "serves read-only experimental endpoints through the default server app",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const directory = tmp.directory
        const [consoleState, consoleOrgs, toolList, toolIDs, worktrees, resources] = yield* Effect.all(
          [
            request(ExperimentalPaths.console, directory),
            request(ExperimentalPaths.consoleOrgs, directory),
            request(`${ExperimentalPaths.tool}?provider=arforge&model=gpt-5`, directory),
            request(ExperimentalPaths.toolIDs, directory),
            request(ExperimentalPaths.worktree, directory),
            request(ExperimentalPaths.resource, directory),
          ],
          { concurrency: "unbounded" },
        )

        expect(consoleState.status).toBe(200)
        expect(yield* json(consoleState)).toEqual({
          consoleManagedProviders: [],
          switchableOrgCount: 0,
        })

        expect(consoleOrgs.status).toBe(200)
        expect(yield* json(consoleOrgs)).toEqual({ orgs: [] })

        expect(toolList.status).toBe(200)
        expect(yield* json<unknown[]>(toolList)).toContainEqual(
          expect.objectContaining({
            id: "bash",
            description: expect.any(String),
            parameters: expect.any(Object),
          }),
        )

        expect(toolIDs.status).toBe(200)
        expect(yield* json(toolIDs)).toContain("bash")

        expect(worktrees.status).toBe(200)
        expect(yield* json(worktrees)).toEqual([])

        expect(resources.status).toBe(200)
        expect(yield* json(resources)).toEqual({})
      }),
    {
      config: {
        formatter: false,
        lsp: false,
        mcp: {
          demo: {
            type: "local",
            command: ["echo", "demo"],
            enabled: false,
          },
        },
      },
    },
  )

  it.instance("returns declared worktree errors", () =>
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      const response = yield* request(ExperimentalPaths.worktree, tmp.directory, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ requestID: "cpr_non_git" }),
      })

      expect(response.status).toBe(400)
      expect(yield* json(response)).toEqual({
        name: "WorktreeNotGitError",
        data: { message: "Worktrees are only supported for git projects" },
      })
    }),
  )

  it.instance("fails closed for an unknown control-operation alias", () =>
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      const response = yield* request(
        `${ExperimentalPaths.controlOperationStatus.replace(":requestID", "cpr_status_missing")}?operation=worktree.create`,
        tmp.directory,
      )
      expect(response.status).toBe(400)
    }),
  )

  testWorktreeMutations(
    "accepts a durable worktree mutation without keeping the HTTP request fiber alive",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const requestID = "cpr_async_contract_create"
        const response = yield* request(ExperimentalPaths.worktree, tmp.directory, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "async-contract", requestID }),
        }).pipe(
          Effect.timeoutOrElse({
            duration: "2 seconds",
            orElse: () => Effect.fail(new Error("mutation response waited for approval")),
          }),
        )
        expect(response.status).toBe(200)
        const accepted = yield* json<{
          runID: string
          actionID: string
          requestID: string
          operation: string
          phase: string
          recovery: string
          canApprove: boolean
        }>(response)
        expect(accepted).toMatchObject({
          runID: expect.stringMatching(/^run_/),
          actionID: expect.stringMatching(/^act_/),
          requestID,
          operation: "worktree.create",
        })
        expect(accepted).not.toHaveProperty("directory")
        expect(accepted).not.toBe(true)

        const approval = yield* pollWithTimeout(
          request(`${ExperimentalPaths.controlApproval}?${new URLSearchParams({ requestID })}`, tmp.directory).pipe(
            Effect.flatMap(json<Array<{ id: string; subject: { requestID: string } }>>),
            Effect.map((items) => items.find((item) => item.subject.requestID === requestID)),
          ),
          "detached worker did not publish its approval",
        )
        const status = yield* request(
          `${ExperimentalPaths.controlOperationStatus.replace(":requestID", requestID)}?operation=worktree.create`,
          tmp.directory,
        )
        expect(status.status).toBe(200)
        expect(yield* json(status)).toMatchObject({
          runID: accepted.runID,
          actionID: accepted.actionID,
          requestID,
          operation: "worktree.create",
          phase: "waiting_for_confirmation",
          recovery: "awaiting_authorization",
          canApprove: true,
        })
        expect(yield* request(ExperimentalPaths.worktree, tmp.directory).pipe(Effect.flatMap(json<string[]>))).toEqual(
          [],
        )

        const rejected = yield* request(
          ExperimentalPaths.controlApprovalReply.replace(":requestID", encodeURIComponent(approval.id)),
          tmp.directory,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ reply: "reject" }),
          },
        )
        expect(rejected.status).toBe(200)
      }),
    { git: true, config: { formatter: false, lsp: false } },
    20_000,
  )

  testWorktreeMutations(
    "returns only a validated terminal continuation result after detached execution completes",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        type Operation = "worktree.create" | "worktree.remove"
        type Status = {
          runID: string
          requestID: string
          operation: Operation
          phase: string
          result?:
            | { kind: "worktree.create"; name: string; directory: string; branch: string }
            | { kind: "worktree.remove"; completed: true }
        }
        const complete = Effect.fnUntraced(function* (input: {
          path: string
          operation: Operation
          requestID: string
          init: RequestInit
        }) {
          const accepted = yield* request(input.path, tmp.directory, input.init)
          expect(accepted.status).toBe(200)
          const initial = yield* json<Status>(accepted)
          expect(initial).toMatchObject({ requestID: input.requestID, operation: input.operation })
          expect(initial.result).toBeUndefined()

          const approval = yield* pollWithTimeout(
            request(
              `${ExperimentalPaths.controlApproval}?${new URLSearchParams({ requestID: input.requestID })}`,
              tmp.directory,
            ).pipe(
              Effect.flatMap(json<Array<{ id: string }>>),
              Effect.map((items) => items[0]),
            ),
            `approval was not published for ${input.requestID}`,
          )
          const replied = yield* request(
            ExperimentalPaths.controlApprovalReply.replace(":requestID", encodeURIComponent(approval.id)),
            tmp.directory,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ reply: "once" }),
            },
          )
          expect(replied.status).toBe(200)
          return yield* pollWithTimeout(
            request(
              `${ExperimentalPaths.controlOperationStatus.replace(":requestID", input.requestID)}?operation=${input.operation}`,
              tmp.directory,
            ).pipe(
              Effect.flatMap(json<Status>),
              Effect.flatMap((status) => {
                if (["failed", "cancelled", "paused"].includes(status.phase))
                  return Effect.fail(new Error(`control operation stopped in ${status.phase}`))
                return Effect.succeed(status.phase === "completed" ? status : undefined)
              }),
            ),
            `${input.operation} did not complete`,
            "15 seconds",
          )
        })

        const created = yield* complete({
          path: ExperimentalPaths.worktree,
          operation: "worktree.create",
          requestID: "cpr_terminal_result_create",
          init: {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ name: "terminal-result", requestID: "cpr_terminal_result_create" }),
          },
        })
        expect(created.result).toEqual({
          kind: "worktree.create",
          name: "terminal-result",
          directory: expect.any(String),
          branch: "arforge/terminal-result",
        })
        if (created.result?.kind !== "worktree.create")
          return yield* Effect.fail(new Error("create completed without its terminal result"))

        const removed = yield* complete({
          path: ExperimentalPaths.worktree,
          operation: "worktree.remove",
          requestID: "cpr_terminal_result_remove",
          init: {
            method: "DELETE",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              directory: created.result.directory,
              requestID: "cpr_terminal_result_remove",
            }),
          },
        })
        expect(removed.result).toEqual({ kind: "worktree.remove", completed: true })
      }),
    { git: true, config: { formatter: false, lsp: false } },
    35_000,
  )

  testWorktreeMutations(
    "rejects a control-plane worktree action before Git or filesystem mutation",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const rejected = yield* requestWithControlApproval(
          ExperimentalPaths.worktree,
          tmp.directory,
          "cpr_rejected_create",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ name: "rejected-api-test", requestID: "cpr_rejected_create" }),
          },
          "reject",
        )
        expect(rejected).toMatchObject({
          requestID: "cpr_rejected_create",
          operation: "worktree.create",
          phase: "failed",
        })
        expect(rejected.result).toBeUndefined()
        const listed = yield* request(ExperimentalPaths.worktree, tmp.directory)
        expect(yield* json<string[]>(listed)).not.toContainEqual(expect.stringContaining("rejected-api-test"))
      }),
    { git: true, config: { formatter: false, lsp: false } },
    20_000,
  )

  testWorktreeMutations(
    "coalesces competing aliases for the same explicit worktree material",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const directory = tmp.directory
        const name = "competing-api-test"
        const requestIDs = ["cpr_competing_create_a", "cpr_competing_create_b"] as const
        const responses = yield* Effect.all(
          requestIDs.map((requestID) =>
            request(ExperimentalPaths.worktree, directory, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ name, requestID }),
            }),
          ),
          { concurrency: "unbounded" },
        )
        expect(responses.map((response) => response.status)).toEqual([200, 200])
        const accepted = yield* Effect.all(responses.map(json<ControlOperationStatus>))
        expect(new Set(accepted.map((status) => status.runID)).size).toBe(1)
        expect(new Set(accepted.map((status) => status.actionID)).size).toBe(1)
        expect(accepted.map((status) => status.requestID).sort()).toEqual([...requestIDs].sort())

        // Equal canonical material has one durable run and therefore exactly
        // one fresh confirmation, regardless of which request won the claim.
        const approval = yield* pollWithTimeout(
          request(ExperimentalPaths.controlApproval, directory).pipe(
            Effect.flatMap(json<Array<{ id: string; subject: { requestID: string } }>>),
            Effect.map((items) => items[0]),
          ),
          "control-plane approval was not published for the competing aliases",
        )
        expect([...requestIDs] as string[]).toContain(approval.subject.requestID)
        const replied = yield* request(
          ExperimentalPaths.controlApprovalReply.replace(":requestID", encodeURIComponent(approval.id)),
          directory,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ reply: "once" }),
          },
        )
        expect(replied.status).toBe(200)

        const completed = yield* Effect.all(
          requestIDs.map((requestID) =>
            pollWithTimeout(
              readControlOperationStatus(directory, requestID, "worktree.create").pipe(
                Effect.map((status) => (status.phase === "completed" ? status : undefined)),
              ),
              `control operation did not complete for ${requestID}`,
              "15 seconds",
            ),
          ),
          { concurrency: "unbounded" },
        )
        expect(completed[0]!.result).toEqual(completed[1]!.result)
        const info = completed[0]!.result
        if (info?.kind !== "worktree.create")
          return yield* Effect.fail(new Error("coalesced create completed without its terminal result"))
        const listed = yield* request(ExperimentalPaths.worktree, directory).pipe(Effect.flatMap(json<string[]>))
        expect(listed.filter((item) => path.resolve(item) === path.resolve(info.directory))).toHaveLength(1)

        const removed = yield* requestWithControlApproval(
          ExperimentalPaths.worktree,
          directory,
          "cpr_remove_competing_winner",
          {
            method: "DELETE",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ directory: info.directory, requestID: "cpr_remove_competing_winner" }),
          },
        )
        expect(removed.result).toEqual({ kind: "worktree.remove", completed: true })
      }),
    { git: true, config: { formatter: false, lsp: false } },
    45_000,
  )

  testWorktreeMutations(
    "re-presents an interrupted desktop request under the same durable identity",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const directory = tmp.directory
        const requestID = "cpr_reload_create"
        const body = JSON.stringify({ name: "reload-api-test", requestID })
        const begin = () =>
          request(ExperimentalPaths.worktree, directory, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body,
          }).pipe(Effect.flatMap(json<ControlOperationStatus>))
        const approval = () =>
          pollWithTimeout(
            request(`${ExperimentalPaths.controlApproval}?${new URLSearchParams({ requestID })}`, directory).pipe(
              Effect.flatMap(json<Array<{ id: string; subject: { requestID: string } }>>),
              Effect.map((items) => items.find((item) => item.subject.requestID === requestID)),
            ),
            `control-plane approval was not re-presented for ${requestID}`,
          )

        // The first renderer can disappear immediately after acceptance. Its
        // request fiber owns no mutation and the durable approval remains.
        const disconnected = yield* begin()
        const firstApproval = yield* approval()
        expect(firstApproval.subject.requestID).toBe(requestID)
        expect(firstApproval).toMatchObject({
          action: "worktree.create",
          metadata: {
            reason: "Create an isolated worktree at the displayed commit.",
            requiresHumanConfirmation: true,
          },
        })
        expect((firstApproval as { metadata?: Record<string, unknown> }).metadata).not.toHaveProperty("intentDigest")

        // A caller connected to a different location/project cannot list or
        // reply to this approval merely by retaining its opaque ID.
        const foreignDirectory = yield* tmpdirScoped()
        const foreignList = yield* request(
          `${ExperimentalPaths.controlApproval}?${new URLSearchParams({ requestID })}`,
          foreignDirectory,
        )
        expect(yield* json<unknown[]>(foreignList)).toEqual([])
        const forgedReply = yield* request(
          ExperimentalPaths.controlApprovalReply.replace(":requestID", encodeURIComponent(firstApproval.id)),
          foreignDirectory,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ reply: "once" }),
          },
        )
        expect(forgedReply.status).toBe(400)
        expect((yield* approval()).id).toBe(firstApproval.id)

        const reconnected = yield* begin()
        expect(reconnected).toMatchObject({
          runID: disconnected.runID,
          actionID: disconnected.actionID,
          requestID,
          operation: "worktree.create",
        })
        const nextApproval = yield* approval()
        expect(nextApproval.id).toBe(firstApproval.id)
        const replied = yield* request(
          ExperimentalPaths.controlApprovalReply.replace(":requestID", encodeURIComponent(nextApproval.id)),
          directory,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ reply: "once" }),
          },
        )
        expect(replied.status).toBe(200)
        const completed = yield* pollWithTimeout(
          readControlOperationStatus(directory, requestID, "worktree.create").pipe(
            Effect.map((status) => (status.phase === "completed" ? status : undefined)),
          ),
          "reconnected worktree request did not complete",
          "15 seconds",
        )
        if (completed.result?.kind !== "worktree.create")
          return yield* Effect.fail(new Error("reconnected create completed without its terminal result"))
        const info: Worktree.Info = completed.result

        const replayed = yield* begin()
        expect(replayed).toMatchObject({
          runID: completed.runID,
          actionID: completed.actionID,
          phase: "completed",
          result: info,
        })
        const listed = yield* request(ExperimentalPaths.worktree, directory).pipe(Effect.flatMap(json<string[]>))
        expect(listed.filter((item) => path.resolve(item) === path.resolve(info.directory))).toHaveLength(1)

        const removed = yield* requestWithControlApproval(
          ExperimentalPaths.worktree,
          directory,
          "cpr_remove_reload_create",
          {
            method: "DELETE",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ directory: info.directory, requestID: "cpr_remove_reload_create" }),
          },
        )
        expect(removed.result).toEqual({ kind: "worktree.remove", completed: true })
      }),
    { git: true, config: { formatter: false, lsp: false } },
    45_000,
  )

  it.instance(
    "serves Console org switch through the default server app",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const accountID = yield* insertAccount()
        const switched = yield* request(ExperimentalPaths.consoleSwitch, tmp.directory, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ accountID, orgID: "org-test" }),
        })

        expect(switched.status).toBe(200)
        expect(yield* json(switched)).toBe(true)
      }),
    { config: { formatter: false, lsp: false } },
  )

  it.instance(
    "serves global session list through the default server app",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const first = yield* createSession({ title: "page-one" })
        const second = yield* createSession({ title: "page-two" })
        yield* setSessionUpdated(first, 1)
        yield* setSessionUpdated(second, 2)

        const page = yield* request(
          `${ExperimentalPaths.session}?${new URLSearchParams({ directory: tmp.directory, limit: "1" })}`,
          tmp.directory,
        )
        expect(page.status).toBe(200)
        expect(page.headers["x-next-cursor"]).toBeTruthy()

        const body = yield* json<Session.GlobalInfo[]>(page)
        expect(body.map((session) => session.id)).toEqual([second.id])
        expect(body[0].project?.id).toBe(second.projectID)

        const next = yield* request(
          `${ExperimentalPaths.session}?${new URLSearchParams({
            directory: tmp.directory,
            limit: "10",
            cursor: body[0].time.updated.toString(),
          })}`,
          tmp.directory,
        )
        expect(next.status).toBe(200)
        expect((yield* json<Session.GlobalInfo[]>(next)).map((session) => session.id)).toContain(first.id)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  testWorktreeMutations(
    "serves worktree mutations through the default server app",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        let removedDirectory = ""
        const orphanReservation = yield* InstanceStore.Service.use((instances) =>
          instances.provide(
            { directory: tmp.directory },
            Worktree.Service.use((worktrees) =>
              worktrees
                .prepareCreate({ name: "api-test" }, "cpr_create_api_test")
                .pipe(Effect.map((prepared) => `${prepared.reservationPath}.simulated-crash.tmp`)),
            ),
          ),
        )
        // Simulate a crash after a same-directory temp file was partially
        // written but before the atomic hard-link published the claim.
        yield* Effect.promise(() => fs.mkdir(path.dirname(orphanReservation), { recursive: true }))
        yield* Effect.promise(() => fs.writeFile(orphanReservation, "{", "utf8"))
        yield* Effect.addFinalizer(() => Effect.promise(() => fs.rm(orphanReservation, { force: true })))
        yield* withCreatedWorktree(tmp.directory, (info) =>
          Effect.gen(function* () {
            removedDirectory = info.directory
            const listed = yield* request(ExperimentalPaths.worktree, tmp.directory)
            expect(listed.status).toBe(200)
            expect(yield* json(listed)).toContain(info.directory)

            const divergentCreate = yield* request(ExperimentalPaths.worktree, tmp.directory, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ name: "different-api-test", requestID: "cpr_create_api_test" }),
            })
            expect(divergentCreate.status).toBe(400)

            // Simulate an executing hard-crash after the Git side effect but
            // before the Gateway observed it. The exact same request/action
            // re-enters the prepared operation and must reuse the owned
            // target instead of adding another worktree or branch.
            yield* InstanceStore.Service.use((instances) =>
              instances.provide(
                { directory: tmp.directory },
                Worktree.Service.use((worktrees) =>
                  Effect.gen(function* () {
                    const prepared = yield* worktrees.prepareCreate({ name: info.name }, "cpr_create_api_test")
                    const reservation = yield* Effect.promise(
                      () => Bun.file(prepared.reservationPath).json() as Promise<{ actionID: string }>,
                    )
                    const before = yield* worktrees.list()
                    const replayed = yield* worktrees.createPrepared(prepared, reservation.actionID)
                    const after = yield* worktrees.list()
                    expect(replayed).toEqual(info)
                    expect(after).toEqual(before)
                    expect(after.filter((item) => item.branch === info.branch)).toHaveLength(1)
                  }),
                ),
              ),
            )

            // A new user gesture cannot inherit the old request's explicit
            // name reservation, even though the target happens to exist.
            const competing = yield* request(ExperimentalPaths.worktree, tmp.directory, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ name: info.name, requestID: "cpr_competing_same_name" }),
            })
            expect(competing.status).toBe(400)
            const competingApprovals = yield* request(
              `${ExperimentalPaths.controlApproval}?requestID=cpr_competing_same_name`,
              tmp.directory,
            )
            expect(yield* json<unknown[]>(competingApprovals)).toEqual([])

            const reset = yield* requestWithControlApproval(
              ExperimentalPaths.worktreeReset,
              tmp.directory,
              "cpr_reset_api_test",
              {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ directory: info.directory, requestID: "cpr_reset_api_test" }),
              },
            )

            expect(reset.result).toEqual({ kind: "worktree.reset", completed: true })
            const divergentReset = yield* request(ExperimentalPaths.worktreeReset, tmp.directory, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ directory: tmp.directory, requestID: "cpr_reset_api_test" }),
            })
            expect(divergentReset.status).toBe(400)
          }),
        )

        const afterRemove = yield* request(ExperimentalPaths.worktree, tmp.directory)
        expect(afterRemove.status).toBe(200)
        expect(yield* json(afterRemove)).toEqual([])
        const divergentRemove = yield* request(ExperimentalPaths.worktree, tmp.directory, {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ directory: tmp.directory, requestID: "cpr_remove_api_test" }),
        })
        expect(divergentRemove.status).toBe(400)

        // A path recreated after Git stopped tracking the worktree belongs to
        // an unknown actor. An exact retry returns only the old terminal
        // status and must never re-run preparation or touch the new content.
        const sentinel = `${removedDirectory}/do-not-delete.txt`
        yield* Effect.promise(() => fs.mkdir(removedDirectory, { recursive: true }))
        yield* Effect.addFinalizer(() =>
          Effect.promise(() => fs.rm(removedDirectory, { recursive: true, force: true })),
        )
        yield* Effect.promise(() => fs.writeFile(sentinel, "new owner\n", "utf8"))
        const replayedRemove = yield* request(ExperimentalPaths.worktree, tmp.directory, {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ directory: removedDirectory, requestID: "cpr_remove_api_test" }),
        })
        expect(replayedRemove.status).toBe(200)
        expect(yield* json<ControlOperationStatus>(replayedRemove)).toMatchObject({
          requestID: "cpr_remove_api_test",
          operation: "worktree.remove",
          phase: "completed",
          result: { kind: "worktree.remove", completed: true },
        })
        expect(yield* Effect.promise(() => fs.readFile(sentinel, "utf8"))).toBe("new owner\n")
        yield* Effect.promise(() => fs.rm(removedDirectory, { recursive: true, force: true }))
      }),
    { git: true, config: { formatter: false, lsp: false } },
    45_000,
  )

})
