/**
 * End-to-end exerciser for the Effect HttpApi routes.
 *
 * The goal is not to be a normal unit test file. This is a route-coverage harness:
 * every public route should have a small scenario that proves the route decodes
 * requests, uses the right instance context, mutates storage when expected, and
 * returns the expected response shape.
 *
 * The script intentionally isolates `ARFORGE_DB` before importing modules that touch
 * storage. Scenarios may create/delete sessions and reset the database after each run,
 * so this must never point at a developer's real session database.
 *
 * DSL shape:
 * - `http.protected.get/post/...` starts a scenario for one OpenAPI route key.
 * - `.seeded(...)` creates typed per-scenario state using Effect helpers on `ctx`.
 * - `.at(...)` builds the request from that typed state.
 * - `.json(...)` / `.jsonEffect(...)` assert response shape and optional side effects.
 * - `.mutating()` tells the runner to reset isolated state after destructive routes.
 */
import { Effect } from "effect"
import { OpenApi } from "effect/unstable/httpapi"
import { TestLLMServer } from "../../lib/llm-server"
import path from "path"
import { array, boolean, check, isRecord, message, object, stable } from "./assertions"
import { controlledPtyInput, http, route } from "./dsl"
import { cleanupExercisePaths, exerciseConfigDirectory, exerciseDatabasePath, exerciseGlobalRoot } from "./environment"
import { color, printHeader, printResults } from "./report"
import { coverageResult, parseOptions, routeKey, routeKeys, selectedScenarios } from "./routing"
import { runScenario } from "./runner"
import { disposeApps } from "./backend"
import { runtime } from "./runtime"
import { type CallResult, type Scenario, type ScenarioContext } from "./types"

const exerciseAuthFile = path.join(exerciseGlobalRoot, "python", "auth.json")

function controlOperationStatus(body: unknown, operation: string) {
  object(body)
  check(body.operation === operation, `${operation} should return its durable operation kind`)
  check(typeof body.requestID === "string", `${operation} should return its request ID`)
  check(typeof body.phase === "string", `${operation} should return its current phase`)
  return body
}

function controlPoll<A>(
  self: Effect.Effect<A | undefined>,
  message: string,
  duration: "5 seconds" | "15 seconds" = "5 seconds",
) {
  return Effect.gen(function* () {
    while (true) {
      const result = yield* self
      if (result !== undefined) return result
      yield* Effect.sleep("20 millis")
    }
  }).pipe(Effect.timeoutOrElse({ duration, orElse: () => Effect.die(new Error(message)) }))
}

function approveControlOperation(ctx: ScenarioContext, requestID: string, operation: string) {
  return Effect.gen(function* () {
    const approval = yield* controlPoll(
      ctx
        .api("GET", {
          path: `/experimental/control-approval?requestID=${encodeURIComponent(requestID)}`,
          headers: ctx.headers(),
        })
        .pipe(
          Effect.map((result) => {
            check(result.status === 200, `control approval list should return 200, got ${result.status}`)
            array(result.body)
            return result.body.find(
              (item) =>
                isRecord(item) &&
                typeof item.id === "string" &&
                isRecord(item.subject) &&
                item.subject.requestID === requestID,
            )
          }),
        ),
      `control-plane approval was not published for ${requestID}`,
    ).pipe(Effect.catch((error) => Effect.die(error)))
    object(approval)
    check(typeof approval.id === "string", `control approval should include an ID for ${requestID}`)

    const replied = yield* ctx.api("POST", {
      path: `/experimental/control-approval/${encodeURIComponent(approval.id)}/reply`,
      headers: ctx.headers(),
      body: { reply: "once" },
    })
    check(replied.status === 200, `control approval reply should return 200, got ${replied.status}`)
    check(replied.body === true, "control approval reply should return true")

    return yield* controlPoll(
      ctx
        .api("GET", {
          path: `/experimental/control-operation/${encodeURIComponent(requestID)}?operation=${operation}`,
          headers: ctx.headers(),
        })
        .pipe(
          Effect.map((result) => {
            check(result.status === 200, `control operation status should return 200, got ${result.status}`)
            const status = controlOperationStatus(result.body, operation)
            if (["failed", "cancelled", "paused"].includes(String(status.phase))) {
              throw new Error(`${operation} stopped in ${String(status.phase)}`)
            }
            return status.phase === "completed" ? status : undefined
          }),
        ),
      `${operation} did not reach its completed phase`,
      "15 seconds",
    ).pipe(Effect.catch((error) => Effect.die(error)))
  })
}

function cursor(input: Record<string, unknown>) {
  return Buffer.from(JSON.stringify(input)).toString("base64url")
}

function canonicalWorkspacePath(value: string) {
  const normalized = value.replaceAll("\\", "/").replace(/\/+$/, "") || "/"
  return process.platform === "win32" ? normalized.toLocaleLowerCase("en-US") : normalized
}

function data(validate: (value: any) => void) {
  return (body: any) => {
    object(body)
    validate(body.data)
  }
}

function locationData(validate: (value: any) => void) {
  return (body: any) => {
    object(body)
    object(body.location)
    object(body.location.project)
    validate(body.data)
  }
}

function apiPayload(result: CallResult, operation: string) {
  check(result.status === 200, `${operation} expected 200, got ${result.status}: ${result.text}`)
  object(result.body)
  return result.body.data
}

function apiData(result: CallResult, operation: string) {
  const payload = apiPayload(result, operation)
  object(payload)
  return payload
}

function apiSession(ctx: ScenarioContext, executable = false) {
  return ctx
    .api("POST", {
      path: "/api/session",
      headers: ctx.headers(),
      body: {
        location: { directory: ctx.directory },
        ...(executable ? { agent: "build", model: { id: "test-model", providerID: "test" } } : {}),
      },
    })
    .pipe(
      Effect.map((result) => {
        const session = apiData(result, "session seed")
        check(typeof session.id === "string", "session seed should return an ID")
        return { id: session.id }
      }),
    )
}

function apiGoal(ctx: ScenarioContext, sessionID: string, objective: string, queue = false) {
  return ctx
    .api("POST", {
      path: route("/api/session/{sessionID}/goal", { sessionID }),
      headers: ctx.headers(),
      body: { objective, queue },
    })
    .pipe(
      Effect.map((result) => {
        const goal = apiData(result, "goal seed")
        check(typeof goal.id === "string", "goal seed should return an ID")
        check(typeof goal.revision === "number", "goal seed should return a revision")
        check(typeof goal.status === "string", "goal seed should return a status")
        return { id: goal.id, revision: goal.revision, status: goal.status }
      }),
    )
}

function apiTask(ctx: ScenarioContext, sessionID: string, title: string) {
  return ctx
    .api("POST", {
      path: route("/api/session/{sessionID}/task", { sessionID }),
      headers: ctx.headers(),
      body: { title },
    })
    .pipe(
      Effect.map((result) => {
        const task = apiData(result, "task seed")
        check(typeof task.id === "string", "task seed should return an ID")
        check(typeof task.revision === "number", "task seed should return a revision")
        return { id: task.id, revision: task.revision }
      }),
    )
}

function apiPrompt(ctx: ScenarioContext, sessionID: string, text: string) {
  return ctx
    .api("POST", {
      path: route("/api/session/{sessionID}/prompt", { sessionID }),
      headers: ctx.headers(),
      body: { prompt: { text }, delivery: "queue", resume: false },
    })
    .pipe(
      Effect.map((result) => {
        const prompt = apiData(result, "prompt seed")
        check(typeof prompt.id === "string", "prompt seed should return an ID")
        check(typeof prompt.admittedSeq === "number", "prompt seed should return an admission sequence")
        return { id: prompt.id, admittedSeq: prompt.admittedSeq }
      }),
    )
}

function apiPersonalJob(ctx: ScenarioContext, sessionID: string, idempotencyKey = "httpapi-personal-job") {
  return ctx
    .api("POST", {
      path: route("/api/session/{sessionID}/personal-job", { sessionID }),
      headers: ctx.headers(),
      body: {
        idempotencyKey,
        title: "HTTP API visible background job",
        prompt: "Read the current workspace and report a bounded verification summary.",
        schedule: {
          kind: "once",
          label: "HTTP API verification",
          nextRunAt: new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString(),
          timezone: "UTC",
        },
        budget: { maxAttempts: 2, maxDurationMs: 60_000, maxCostMicros: 10_000 },
        approvalPolicy: { mode: "automatic", rationale: "The HTTP exerciser owns this isolated job." },
        notificationPolicy: { mode: "in_app", events: ["completed", "failed", "cancelled"] },
      },
    })
    .pipe(
      Effect.map((result) => {
        const job = apiData(result, "personal job seed") as {
          id?: unknown
          sessionID?: unknown
          status?: unknown
          visibility?: { mode?: unknown; userVisible?: unknown }
          revision?: unknown
        }
        check(typeof job.id === "string" && job.id.startsWith("pjob_"), "personal job seed should return an opaque ID")
        check(job.sessionID === sessionID, "personal job seed should bind to the session")
        check(job.status === "queued", "automatic personal jobs should start queued")
        check(
          job.visibility?.mode === "background" && job.visibility?.userVisible === true,
          "personal job should be visible",
        )
        check(typeof job.revision === "number" && job.revision > 0, "personal job seed should expose a revision")
        return { id: job.id, revision: job.revision }
      }),
    )
}

function apiTurn(ctx: ScenarioContext, sessionID: string, prompt: string, response: string) {
  return Effect.gen(function* () {
    yield* ctx.llmText(response)
    yield* ctx.llmText(response)
    const admitted = apiData(
      yield* ctx.api("POST", {
        path: route("/api/session/{sessionID}/prompt", { sessionID }),
        headers: ctx.headers(),
        body: { prompt: { text: prompt }, delivery: "queue" },
      }),
      "session turn seed",
    )
    check(typeof admitted.id === "string", "session turn should be durably admitted")
    const waited = yield* ctx.api("POST", {
      path: route("/api/session/{sessionID}/wait", { sessionID }),
      headers: ctx.headers(),
    })
    check(waited.status === 204, `session turn wait expected 204, got ${waited.status}: ${waited.text}`)
  })
}

function apiCheckpoint(ctx: ScenarioContext, sessionID: string, label: string) {
  return ctx
    .api("POST", {
      path: route("/api/session/{sessionID}/checkpoint", { sessionID }),
      headers: ctx.headers(),
      body: { label },
    })
    .pipe(
      Effect.map((result) => {
        const checkpoint = apiData(result, "checkpoint seed")
        check(typeof checkpoint.id === "string", "checkpoint seed should return an ID")
        check(typeof checkpoint.sequence === "number", "checkpoint seed should return a sequence")
        return { id: checkpoint.id, sequence: checkpoint.sequence }
      }),
    )
}

function apiMemory(
  ctx: ScenarioContext,
  input: {
    content: string
    type?: string
    tags?: string[]
    importance?: number
    source?: "user" | "user-corrected" | "imported" | "auto" | "model"
    scope?: "workspace" | "global"
    strength?: number
    reviewLevel?: number
  },
) {
  return ctx
    .api("POST", {
      path: "/api/memory",
      headers: ctx.headers(),
      body: input,
    })
    .pipe(
      Effect.map((result) => {
        const memory = apiData(result, "memory seed")
        check(typeof memory.id === "string", "memory seed should return an ID")
        check(typeof memory.content === "string", "memory seed should return content")
        return {
          id: memory.id as string,
          content: memory.content as string,
          source: memory.source as string,
          scope: memory.scope as string,
        }
      }),
    )
}

function apiTeam(ctx: ScenarioContext, name: string, description?: string) {
  return Effect.gen(function* () {
    const session = yield* apiSession(ctx)
    const team = apiData(
      yield* ctx.api("POST", {
        path: route("/api/session/{sessionID}/team", { sessionID: session.id }),
        headers: ctx.headers(),
        body: { name, ...(description === undefined ? {} : { description }) },
      }),
      "team seed",
    )
    check(typeof team.id === "string", "team seed should return an ID")
    check(team.sessionID === session.id, "team seed should remain session-owned")
    return { session, team: { id: team.id as string } }
  })
}

function apiTeamMember(
  ctx: ScenarioContext,
  sessionID: string,
  memberName: string,
  agentID: "general" | "explore" = "general",
) {
  return ctx
    .api("POST", {
      path: route("/api/session/{sessionID}/team/member", { sessionID }),
      headers: ctx.headers(),
      body: { memberName, agentID },
    })
    .pipe(
      Effect.map((result) => {
        const member = apiData(result, "team member seed")
        check(member.name === memberName, "team member seed should preserve the member name")
        check(member.agentID === agentID, "team member seed should bind the selected subagent role")
        return { name: member.name as string, agentID: member.agentID as string }
      }),
    )
}

function apiSchedule(
  ctx: ScenarioContext,
  sessionID: string,
  input: {
    name: string
    prompt: string
    cron?: string
    recurring?: boolean
    durable?: boolean
  },
) {
  return ctx
    .api("POST", {
      path: route("/api/session/{sessionID}/schedule", { sessionID }),
      headers: ctx.headers(),
      body: {
        name: input.name,
        cron: input.cron ?? "0 0 * * *",
        prompt: input.prompt,
        recurring: input.recurring ?? false,
        durable: input.durable ?? true,
      },
    })
    .pipe(
      Effect.map((result) => {
        const schedule = apiData(result, "scheduled prompt seed")
        check(typeof schedule.id === "string", "scheduled prompt seed should return an ID")
        check(typeof schedule.revision === "number", "scheduled prompt seed should return a revision")
        return {
          id: schedule.id as string,
          revision: schedule.revision as number,
          status: schedule.status as string,
        }
      }),
    )
}

function apiFeedback(
  ctx: ScenarioContext,
  input: { category: "bug" | "feature" | "experience" | "other"; rating: number; message: string },
) {
  return ctx.api("POST", { path: "/api/feedback", headers: ctx.headers(), body: input }).pipe(
    Effect.map((result) => {
      const submitted = apiData(result, "feedback seed")
      object(submitted.feedback)
      check(typeof submitted.feedback.id === "string", "feedback seed should return an ID")
      return { id: submitted.feedback.id as string }
    }),
  )
}

function apiEvolutionCandidate(ctx: ScenarioContext) {
  return ctx
    .api("POST", {
      path: "/api/agent-capabilities/evolution/candidates",
      headers: ctx.headers(),
      body: {
        title: "HTTP API evolution candidate",
        target: "learning.fix",
        instruction: "Keep the verified HTTP API contract covered.",
        rationale: "The route exercise must use a governed candidate created by the real service.",
        evidenceRefs: ["httpapi-exercise"],
      },
    })
    .pipe(
      Effect.map((result) => {
        const candidate = apiData(result, "evolution candidate seed")
        check(typeof candidate.candidate_id === "string", "evolution candidate seed should return an ID")
        check(
          isRecord(candidate.state) && typeof candidate.state.revision === "number",
          "evolution candidate seed should return a state revision",
        )
        return {
          id: candidate.candidate_id as string,
          revision: (candidate.state as Record<string, unknown>).revision as number,
        }
      }),
    )
}

function apiLearning(
  ctx: ScenarioContext,
  input: {
    userInput: string
    success: boolean
    errorType?: string
    errorMessage?: string
    fixStrategy?: string
    regression?: boolean
    tags?: string[]
    importance?: number
  },
) {
  return ctx.api("POST", { path: "/api/learning/outcome", headers: ctx.headers(), body: input }).pipe(
    Effect.map((result) => {
      const outcome = apiData(result, "learning outcome seed")
      check(typeof outcome.id === "string", "learning outcome seed should return an ID")
      return { id: outcome.id as string }
    }),
  )
}

const scenarios: Scenario[] = [
  http.protected
    .get("/global/health", "global.health")
    .global()
    .json(200, (body) => {
      object(body)
      check(body.healthy === true, "server should report healthy")
    }),
  http.protected
    .get("/global/event", "global.event")
    .global()
    .stream()
    .status(
      200,
      (_ctx, result) =>
        Effect.sync(() => {
          check(result.contentType.includes("text/event-stream"), "global event should be an SSE stream")
          check(result.text.includes("server.connected"), "global event should emit initial connection event")
        }),
      "status",
    ),
  http.protected.get("/global/config", "global.config.get").global().json(),
  http.protected
    .patch("/global/config", "global.config.update")
    .global()
    .seeded(() =>
      Effect.promise(() =>
        Bun.write(
          path.join(exerciseConfigDirectory, "arforge.jsonc"),
          JSON.stringify({ username: "httpapi-global" }, null, 2),
        ),
      ),
    )
    .at(() => ({ path: "/global/config", body: { username: "httpapi-global" } }))
    .jsonEffect(
      200,
      (body) =>
        Effect.gen(function* () {
          object(body)
          check(body.username === "httpapi-global", "global config update should return patched config")
          const text = yield* Effect.promise(() => Bun.file(path.join(exerciseConfigDirectory, "arforge.jsonc")).text())
          check(text.includes('"username": "httpapi-global"'), "global config update should write isolated config file")
        }),
      "status",
    ),
  http.protected
    .post("/global/dispose", "global.dispose")
    .global()
    .mutating()
    .json(
      200,
      (body) => {
        check(body === true, "global dispose should return true")
      },
      "status",
    ),
  http.protected.get("/path", "path.get").json(200, (body, ctx) => {
    object(body)
    check(body.directory === ctx.directory, "directory should resolve from x-arforge-directory")
    check(body.worktree === ctx.directory, "worktree should resolve from x-arforge-directory")
  }),
  http.protected.get("/vcs", "vcs.get").json(),
  http.protected.get("/vcs/status", "vcs.status").json(200, array),
  http.protected
    .get("/vcs/diff", "vcs.diff")
    .at((ctx) => ({ path: "/vcs/diff?mode=git", headers: ctx.headers() }))
    .json(200, array),
  http.protected.get("/vcs/diff/raw", "vcs.diff.raw").status(
    200,
    (_ctx, result) =>
      Effect.sync(() => {
        check(typeof result.text === "string", "raw VCS diff should return text")
      }),
    "status",
  ),
  http.protected
    .post("/vcs/apply", "vcs.apply")
    .inProject({ git: false })
    .at((ctx) => ({ path: "/vcs/apply", headers: ctx.headers(), body: { patch: "" } }))
    .status(400, undefined, "status"),
  http.protected.get("/command", "command.list").json(200, array, "status"),
  http.protected.get("/agent", "app.agents").json(200, array, "status"),
  http.protected.get("/skill", "app.skills").json(200, array, "status"),
  http.protected.get("/lsp", "lsp.status").json(200, array),
  http.protected.get("/formatter", "formatter.status").json(200, array),
  http.protected.get("/config", "config.get").json(200, undefined, "status"),
  http.protected
    .patch("/config", "config.update")
    .mutating()
    .at((ctx) => ({ path: "/config", headers: ctx.headers(), body: { username: "httpapi-local" } }))
    .json(
      200,
      (body) => {
        object(body)
        check(body.username === "httpapi-local", "local config update should return patched config")
      },
      "status",
    ),
  http.protected
    .patch("/config", "config.update.invalid")
    .at((ctx) => ({ path: "/config", headers: ctx.headers(), body: { username: 1 } }))
    .status(400),
  http.protected.get("/config/providers", "config.providers").json(),
  http.protected.get("/project", "project.list").json(200, array, "status"),
  http.protected.get("/project/current", "project.current").json(
    200,
    (body, ctx) => {
      object(body)
      check(body.worktree === ctx.directory, "current project should resolve from scenario directory")
    },
    "status",
  ),
  http.protected
    .patch("/project/{projectID}", "project.update")
    .mutating()
    .seeded((ctx) => ctx.project())
    .at((ctx) => ({
      path: route("/project/{projectID}", { projectID: ctx.state.id }),
      headers: ctx.headers(),
      body: { name: "HTTP API Project", commands: { start: "bun --version" } },
    }))
    .json(
      200,
      (body) => {
        object(body)
        check(body.name === "HTTP API Project", "project update should return patched name")
        check(
          isRecord(body.commands) && body.commands.start === "bun --version",
          "project update should return patched command",
        )
      },
      "status",
    ),
  http.protected
    .patch("/project/{projectID}", "project.update.missing")
    .mutating()
    .at((ctx) => ({
      path: route("/project/{projectID}", { projectID: "project_httpapi_missing" }),
      headers: ctx.headers(),
      body: { name: "Missing Project" },
    }))
    .json(404, object, "status"),
  http.protected
    .post("/project/git/init", "project.initGit")
    .mutating()
    .inProject({ git: false })
    .json(
      200,
      (body, ctx) => {
        object(body)
        check(body.worktree === ctx.directory, "git init should return current project")
        check(body.vcs === "git", "git init should mark the project as git-backed")
      },
      "status",
    ),
  http.protected
    .get("/project/{projectID}/directories", "project.directories")
    .seeded((ctx) => ctx.project())
    .at((ctx) => ({
      path: route("/project/{projectID}/directories", { projectID: ctx.state.id }),
      headers: ctx.headers(),
    }))
    .json(200, array, "status"),
  http.protected
    .post("/experimental/project/{projectID}/copy/generate-name", "experimental.projectCopy.generateName")
    .seeded((ctx) => ctx.project())
    .at((ctx) => ({
      path: route("/experimental/project/{projectID}/copy/generate-name", { projectID: ctx.state.id }),
      headers: ctx.headers(),
      body: {},
    }))
    .json(200, (body) => {
      object(body)
      check(typeof body.name === "string" && body.name.length > 0, "generated copy name should be non-empty")
    }),
  http.protected
    .get("/experimental/project/{projectID}/copy", "experimental.projectCopy.list")
    .seeded((ctx) => ctx.project())
    .at((ctx) => ({
      path: route("/experimental/project/{projectID}/copy", { projectID: ctx.state.id }),
      headers: ctx.headers(),
    }))
    .json(200, (body, ctx) => {
      array(body)
      check(
        body.some((entry) => {
          object(entry)
          return entry.directory === ctx.directory && entry.type === "root"
        }),
        "project copy list should include the project root",
      )
    }),
  http.protected
    .post("/experimental/project/{projectID}/copy", "experimental.projectCopy.create")
    .seeded((ctx) => ctx.project())
    .at((ctx) => ({
      path: route("/experimental/project/{projectID}/copy", { projectID: ctx.state.id }),
      headers: ctx.headers(),
      body: {},
    }))
    .status(400),
  http.protected
    .delete("/experimental/project/{projectID}/copy", "experimental.projectCopy.remove")
    .seeded((ctx) => ctx.project())
    .at((ctx) => ({
      path: route("/experimental/project/{projectID}/copy", { projectID: ctx.state.id }),
      headers: ctx.headers(),
      body: {},
    }))
    .status(400),
  http.protected
    .post("/experimental/project/{projectID}/copy/refresh", "experimental.projectCopy.refresh")
    .mutating()
    .seeded((ctx) => ctx.project())
    .at((ctx) => ({
      path: route("/experimental/project/{projectID}/copy/refresh", { projectID: ctx.state.id }),
      headers: ctx.headers(),
    }))
    .status(204, undefined, "status"),
  http.protected.get("/provider", "provider.list").json(),
  http.protected.get("/provider/auth", "provider.auth").json(),
  http.protected
    .post("/provider/{providerID}/oauth/authorize", "provider.oauth.authorize")
    .at((ctx) => ({
      path: route("/provider/{providerID}/oauth/authorize", { providerID: "httpapi" }),
      headers: ctx.headers(),
      body: { method: "bad" },
    }))
    .status(400),
  http.protected
    .post("/provider/{providerID}/oauth/callback", "provider.oauth.callback")
    .at((ctx) => ({
      path: route("/provider/{providerID}/oauth/callback", { providerID: "httpapi" }),
      headers: ctx.headers(),
      body: { method: "bad" },
    }))
    .status(400),
  http.protected.get("/permission", "permission.list").json(200, array),
  http.protected
    .post("/permission/{requestID}/reply", "permission.reply.invalid")
    .at((ctx) => ({
      path: route("/permission/{requestID}/reply", { requestID: "per_httpapi" }),
      headers: ctx.headers(),
      body: { reply: "bad" },
    }))
    .status(400),
  http.protected
    .post("/permission/{requestID}/reply", "permission.reply")
    .at((ctx) => ({
      path: route("/permission/{requestID}/reply", { requestID: "per_httpapi" }),
      headers: ctx.headers(),
      body: { reply: "once" },
    }))
    .json(404, object, "status"),
  http.protected.get("/question", "question.list").json(200, array),
  http.protected
    .post("/question/{requestID}/reply", "question.reply.invalid")
    .at((ctx) => ({
      path: route("/question/{requestID}/reply", { requestID: "que_httpapi_reply" }),
      headers: ctx.headers(),
      body: { answers: "Yes" },
    }))
    .status(400),
  http.protected
    .post("/question/{requestID}/reply", "question.reply")
    .at((ctx) => ({
      path: route("/question/{requestID}/reply", { requestID: "que_httpapi_reply" }),
      headers: ctx.headers(),
      body: { answers: [["Yes"]] },
    }))
    .json(404, object, "status"),
  http.protected
    .post("/question/{requestID}/reject", "question.reject")
    .at((ctx) => ({
      path: route("/question/{requestID}/reject", { requestID: "que_httpapi_reject" }),
      headers: ctx.headers(),
    }))
    .json(404, object, "status"),
  http.protected
    .get("/file", "file.list")
    .seeded((ctx) => ctx.file("hello.txt", "hello\n"))
    .at((ctx) => ({ path: `/file?${new URLSearchParams({ path: "." })}`, headers: ctx.headers() }))
    .json(200, array),
  http.protected
    .get("/file/content", "file.read")
    .seeded((ctx) => ctx.file("hello.txt", "hello\n"))
    .at((ctx) => ({ path: `/file/content?${new URLSearchParams({ path: "hello.txt" })}`, headers: ctx.headers() }))
    .json(200, (body) => {
      object(body)
      check(body.content === "hello", `content should match seeded file: ${JSON.stringify(body)}`)
    }),
  http.protected
    .get("/file/content", "file.read.missing")
    .at((ctx) => ({ path: `/file/content?${new URLSearchParams({ path: "missing.txt" })}`, headers: ctx.headers() }))
    .json(200, (body) => {
      object(body)
      check(body.type === "text" && body.content === "", "missing file content should return an empty text result")
    }),
  http.protected.get("/file/status", "file.status").json(200, array),
  http.protected
    .get("/find", "find.text")
    .seeded((ctx) => ctx.file("hello.txt", "hello\n"))
    .at((ctx) => ({ path: `/find?${new URLSearchParams({ pattern: "hello" })}`, headers: ctx.headers() }))
    .json(200, array),
  http.protected
    .get("/find/file", "find.files")
    .seeded((ctx) => ctx.file("hello.txt", "hello\n"))
    .at((ctx) => ({
      path: `/find/file?${new URLSearchParams({ query: "hello", dirs: "false" })}`,
      headers: ctx.headers(),
    }))
    .json(200, array),
  http.protected
    .get("/find/symbol", "find.symbols")
    .seeded((ctx) => ctx.file("hello.ts", "export const hello = 1\n"))
    .at((ctx) => ({ path: `/find/symbol?${new URLSearchParams({ query: "hello" })}`, headers: ctx.headers() }))
    .json(200, array),
  http.protected
    .get("/event", "event.stream")
    .stream()
    .status(
      200,
      (_ctx, result) =>
        Effect.sync(() => {
          check(result.contentType.includes("text/event-stream"), "event should be an SSE stream")
          check(result.text.includes("server.connected"), "event should emit initial connection event")
        }),
      "status",
    ),
  http.protected.get("/mcp", "mcp.status").json(),
  http.protected.get("/mcp/health", "mcp.health").json(200, (body) => {
    object(body)
    for (const [server, snapshot] of Object.entries(body)) {
      check(server.trim().length > 0, "MCP health should use non-empty server keys")
      object(snapshot)
      check(typeof snapshot.phase === "string", "MCP health should expose supervisor phase")
      check(typeof snapshot.health === "string", "MCP health should expose health state")
      check(typeof snapshot.safeMessage === "string", "MCP health should expose a redacted safe message")
      check(!JSON.stringify(snapshot).toLowerCase().includes("token"), "MCP health must not expose credentials")
    }
  }),
  http.protected
    .get("/api/self-hosted-share/lookup/{operationID}", "selfHostedShare.lookup")
    .at((ctx) => ({
      path: "/api/self-hosted-share/lookup/httpapi-missing",
      headers: ctx.headers(),
    }))
    .status(403),
  http.protected
    .get("/api/self-hosted-share/revoke/{operationID}", "selfHostedShare.lookupRevoke")
    .at((ctx) => ({
      path: "/api/self-hosted-share/revoke/httpapi-missing",
      headers: ctx.headers(),
    }))
    .status(403),
  http.protected
    .post("/api/self-hosted-share/publish", "selfHostedShare.publish")
    .at((ctx) => ({ path: "/api/self-hosted-share/publish", headers: ctx.headers(), body: {} }))
    .status(400),
  http.protected
    .post("/api/self-hosted-share/revoke", "selfHostedShare.revoke")
    .at((ctx) => ({ path: "/api/self-hosted-share/revoke", headers: ctx.headers(), body: {} }))
    .status(400),
  http.protected
    .post("/mcp", "mcp.add")
    .mutating()
    .at((ctx) => ({
      path: "/mcp",
      headers: ctx.headers(),
      body: { name: "httpapi-disabled", config: { type: "local", command: ["bun", "--version"], enabled: false } },
    }))
    .json(
      200,
      (body) => {
        object(body)
        object(body["httpapi-disabled"])
        check(body["httpapi-disabled"].status === "disabled", "disabled MCP server should be added without spawning")
      },
      "status",
    ),
  http.protected
    .post("/mcp", "mcp.add.invalid")
    .at((ctx) => ({
      path: "/mcp",
      headers: ctx.headers(),
      body: { name: "httpapi-invalid", config: { type: "invalid" } },
    }))
    .status(400),
  http.protected
    .post("/mcp/{name}/auth", "mcp.auth.start")
    .at((ctx) => ({ path: route("/mcp/{name}/auth", { name: "httpapi-missing" }), headers: ctx.headers() }))
    .json(404, object, "status"),
  http.protected
    .delete("/mcp/{name}/auth", "mcp.auth.remove")
    .mutating()
    .at((ctx) => ({ path: route("/mcp/{name}/auth", { name: "httpapi-missing" }), headers: ctx.headers() }))
    .json(404, object, "status"),
  http.protected
    .post("/mcp/{name}/auth/authenticate", "mcp.auth.authenticate")
    .at((ctx) => ({
      path: route("/mcp/{name}/auth/authenticate", { name: "httpapi-missing" }),
      headers: ctx.headers(),
    }))
    .json(404, object, "status"),
  http.protected
    .post("/mcp/{name}/auth/callback", "mcp.auth.callback")
    .at((ctx) => ({
      path: route("/mcp/{name}/auth/callback", { name: "httpapi-missing" }),
      headers: ctx.headers(),
      body: { code: "code", oauthState: "missing" },
    }))
    .json(404, object, "status"),
  http.protected
    .post("/mcp/{name}/connect", "mcp.connect")
    .mutating()
    .at((ctx) => ({ path: route("/mcp/{name}/connect", { name: "httpapi-missing" }), headers: ctx.headers() }))
    .json(404, object, "status"),
  http.protected
    .post("/mcp/{name}/disconnect", "mcp.disconnect")
    .mutating()
    .at((ctx) => ({ path: route("/mcp/{name}/disconnect", { name: "httpapi-missing" }), headers: ctx.headers() }))
    .json(404, object, "status"),
  http.protected.get("/pty/shells", "pty.shells").json(200, array),
  http.protected.get("/pty", "pty.list").json(200, array),
  http.protected
    .post("/pty", "pty.create")
    .mutating()
    .at((ctx) => ({ path: "/pty", headers: ctx.headers(), body: controlledPtyInput("HTTP API PTY") }))
    .json(
      200,
      (body, ctx) => {
        object(body)
        check(body.title === "HTTP API PTY", "PTY create should return requested title")
        check(
          body.command === controlledPtyInput(undefined).command,
          "PTY create should use the platform-controlled shell command",
        )
        check(body.cwd === ctx.directory, "PTY create should default cwd to scenario directory")
      },
      "status",
    ),
  http.protected
    .post("/pty", "pty.create.invalid")
    .at((ctx) => ({ path: "/pty", headers: ctx.headers(), body: { command: 1 } }))
    .status(400),
  http.protected
    .post("/pty/{ptyID}/connect-token", "pty.connectToken.invalid")
    .at((ctx) => ({
      path: route("/pty/{ptyID}/connect-token", { ptyID: "pty_httpapi_missing" }),
      headers: ctx.headers(),
    }))
    .status(403, undefined, "status"),
  http.protected
    .get("/pty/{ptyID}", "pty.get")
    .at((ctx) => ({ path: route("/pty/{ptyID}", { ptyID: "pty_httpapi_missing" }), headers: ctx.headers() }))
    .status(404),
  http.protected
    .put("/pty/{ptyID}", "pty.update")
    .mutating()
    .at((ctx) => ({
      path: route("/pty/{ptyID}", { ptyID: "pty_httpapi_missing" }),
      headers: ctx.headers(),
      body: { size: { rows: 0, cols: 0 } },
    }))
    .status(400),
  http.protected
    .delete("/pty/{ptyID}", "pty.remove")
    .mutating()
    .at((ctx) => ({ path: route("/pty/{ptyID}", { ptyID: "pty_httpapi_missing" }), headers: ctx.headers() }))
    .json(404, object, "status"),
  http.protected
    .get("/pty/{ptyID}/connect", "pty.connect")
    .at((ctx) => ({ path: route("/pty/{ptyID}/connect", { ptyID: "pty_httpapi_missing" }), headers: ctx.headers() }))
    .status(404, undefined, "none"),
  http.protected.get("/experimental/console", "experimental.console.get").json(),
  http.protected.get("/experimental/console/orgs", "experimental.console.listOrgs").json(),
  http.protected
    .post("/experimental/console/switch", "experimental.console.switchOrg")
    .at((ctx) => ({
      path: "/experimental/console/switch",
      headers: ctx.headers(),
      body: { accountID: "httpapi-account", orgID: "httpapi-org" },
    }))
    .status(400, undefined, "none"),
  http.protected.get("/experimental/workspace/adapter", "experimental.workspace.adapter.list").json(200, array),
  http.protected.get("/experimental/workspace", "experimental.workspace.list").json(200, array),
  http.protected.get("/experimental/workspace/status", "experimental.workspace.status").json(200, array),
  http.protected
    .post("/experimental/workspace/root-mutation", "experimental.workspace.rootMutation")
    .at((ctx) => ({
      path: "/experimental/workspace/root-mutation",
      headers: ctx.headers(),
      body: { action: "trust", target: ctx.directory },
    }))
    // The production Core writer is intentionally disabled until all five
    // persistence/recovery/invariant gates have production evidence. Coverage
    // proves the route is wired and returns a typed fail-closed result rather
    // than silently reviving the Python writer.
    .json(409, (body) => {
      object(body)
      check(body.name === "WorkspaceRootMutationError", "workspace root mutation should expose its typed error")
      object(body.data)
      check(body.data.reason === "writer_disabled", "workspace root mutation should report writer_disabled")
      check(
        body.data.owner === "typescript-core-workspace-root-writer",
        "workspace root mutation should report its owner",
      )
      check(
        Array.isArray(body.data.blocking) && body.data.blocking.includes("runtime-invariant"),
        "workspace root mutation should expose blocking Core gates",
      )
      check(
        typeof body.data.message === "string" && body.data.message.includes("no Python writer fallback"),
        "workspace root mutation must not fall back to Python",
      )
    }),
  http.protected
    .post("/experimental/workspace", "experimental.workspace.create")
    .at((ctx) => ({ path: "/experimental/workspace", headers: ctx.headers(), body: {} }))
    .status(400),
  http.protected
    .post("/experimental/workspace/sync-list", "experimental.workspace.syncList")
    .status(204, undefined, "status"),
  http.protected
    .delete("/experimental/workspace/{id}", "experimental.workspace.remove")
    .mutating()
    .at((ctx) => ({
      path: route("/experimental/workspace/{id}", { id: "wrk_httpapi_missing" }),
      headers: ctx.headers(),
    }))
    .status(200),
  http.protected
    .post("/experimental/workspace/warp", "experimental.workspace.warp")
    .at((ctx) => ({
      path: "/experimental/workspace/warp",
      headers: ctx.headers(),
      body: {},
    }))
    .status(400),
  http.protected
    .post("/experimental/control-plane/move-session", "experimental.controlPlane.moveSession")
    .global()
    .at(() => ({
      path: "/experimental/control-plane/move-session",
      body: {},
    }))
    .status(400),
  http.protected
    .get("/experimental/tool", "tool.list")
    .at((ctx) => ({
      path: `/experimental/tool?${new URLSearchParams({ provider: "arforge", model: "test" })}`,
      headers: ctx.headers(),
    }))
    .json(200, array, "status"),
  http.protected.get("/experimental/tool/ids", "tool.ids").json(200, array),
  http.protected.get("/experimental/worktree", "worktree.list").json(200, array),
  http.protected
    .post("/experimental/worktree", "worktree.create")
    .mutating()
    .at((ctx) => ({
      path: "/experimental/worktree",
      headers: ctx.headers(),
      body: { requestID: "cpr_httpapi_create", name: "api-dsl" },
    }))
    .jsonEffect(200, (body, ctx) =>
      Effect.gen(function* () {
        controlOperationStatus(body, "worktree.create")
        const completed = yield* approveControlOperation(ctx, "cpr_httpapi_create", "worktree.create")
        object(completed.result)
        check(typeof completed.result.directory === "string", "created worktree should include its directory")
        yield* ctx.worktreeRemove(completed.result.directory)
      }),
    ),
  http.protected
    .post("/experimental/worktree", "worktree.create.invalid")
    .at((ctx) => ({ path: "/experimental/worktree", headers: ctx.headers(), body: { name: 1 } }))
    .status(400),
  http.protected
    .delete("/experimental/worktree", "worktree.remove")
    .mutating()
    .at((ctx) => ({
      path: "/experimental/worktree",
      headers: ctx.headers(),
      body: { requestID: "cpr_httpapi_remove", directory: path.join(ctx.directory ?? "", "legacy-worktree") },
    }))
    .json(400, (body) => {
      object(body)
      check(body.name === "WorktreeOwnershipFailedError", "legacy worktree removal should fail closed")
    }),
  http.protected
    .post("/experimental/worktree/reset", "worktree.reset")
    .mutating()
    .at((ctx) => ({
      path: "/experimental/worktree/reset",
      headers: ctx.headers(),
      body: { requestID: "cpr_httpapi_reset", directory: path.join(ctx.directory ?? "", "legacy-worktree") },
    }))
    .json(400, (body) => {
      object(body)
      check(body.name === "WorktreeResetFailedError", "unknown worktree reset should fail closed")
    }),
  http.protected
    .get("/experimental/session", "experimental.session.list")
    .at((ctx) => ({ path: "/experimental/session?roots=false&archived=false", headers: ctx.headers() }))
    .json(200, array),
  http.protected.get("/experimental/capabilities", "experimental.capabilities.get").json(200, (body) => {
    check(typeof body === "object" && body !== null, "capabilities should be an object")
    check("backgroundSubagents" in body, "capabilities should report background subagents")
  }),
  http.protected
    .post("/experimental/session/{sessionID}/background", "experimental.session.background")
    .mutating()
    .seeded((ctx) => ctx.session({ title: "Background route owner" }))
    .at((ctx) => ({
      path: route("/experimental/session/{sessionID}/background", { sessionID: ctx.state.id }),
      headers: ctx.headers(),
    }))
    .json(200, (body) => {
      check(body === false, "background route should be a no-op without running subagents")
    }),
  http.protected
    .post("/experimental/session/{sessionID}/revert", "session.revert.control")
    .mutating()
    .at((ctx) => ({
      path: route("/experimental/session/{sessionID}/revert", { sessionID: "ses_httpapi_missing" }),
      headers: ctx.headers(),
      body: {},
    }))
    .status(400),
  http.protected
    .post("/experimental/session/{sessionID}/unrevert", "session.unrevert.control")
    .mutating()
    .at((ctx) => ({
      path: route("/experimental/session/{sessionID}/unrevert", { sessionID: "ses_httpapi_missing" }),
      headers: ctx.headers(),
      body: {},
    }))
    .status(400),
  http.protected
    .post("/experimental/session/{sessionID}/share", "session.share.control")
    .mutating()
    .at((ctx) => ({
      path: route("/experimental/session/{sessionID}/share", { sessionID: "ses_httpapi_missing" }),
      headers: ctx.headers(),
      body: {},
    }))
    .status(400),
  http.protected
    .post("/experimental/session/{sessionID}/unshare", "session.unshare.control")
    .mutating()
    .at((ctx) => ({
      path: route("/experimental/session/{sessionID}/unshare", { sessionID: "ses_httpapi_missing" }),
      headers: ctx.headers(),
      body: {},
    }))
    .status(400),
  http.protected.get("/experimental/resource", "experimental.resource.list").json(),
  http.protected
    .post("/sync/history", "sync.history.list")
    .at((ctx) => ({ path: "/sync/history", headers: ctx.headers(), body: {} }))
    .json(200, array),
  http.protected
    .post("/sync/replay", "sync.replay")
    .at((ctx) => ({ path: "/sync/replay", headers: ctx.headers(), body: { directory: ctx.directory, events: [] } }))
    .status(400),
  http.protected
    .post("/sync/steal", "sync.steal.invalid")
    .at((ctx) => ({ path: "/sync/steal", headers: ctx.headers(), body: {} }))
    .status(400, undefined, "status"),
  http.protected
    .post("/sync/start", "sync.start")
    .mutating()
    .preserveDatabase()
    .json(200, (body) => {
      check(body === true, "sync start should return true when no workspace sessions exist")
    }),
  http.protected
    .post("/instance/dispose", "instance.dispose")
    .mutating()
    .json(200, (body) => {
      check(body === true, "instance dispose should return true")
    }),
  http.protected
    .post("/log", "app.log")
    .global()
    .at(() => ({ path: "/log", body: { service: "httpapi-exercise", level: "info", message: "route coverage" } }))
    .json(200, (body) => {
      check(body === true, "log route should return true")
    }),
  http.protected
    .put("/auth/{providerID}", "auth.set")
    .global()
    .at(() => ({ path: route("/auth/{providerID}", { providerID: "test" }), body: { type: "api", key: "test-key" } }))
    .jsonEffect(200, (body) =>
      Effect.gen(function* () {
        check(body === true, "auth set should return true")
        const auth = yield* Effect.promise(() => Bun.file(exerciseAuthFile).json())
        object(auth)
        check(auth.kind === "arforge-protected-json", "auth set should write a protected envelope")
        check(auth.schema_version === 1, "auth set should write the current protected schema")
        check(typeof auth.ciphertext === "string" && auth.ciphertext.length > 0, "auth set should write ciphertext")
        check(!JSON.stringify(auth).includes("test-key"), "auth set should not persist plaintext credentials")
      }),
    ),
  http.protected
    .delete("/auth/{providerID}", "auth.remove")
    .global()
    .seeded(() =>
      Effect.promise(() => Bun.write(exerciseAuthFile, JSON.stringify({ test: { type: "api", key: "remove-me" } }))),
    )
    .at(() => ({ path: route("/auth/{providerID}", { providerID: "test" }) }))
    .jsonEffect(200, (body) =>
      Effect.gen(function* () {
        check(body === true, "auth remove should return true")
        const auth = yield* Effect.promise(() => Bun.file(exerciseAuthFile).json())
        object(auth)
        check(auth.kind === "arforge-protected-json", "auth remove should preserve the protected envelope")
        check(auth.schema_version === 1, "auth remove should write the current protected schema")
        check(
          !JSON.stringify(auth).includes("remove-me"),
          "auth remove should not preserve removed plaintext credentials",
        )
      }),
    ),
  http.protected.get("/api/health", "v2.health.get").json(200, (body) => {
    object(body)
    check(body.healthy === true, "v2 server should report healthy")
  }),
  http.protected.get("/api/location", "v2.location.get").json(200, object),
  http.protected.get("/api/agent", "v2.agent.list").json(200, locationData(array)),
  http.protected.get("/api/agent-capabilities/health", "v2.agentCapability.health").json(
    200,
    locationData((body) => {
      object(body)
      check(body.status === "ok", "Python Agent capability service should be healthy")
      check(body.brand === "Arforge Agent", "Python Agent capability service should use the Arforge brand")
    }),
  ),
  http.protected.get("/api/agent-capabilities", "v2.agentCapability.list").json(
    200,
    locationData((body) => {
      object(body)
      array(body.items)
      check(body.count === body.items.length, "Python Agent capability count should match its items")
      check(body.items.length > 0, "Python Agent should expose preserved capabilities")
    }),
  ),
  http.protected.get("/api/agent-capabilities/system-overview", "v2.agentCapability.systemOverview").json(
    200,
    locationData((body) => {
      object(body)
      array(body.sections)
      check(body.schema_version === 1, "system overview should expose schema version 1")
      check(body.sections.length > 0, "system overview should expose safe read-only sections")
      const cost = (body.sections as Array<{ id?: unknown; data?: unknown }>).find(
        (section) => section.id === "cost-optimization",
      )
      check(isRecord(cost), "system overview should expose the cost-optimization contract section")
      check(isRecord(cost.data), "cost-optimization section should expose a structured contract audit")
      check(
        cost.data.execution_mode === "read-only-cost-optimization-contract-audit",
        "cost-optimization audit should be read-only",
      )
      check(cost.data.status === "not_ready", "cost-optimization audit should remain fail-closed")
      check(cost.data.side_effects === "none", "cost-optimization audit should declare no side effects")
    }),
  ),
  http.protected.get("/api/agent-capabilities/deep-insights", "v2.agentCapability.deepInsights").json(
    200,
    locationData((body) => {
      object(body)
      array(body.sections)
      check(body.schema_version === 1, "deep insights should expose schema version 1")
      const sections = body.sections as Array<{ id?: unknown; data?: unknown }>
      check(
        sections.some((section) => section.id === "features"),
        "deep insights should expose the typed feature policy section",
      )
      const fileState = sections.find((section) => section.id === "file-state")
      check(isRecord(fileState), "deep insights should expose the file-state contract section")
      check(isRecord(fileState.data), "file-state section should expose a structured contract audit")
      check(
        fileState.data.execution_mode === "read-only-file-state-contract-audit",
        "file-state audit should be read-only",
      )
      check(
        fileState.data.status === "not_ready",
        "file-state audit should remain fail-closed until the owner is complete",
      )
      check(fileState.data.side_effects === "none", "file-state audit should declare no side effects")
      const memoryFeedback = sections.find((section) => section.id === "memory-feedback")
      check(isRecord(memoryFeedback), "deep insights should expose the memory-feedback contract section")
      check(isRecord(memoryFeedback.data), "memory-feedback section should expose a structured contract audit")
      check(
        memoryFeedback.data.execution_mode === "read-only-memory-feedback-contract-audit",
        "memory-feedback audit should be read-only",
      )
      check(memoryFeedback.data.status === "not_ready", "memory-feedback audit should remain fail-closed")
      check(memoryFeedback.data.side_effects === "none", "memory-feedback audit should declare no side effects")
      const featurePolicy = sections.find((section) => section.id === "feature-policy-contract")
      check(isRecord(featurePolicy), "deep insights should expose the feature-policy contract section")
      check(isRecord(featurePolicy.data), "feature-policy section should expose a structured contract audit")
      check(
        featurePolicy.data.execution_mode === "read-only-feature-policy-contract-audit",
        "feature-policy audit should be read-only",
      )
      check(featurePolicy.data.status === "not_ready", "feature-policy audit should remain fail-closed")
      check(featurePolicy.data.side_effects === "none", "feature-policy audit should declare no side effects")
      const permissionPolicy = sections.find((section) => section.id === "permission-policy-contract")
      check(isRecord(permissionPolicy), "deep insights should expose the permission-policy contract section")
      check(isRecord(permissionPolicy.data), "permission-policy section should expose a structured contract audit")
      check(
        permissionPolicy.data.execution_mode === "read-only-permission-policy-contract-audit",
        "permission-policy audit should be read-only",
      )
      check(permissionPolicy.data.status === "not_ready", "permission-policy audit should remain fail-closed")
      check(permissionPolicy.data.side_effects === "none", "permission-policy audit should declare no side effects")
      for (const id of ["file-state", "memory-feedback", "feature-policy-contract", "permission-policy-contract"]) {
        const section = sections.find((candidate) => candidate.id === id)
        check(isRecord(section), `${id} should remain available for the shared boundary projection`)
        check(isRecord(section.data), `${id} should expose the shared execution boundary`)
        const boundary = section.data.execution_boundary
        check(isRecord(boundary), `${id} execution boundary should be structured`)
        check(boundary.mode === "read-only", `${id} execution boundary should be read-only`)
        check(boundary.writes === false, `${id} execution boundary should report writes=false`)
        check(boundary.repairs_recovery === false, `${id} execution boundary should not repair recovery`)
        check(
          boundary.provider_execution_allowed === false,
          `${id} execution boundary should forbid Provider execution`,
        )
        check(boundary.creates_profile_state === false, `${id} execution boundary should not create profile state`)
        check(
          boundary.creates_settlement_state === false,
          `${id} execution boundary should not create settlement state`,
        )
      }
    }),
  ),
  http.protected
    .post("/api/agent-capabilities/repository-scale", "v2.agentCapability.repoScale")
    .at((ctx) => ({
      path: "/api/agent-capabilities/repository-scale",
      headers: ctx.headers(),
      body: { path: ".", maxFiles: 100, limit: 5 },
    }))
    .json(200, locationData(object)),
  http.protected.get("/api/agent-capabilities/runs", "v2.agentCapability.runList").json(200, locationData(object)),
  http.protected
    .get("/api/agent-capabilities/run-report", "v2.agentCapability.runReport")
    .json(200, locationData(object)),
  http.protected
    .post("/api/agent-capabilities/quality", "v2.agentCapability.qualityAssess")
    .at((ctx) => ({
      path: "/api/agent-capabilities/quality",
      headers: ctx.headers(),
      body: { files: ["package.json"] },
    }))
    .json(200, locationData(object)),
  http.protected.get("/api/agent-capabilities/skills", "v2.agentCapability.skillList").json(200, locationData(object)),
  http.protected
    .get("/api/agent-capabilities/skills/{skillID}", "v2.agentCapability.skillRead")
    .at((ctx) => ({
      path: "/api/agent-capabilities/skills/openspec?maxChars=60000",
      headers: ctx.headers(),
    }))
    .json(200, locationData(object)),
  http.protected
    .post("/api/agent-capabilities/skills/route", "v2.agentCapability.skillRoute")
    .at((ctx) => ({
      path: "/api/agent-capabilities/skills/route",
      headers: ctx.headers(),
      body: { request: "Implement and test a material cross-component feature." },
    }))
    .json(200, locationData(object)),
  http.protected
    .post("/api/agent-capabilities/skills/{skillID}/enabled", "v2.agentCapability.skillSetEnabled")
    .at((ctx) => ({
      path: "/api/agent-capabilities/skills/openspec/enabled",
      headers: ctx.headers(),
      body: { enabled: true },
    }))
    .json(200, locationData(object)),
  http.protected
    .post("/api/agent-capabilities/skills/refresh", "v2.agentCapability.skillRefresh")
    .at((ctx) => ({ path: "/api/agent-capabilities/skills/refresh", headers: ctx.headers(), body: {} }))
    .json(200, locationData(object)),
  http.protected
    .get("/api/agent-capabilities/plugins", "v2.agentCapability.pluginList")
    .json(200, locationData(object)),
  http.protected.get("/api/agent-capabilities/customizations", "v2.agentCapability.customizationList").status(400),
  http.protected
    .post("/api/agent-capabilities/customizations/render", "v2.agentCapability.customizationRender")
    .at((ctx) => ({
      path: "/api/agent-capabilities/customizations/render",
      headers: ctx.headers(),
      body: { name: "missing", args: "test" },
    }))
    .status(400),
  http.protected
    .post("/api/agent-capabilities/plugins/{name}/enabled", "v2.agentCapability.pluginSetEnabled")
    .at((ctx) => ({
      path: "/api/agent-capabilities/plugins/missing/enabled",
      headers: ctx.headers(),
      body: { enabled: false },
    }))
    .status(400),
  http.protected
    .post("/api/agent-capabilities/plugins/install/inspect", "v2.agentCapability.pluginInspect")
    .at((ctx) => ({
      path: "/api/agent-capabilities/plugins/install/inspect",
      headers: ctx.headers(),
      body: { source: "./missing-plugin" },
    }))
    .status(400),
  http.protected
    .post("/api/agent-capabilities/plugins/install/apply", "v2.agentCapability.pluginApply")
    .at((ctx) => ({
      path: "/api/agent-capabilities/plugins/install/apply",
      headers: ctx.headers(),
      body: { token: "missing", name: "", replace: false },
    }))
    .status(400),
  http.protected
    .post("/api/agent-capabilities/plugins/{name}/remove", "v2.agentCapability.pluginRemove")
    .at((ctx) => ({
      path: "/api/agent-capabilities/plugins/missing/remove",
      headers: ctx.headers(),
      body: {},
    }))
    .status(400),
  http.protected
    .post("/api/agent-capabilities/plugins/restore", "v2.agentCapability.pluginRestore")
    .at((ctx) => ({
      path: "/api/agent-capabilities/plugins/restore",
      headers: ctx.headers(),
      body: { recoveryID: "missing" },
    }))
    .status(400),
  http.protected
    .get("/api/agent-capabilities/workflows", "v2.agentCapability.workflowList")
    .json(200, locationData(object)),
  http.protected
    .post("/api/agent-capabilities/workflows/preview", "v2.agentCapability.workflowPreview")
    .at((ctx) => ({
      path: "/api/agent-capabilities/workflows/preview",
      headers: ctx.headers(),
      body: { path: ".arforge/workflows/missing.json" },
    }))
    .status(400),
  http.protected
    .get("/api/agent-capabilities/workflow-runs", "v2.agentCapability.workflowRunList")
    .json(200, locationData(object)),
  http.protected
    .get("/api/agent-capabilities/workflow-runs/{runID}", "v2.agentCapability.workflowRunGet")
    .at((ctx) => ({
      path: "/api/agent-capabilities/workflow-runs/missing",
      headers: ctx.headers(),
    }))
    .status(400),
  http.protected
    .get("/api/agent-capabilities/workflow-runs/{runID}/events", "v2.agentCapability.workflowRunEvents")
    .at((ctx) => ({
      path: "/api/agent-capabilities/workflow-runs/missing/events?after=0&limit=200",
      headers: ctx.headers(),
    }))
    .status(400),
  http.protected
    .post("/api/agent-capabilities/plan-preview", "v2.agentCapability.planPreview")
    .at((ctx) => ({
      path: "/api/agent-capabilities/plan-preview",
      headers: ctx.headers(),
      body: {
        task: "Audit the control center",
        planText: "- Inspect the mapping contract\n- Run regression tests\n- Keep a rollback path",
      },
    }))
    .status(400),
  http.protected
    .get("/api/agent-capabilities/runs/{runID}/trace", "v2.agentCapability.runTraceExport")
    .at((ctx) => ({
      path: "/api/agent-capabilities/runs/missing/trace",
      headers: ctx.headers(),
    }))
    .status(503),
  http.protected
    .post("/api/agent-capabilities/workflow-runs/start", "v2.agentCapability.workflowStart")
    .at((ctx) => ({
      path: "/api/agent-capabilities/workflow-runs/start",
      headers: ctx.headers(),
      body: { path: ".arforge/workflows/missing.json", permissionMode: "plan", maxParallel: 1 },
    }))
    .status(400),
  http.protected
    .post("/api/agent-capabilities/workflow-runs/{runID}/control", "v2.agentCapability.workflowControl")
    .at((ctx) => ({
      path: "/api/agent-capabilities/workflow-runs/missing/control",
      headers: ctx.headers(),
      body: { action: "pause" },
    }))
    .status(400),
  http.protected
    .post("/api/agent-capabilities/workflow-runs/{runID}/approve", "v2.agentCapability.workflowApprove")
    .at((ctx) => ({
      path: "/api/agent-capabilities/workflow-runs/missing/approve",
      headers: ctx.headers(),
      body: { nodeID: "gate", approved: true },
    }))
    .status(400),
  http.protected
    .post("/api/agent-capabilities/workflow-runs/{runID}/retry", "v2.agentCapability.workflowRetry")
    .at((ctx) => ({
      path: "/api/agent-capabilities/workflow-runs/missing/retry",
      headers: ctx.headers(),
      body: { nodeID: "node", includeDescendants: true },
    }))
    .status(400),
  http.protected
    .get("/api/agent-capabilities/evolution/status", "v2.agentCapability.evolutionStatus")
    .json(200, locationData(object)),
  http.protected
    .get("/api/agent-capabilities/evolution/candidates", "v2.agentCapability.evolutionCandidates")
    .at((ctx) => ({
      path: "/api/agent-capabilities/evolution/candidates?status=proposed&limit=20",
      headers: ctx.headers(),
    }))
    .json(200, locationData(object)),
  http.protected
    .get("/api/agent-capabilities/evolution/exposures", "v2.agentCapability.evolutionExposures")
    .json(200, locationData(object)),
  http.protected
    .get("/api/agent-capabilities/evolution/exposures/archive", "v2.agentCapability.evolutionExposureArchivePreview")
    .at((ctx) => ({
      path: "/api/agent-capabilities/evolution/exposures/archive?keepRecorded=10",
      headers: ctx.headers(),
    }))
    .json(200, locationData(object)),
  http.protected
    .get("/api/agent-capabilities/evolution/exposures/archives", "v2.agentCapability.evolutionExposureArchives")
    .json(200, locationData(object)),
  http.protected
    .get(
      "/api/agent-capabilities/evolution/exposures/archives/{archiveID}",
      "v2.agentCapability.evolutionExposureArchiveGet",
    )
    .at((ctx) => ({
      path: "/api/agent-capabilities/evolution/exposures/archives/xa-000000000000000000000000",
      headers: ctx.headers(),
    }))
    .status(503),
  http.protected
    .get(
      "/api/agent-capabilities/evolution/exposures/archives/{archiveID}/export",
      "v2.agentCapability.evolutionExposureArchiveExport",
    )
    .at((ctx) => ({
      path: "/api/agent-capabilities/evolution/exposures/archives/xa-000000000000000000000000/export",
      headers: ctx.headers(),
    }))
    .status(503),
  http.protected
    .get(
      "/api/agent-capabilities/evolution/exposures/archives/{archiveID}/restore",
      "v2.agentCapability.evolutionExposureRestorePreview",
    )
    .at((ctx) => ({
      path: "/api/agent-capabilities/evolution/exposures/archives/xa-000000000000000000000000/restore",
      headers: ctx.headers(),
    }))
    .status(503),
  http.protected
    .get("/api/agent-capabilities/evolution/audit/events", "v2.agentCapability.evolutionAuditEvents")
    .at((ctx) => ({
      path: "/api/agent-capabilities/evolution/audit/events?limit=20&beforeSequence=100",
      headers: ctx.headers(),
    }))
    .json(200, locationData(object)),
  http.protected
    .get("/api/agent-capabilities/evolution/candidates/{candidateID}", "v2.agentCapability.evolutionCandidateGet")
    .seeded(apiEvolutionCandidate)
    .at((ctx) => ({
      path: route("/api/agent-capabilities/evolution/candidates/{candidateID}", {
        candidateID: ctx.state.id,
      }),
      headers: ctx.headers(),
    }))
    .mutating()
    .json(200, locationData(object)),
  http.protected
    .get(
      "/api/agent-capabilities/evolution/candidates/{candidateID}/canary",
      "v2.agentCapability.evolutionCanaryReport",
    )
    .seeded(apiEvolutionCandidate)
    .at((ctx) => ({
      path: route("/api/agent-capabilities/evolution/candidates/{candidateID}/canary", {
        candidateID: ctx.state.id,
      }),
      headers: ctx.headers(),
    }))
    .mutating()
    .json(200, locationData(object)),
  http.protected
    .get("/api/agent-capabilities/evolution/opportunities", "v2.agentCapability.evolutionOpportunities")
    .at((ctx) => ({
      path: "/api/agent-capabilities/evolution/opportunities?limit=20",
      headers: ctx.headers(),
    }))
    .json(200, locationData(object)),
  http.protected
    .post("/api/agent-capabilities/evolution/candidates", "v2.agentCapability.evolutionCreate")
    .at((ctx) => ({
      path: "/api/agent-capabilities/evolution/candidates",
      headers: ctx.headers(),
      body: {
        title: "HTTP API candidate creation",
        target: "tool.advice",
        instruction: "Keep tool advice bounded by the explicit contract.",
        rationale: "This scenario verifies governed candidate admission.",
        evidenceRefs: ["httpapi-exercise", "contract-test"],
      },
    }))
    .mutating()
    .json(200, locationData(object)),
  http.protected
    .post("/api/agent-capabilities/evolution/patterns/{patternID}/candidate", "v2.agentCapability.evolutionFromPattern")
    .at((ctx) => ({
      path: "/api/agent-capabilities/evolution/patterns/1/candidate",
      headers: ctx.headers(),
    }))
    .status(503),
  http.protected
    .post(
      "/api/agent-capabilities/evolution/candidates/{candidateID}/transition",
      "v2.agentCapability.evolutionTransition",
    )
    .seeded(apiEvolutionCandidate)
    .at((ctx) => ({
      path: route("/api/agent-capabilities/evolution/candidates/{candidateID}/transition", {
        candidateID: ctx.state.id,
      }),
      headers: ctx.headers(),
      body: { action: "evaluate", expectedRevision: ctx.state.revision },
    }))
    .mutating()
    .json(200, locationData(object)),
  http.protected
    .post(
      "/api/agent-capabilities/evolution/exposures/archive/apply",
      "v2.agentCapability.evolutionExposureArchiveApply",
    )
    .at((ctx) => ({
      path: "/api/agent-capabilities/evolution/exposures/archive/apply",
      headers: ctx.headers(),
      body: { keepRecorded: 10, expectedPlanDigest: "0".repeat(64), reason: "HTTP API exercise" },
    }))
    .status(503),
  http.protected
    .post(
      "/api/agent-capabilities/evolution/exposures/archives/{archiveID}/restore/apply",
      "v2.agentCapability.evolutionExposureRestoreApply",
    )
    .at((ctx) => ({
      path: "/api/agent-capabilities/evolution/exposures/archives/xa-000000000000000000000000/restore/apply",
      headers: ctx.headers(),
      body: { expectedPlanDigest: "0".repeat(64), reason: "HTTP API exercise" },
    }))
    .status(503),
  http.protected
    .post("/api/agent-capabilities/evolution/context", "v2.agentCapability.evolutionContextPreview")
    .at((ctx) => ({
      path: "/api/agent-capabilities/evolution/context",
      headers: ctx.headers(),
      body: { userInput: "review the current task safely", cohortKey: "httpapi-exercise" },
    }))
    .json(200, locationData(object)),
  http.protected.get("/api/model", "v2.model.list").json(200, locationData(array)),
  http.protected.get("/api/provider", "v2.provider.list").json(200, locationData(array)),
  http.protected.get("/api/integration", "v2.integration.list").json(200, locationData(array)),
  http.protected
    .get("/api/integration/{integrationID}", "v2.integration.get")
    .at((ctx) => ({
      path: route("/api/integration/{integrationID}", { integrationID: "missing" }),
      headers: ctx.headers(),
    }))
    .json(200, object),
  http.protected
    .post("/api/integration/{integrationID}/connect/key", "v2.integration.connect.key")
    .at((ctx) => ({
      path: route("/api/integration/{integrationID}/connect/key", { integrationID: "missing" }),
      headers: ctx.headers(),
      body: { key: "test" },
    }))
    .status(500, undefined, "status"),
  http.protected
    .post("/api/integration/{integrationID}/connect/oauth", "v2.integration.connect.oauth")
    .at((ctx) => ({
      path: route("/api/integration/{integrationID}/connect/oauth", { integrationID: "missing" }),
      headers: ctx.headers(),
      body: { methodID: "missing", inputs: {} },
    }))
    .status(500, undefined, "status"),
  http.protected
    .get("/api/integration/attempt/{attemptID}", "v2.integration.attempt.status")
    .at((ctx) => ({
      path: route("/api/integration/attempt/{attemptID}", { attemptID: "con_missing" }),
      headers: ctx.headers(),
    }))
    .status(500, undefined, "status"),
  http.protected
    .post("/api/integration/attempt/{attemptID}/complete", "v2.integration.attempt.complete")
    .at((ctx) => ({
      path: route("/api/integration/attempt/{attemptID}/complete", { attemptID: "con_missing" }),
      headers: ctx.headers(),
      body: {},
    }))
    .status(500, undefined, "status"),
  http.protected
    .delete("/api/integration/attempt/{attemptID}", "v2.integration.attempt.cancel")
    .at((ctx) => ({
      path: route("/api/integration/attempt/{attemptID}", { attemptID: "con_missing" }),
      headers: ctx.headers(),
    }))
    .status(204, undefined, "status"),
  http.protected
    .delete("/api/credential/{credentialID}", "v2.credential.remove")
    .at((ctx) => ({
      path: route("/api/credential/{credentialID}", { credentialID: "cred_missing" }),
      headers: ctx.headers(),
    }))
    .status(204, undefined, "status"),
  http.protected
    .patch("/api/credential/{credentialID}", "v2.credential.update")
    .at((ctx) => ({
      path: route("/api/credential/{credentialID}", { credentialID: "cred_missing" }),
      headers: ctx.headers(),
      body: { label: "Work" },
    }))
    .status(204, undefined, "status"),
  http.protected.get("/api/command", "v2.command.list").json(200, locationData(array)),
  http.protected.get("/api/skill", "v2.skill.list").json(200, locationData(array)),
  http.protected
    .get("/api/event", "v2.event.subscribe")
    .stream()
    .status(
      200,
      (_ctx, result) =>
        Effect.sync(() => {
          check(result.contentType.includes("text/event-stream"), "v2 event should be an SSE stream")
          check(result.text.includes("server.connected"), "v2 event should emit initial connection event")
          check(!result.text.includes('"location"'), "v2 connection event should not be scoped to a location")
        }),
      "status",
    ),
  http.protected
    .get("/api/fs/read/*", "v2.fs.read")
    .seeded((ctx) => ctx.file("hello.txt", "hello\n"))
    .at((ctx) => ({ path: "/api/fs/read/hello.txt", headers: ctx.headers() }))
    .status(
      200,
      (_ctx, result) =>
        Effect.sync(() => {
          check(result.text === "hello\n", "v2 fs read should return the file body")
          check(result.contentType.includes("text/plain"), "v2 fs read should return the file content type")
        }),
      "status",
    ),
  http.protected.get("/api/fs/list", "v2.fs.list").json(200, locationData(array)),
  http.protected
    .get("/api/fs/find", "v2.fs.find")
    .seeded((ctx) => ctx.file("hello.txt", "hello\n"))
    .at((ctx) => ({ path: "/api/fs/find?query=hello&type=file", headers: ctx.headers() }))
    .json(200, locationData(array)),
  http.protected.get("/api/pty", "v2.pty.list").json(200, locationData(array)),
  http.protected
    .post("/api/pty", "v2.pty.create")
    .mutating()
    .at((ctx) => ({ path: "/api/pty", headers: ctx.headers(), body: controlledPtyInput("HTTP API V2 PTY") }))
    .json(200, locationData(object)),
  http.protected
    .get("/api/pty/{ptyID}", "v2.pty.get")
    .at((ctx) => ({ path: route("/api/pty/{ptyID}", { ptyID: "pty_httpapi_missing" }), headers: ctx.headers() }))
    .json(404, object, "status"),
  http.protected
    .put("/api/pty/{ptyID}", "v2.pty.update")
    .mutating()
    .at((ctx) => ({
      path: route("/api/pty/{ptyID}", { ptyID: "pty_httpapi_missing" }),
      headers: ctx.headers(),
      body: { title: "missing" },
    }))
    .json(404, object, "status"),
  http.protected
    .delete("/api/pty/{ptyID}", "v2.pty.remove")
    .mutating()
    .at((ctx) => ({ path: route("/api/pty/{ptyID}", { ptyID: "pty_httpapi_missing" }), headers: ctx.headers() }))
    .json(404, object, "status"),
  http.protected
    .post("/api/pty/{ptyID}/connect-token", "v2.pty.connectToken")
    .at((ctx) => ({
      path: route("/api/pty/{ptyID}/connect-token", { ptyID: "pty_httpapi_missing" }),
      headers: { ...ctx.headers(), "x-arforge-ticket": "1" },
    }))
    .json(404, object, "status"),
  http.protected
    .get("/api/pty/{ptyID}/connect", "v2.pty.connect")
    .at((ctx) => ({
      path: route("/api/pty/{ptyID}/connect", { ptyID: "pty_httpapi_missing" }),
      headers: ctx.headers(),
    }))
    .status(404, undefined, "none"),
  http.protected.get("/api/reference", "v2.reference.list").json(200, object),
  http.protected
    .get("/api/provider/{providerID}", "v2.provider.get")
    .at((ctx) => ({ path: route("/api/provider/{providerID}", { providerID: "missing" }), headers: ctx.headers() }))
    .json(404, object, "status"),
  http.protected.get("/api/permission/request", "v2.permission.request.list").json(200, (body) => {
    object(body)
    object(body.location)
    array(body.data)
  }),
  http.protected.get("/api/question/request", "v2.question.request.list").json(200, (body) => {
    object(body)
    object(body.location)
    array(body.data)
  }),
  http.protected
    .post("/api/session/{sessionID}/permission", "v2.session.permission.create")
    .seeded((ctx) => ctx.session({ title: "Permission create owner" }))
    .at((ctx) => ({
      path: route("/api/session/{sessionID}/permission", { sessionID: ctx.state.id }),
      headers: ctx.headers(),
      body: { action: "read", resources: [".env"] },
    }))
    .json(200, (body) => {
      object(body)
      object(body.data)
      check(typeof body.data.id === "string", "permission create should return an ID")
      check(body.data.effect === "ask", "permission create should create a pending request")
    }),
  http.protected
    .get("/api/session/{sessionID}/permission", "v2.session.permission.list")
    .seeded((ctx) => ctx.session({ title: "Permission list owner" }))
    .at((ctx) => ({
      path: route("/api/session/{sessionID}/permission", { sessionID: ctx.state.id }),
      headers: ctx.headers(),
    }))
    .json(200, data(array)),
  http.protected
    .get("/api/session/{sessionID}/permission/{requestID}", "v2.session.permission.get")
    .seeded((ctx) => ctx.session({ title: "Permission get owner" }))
    .at((ctx) => ({
      path: route("/api/session/{sessionID}/permission/{requestID}", {
        sessionID: ctx.state.id,
        requestID: "per_httpapi_missing",
      }),
      headers: ctx.headers(),
    }))
    .json(404, object, "status"),
  http.protected
    .get("/api/session/{sessionID}/question", "v2.session.question.list")
    .seeded((ctx) => ctx.session({ title: "Question list owner" }))
    .at((ctx) => ({
      path: route("/api/session/{sessionID}/question", { sessionID: ctx.state.id }),
      headers: ctx.headers(),
    }))
    .json(200, data(array)),
  http.protected
    .post("/api/session/{sessionID}/permission/{requestID}/reply", "v2.session.permission.reply")
    .seeded((ctx) => ctx.session({ title: "Permission owner" }))
    .at((ctx) => ({
      path: route("/api/session/{sessionID}/permission/{requestID}/reply", {
        sessionID: ctx.state.id,
        requestID: "per_httpapi_missing",
      }),
      headers: ctx.headers(),
      body: { reply: "once" },
    }))
    .json(404, object, "status"),
  http.protected
    .post("/api/session/{sessionID}/question/{requestID}/reply", "v2.session.question.reply")
    .seeded((ctx) => ctx.session({ title: "Question reply owner" }))
    .at((ctx) => ({
      path: route("/api/session/{sessionID}/question/{requestID}/reply", {
        sessionID: ctx.state.id,
        requestID: "que_httpapi_missing",
      }),
      headers: ctx.headers(),
      body: { answers: [] },
    }))
    .json(404, object, "status"),
  http.protected
    .post("/api/session/{sessionID}/question/{requestID}/reject", "v2.session.question.reject")
    .seeded((ctx) => ctx.session({ title: "Question reject owner" }))
    .at((ctx) => ({
      path: route("/api/session/{sessionID}/question/{requestID}/reject", {
        sessionID: ctx.state.id,
        requestID: "que_httpapi_missing",
      }),
      headers: ctx.headers(),
    }))
    .json(404, object, "status"),
  http.protected.get("/api/permission/saved", "v2.permission.saved.list").json(200, (body) => {
    object(body)
    array(body.data)
  }),
  http.protected
    .delete("/api/permission/saved/{id}", "v2.permission.saved.remove")
    .at((ctx) => ({ path: route("/api/permission/saved/{id}", { id: "psv_httpapi_missing" }), headers: ctx.headers() }))
    .status(204, undefined, "status"),
  http.protected
    .get("/api/session", "v2.session.list")
    .at((ctx) => ({ path: "/api/session?roots=true", headers: ctx.headers() }))
    .json(
      200,
      (body) => {
        object(body)
        array(body.data)
        object(body.cursor)
      },
      "none",
    ),
  http.protected
    .get("/api/session", "v2.session.list.filters")
    .at((ctx) => ({
      path: `/api/session?${new URLSearchParams({
        limit: "2",
        order: "asc",
        path: ".",
        roots: "false",
        start: "0",
        search: "missing",
        directory: ctx.directory ?? "",
      })}`,
      headers: ctx.headers(),
    }))
    .json(
      200,
      (body) => {
        object(body)
        array(body.data)
        object(body.cursor)
      },
      "none",
    ),
  http.protected
    .get("/api/session", "v2.session.list.cursor")
    .at((ctx) => ({
      path: `/api/session?${new URLSearchParams({
        limit: "2",
        cursor: cursor({
          order: "desc",
          directory: ctx.directory,
          anchor: { id: "ses_httpapi_missing", time: 0, direction: "next" },
        }),
      })}`,
      headers: ctx.headers(),
    }))
    .json(
      200,
      (body) => {
        object(body)
        array(body.data)
        object(body.cursor)
      },
      "none",
    ),
  http.protected
    .get("/api/session", "v2.session.list.cursor.invalid")
    .at((ctx) => ({
      path: `/api/session?${new URLSearchParams({
        cursor: "invalid",
      })}`,
      headers: ctx.headers(),
    }))
    .status(400, undefined, "none"),
  http.protected.get("/api/session/active", "v2.session.active").json(200, data(object), "none"),
  http.protected
    .post("/api/session", "v2.session.create")
    .at((ctx) => ({
      path: "/api/session",
      headers: { ...ctx.headers(), "content-type": "application/json" },
      body: {},
    }))
    .json(200, data(object)),
  http.protected
    .post("/api/session/{sessionID}/goal", "v2.goal.create")
    .seeded(apiSession)
    .at((ctx) => ({
      path: route("/api/session/{sessionID}/goal", { sessionID: ctx.state.id }),
      headers: ctx.headers(),
      body: { objective: "Verify the unified Goal create route" },
    }))
    .mutating()
    .json(200, (body) => {
      object(body)
      object(body.data)
      check(body.data.objective === "Verify the unified Goal create route", "goal create should preserve objective")
      check(body.data.status === "active", "the first goal should become active")
      check(body.data.revision === 1, "a new goal should start at revision 1")
    }),
  http.protected
    .get("/api/session/{sessionID}/goal", "v2.goal.list")
    .seeded((ctx) =>
      Effect.gen(function* () {
        const session = yield* apiSession(ctx)
        const active = yield* apiGoal(ctx, session.id, "Active HTTP goal")
        const queued = yield* apiGoal(ctx, session.id, "Queued HTTP goal", true)
        return { session, active, queued }
      }),
    )
    .at((ctx) => ({
      path: `${route("/api/session/{sessionID}/goal", { sessionID: ctx.state.session.id })}?history=false`,
      headers: ctx.headers(),
    }))
    .mutating()
    .json(200, (body, ctx) => {
      object(body)
      object(body.data)
      object(body.data.active)
      array(body.data.queued)
      check(body.data.active.id === ctx.state.active.id, "goal list should expose the active goal")
      check(body.data.queued.length === 1, "goal list should expose one queued goal")
      object(body.data.queued[0])
      check(body.data.queued[0].id === ctx.state.queued.id, "goal list should preserve queue identity")
    }),
  http.protected
    .get("/api/session/{sessionID}/goal/{goalID}", "v2.goal.get")
    .seeded((ctx) =>
      Effect.gen(function* () {
        const session = yield* apiSession(ctx)
        const goal = yield* apiGoal(ctx, session.id, "Goal HTTP get")
        return { session, goal }
      }),
    )
    .at((ctx) => ({
      path: route("/api/session/{sessionID}/goal/{goalID}", {
        sessionID: ctx.state.session.id,
        goalID: ctx.state.goal.id,
      }),
      headers: ctx.headers(),
    }))
    .mutating()
    .json(200, (body, ctx) => {
      object(body)
      object(body.data)
      check(body.data.id === ctx.state.goal.id, "goal get should return the requested goal")
      check(body.data.objective === "Goal HTTP get", "goal get should return the persisted objective")
    }),
  http.protected
    .post("/api/session/{sessionID}/goal/{goalID}/run", "v2.goal.run")
    .withLlm()
    .seeded((ctx) =>
      Effect.gen(function* () {
        yield* ctx.llmText("Goal execution response")
        const session = yield* apiSession(ctx)
        const goal = yield* apiGoal(ctx, session.id, "Run Goal through the unified queue")
        return { session, goal }
      }),
    )
    .at((ctx) => ({
      path: route("/api/session/{sessionID}/goal/{goalID}/run", {
        sessionID: ctx.state.session.id,
        goalID: ctx.state.goal.id,
      }),
      headers: ctx.headers(),
      body: { expectedRevision: ctx.state.goal.revision },
    }))
    .mutating()
    .jsonEffect(200, (body, ctx) =>
      Effect.gen(function* () {
        object(body)
        object(body.data)
        object(body.data.goal)
        object(body.data.input)
        check(body.data.goal.id === ctx.state.goal.id, "goal run should return the started goal")
        check(body.data.goal.status === "running", "goal run should transition the goal to running")
        check(typeof body.data.input.id === "string", "goal run should enqueue a durable prompt")
        const waited = yield* ctx.api("POST", {
          path: route("/api/session/{sessionID}/wait", { sessionID: ctx.state.session.id }),
          headers: ctx.headers(),
        })
        check(waited.status === 204, `goal run wait expected 204, got ${waited.status}: ${waited.text}`)
        const queued = yield* ctx.api("GET", {
          path: route("/api/session/{sessionID}/prompt/queue", { sessionID: ctx.state.session.id }),
          headers: ctx.headers(),
        })
        check(queued.status === 200, `goal run queue verification expected 200, got ${queued.status}`)
        object(queued.body)
        array(queued.body.data)
        check(queued.body.data.length === 0, "goal run should drain its durable prompt through the mature loop")
      }),
    ),
  http.protected
    .post("/api/session/{sessionID}/goal/{goalID}/pause", "v2.goal.pause")
    .seeded((ctx) =>
      Effect.gen(function* () {
        const session = yield* apiSession(ctx)
        const goal = yield* apiGoal(ctx, session.id, "Pause Goal through HTTP")
        return { session, goal }
      }),
    )
    .at((ctx) => ({
      path: route("/api/session/{sessionID}/goal/{goalID}/pause", {
        sessionID: ctx.state.session.id,
        goalID: ctx.state.goal.id,
      }),
      headers: ctx.headers(),
      body: { expectedRevision: ctx.state.goal.revision },
    }))
    .mutating()
    .json(200, (body) => {
      object(body)
      object(body.data)
      check(body.data.status === "paused", "goal pause should persist paused status")
      check(body.data.revision === 2, "goal pause should advance the revision")
    }),
  http.protected
    .post("/api/session/{sessionID}/goal/{goalID}/resume", "v2.goal.resume")
    .seeded((ctx) =>
      Effect.gen(function* () {
        const session = yield* apiSession(ctx)
        const goal = yield* apiGoal(ctx, session.id, "Resume Goal through HTTP")
        const paused = apiData(
          yield* ctx.api("POST", {
            path: route("/api/session/{sessionID}/goal/{goalID}/pause", {
              sessionID: session.id,
              goalID: goal.id,
            }),
            headers: ctx.headers(),
            body: { expectedRevision: goal.revision },
          }),
          "goal pause seed",
        )
        check(typeof paused.revision === "number", "paused goal should return a revision")
        return { session, goal, pausedRevision: paused.revision }
      }),
    )
    .at((ctx) => ({
      path: route("/api/session/{sessionID}/goal/{goalID}/resume", {
        sessionID: ctx.state.session.id,
        goalID: ctx.state.goal.id,
      }),
      headers: ctx.headers(),
      body: { expectedRevision: ctx.state.pausedRevision },
    }))
    .mutating()
    .json(200, (body) => {
      object(body)
      object(body.data)
      check(body.data.status === "active", "goal resume should return the goal to active")
      check(body.data.revision === 3, "goal resume should advance the paused revision")
    }),
  http.protected
    .post("/api/session/{sessionID}/goal/{goalID}/complete", "v2.goal.complete")
    .seeded((ctx) =>
      Effect.gen(function* () {
        const session = yield* apiSession(ctx)
        const goal = yield* apiGoal(ctx, session.id, "Complete Goal through HTTP")
        return { session, goal }
      }),
    )
    .at((ctx) => ({
      path: route("/api/session/{sessionID}/goal/{goalID}/complete", {
        sessionID: ctx.state.session.id,
        goalID: ctx.state.goal.id,
      }),
      headers: ctx.headers(),
      body: { expectedRevision: ctx.state.goal.revision },
    }))
    .mutating()
    .json(200, (body) => {
      object(body)
      object(body.data)
      check(body.data.status === "completed", "goal complete should persist terminal status")
    }),
  http.protected
    .post("/api/session/{sessionID}/goal/{goalID}/block", "v2.goal.block")
    .seeded((ctx) =>
      Effect.gen(function* () {
        const session = yield* apiSession(ctx)
        const goal = yield* apiGoal(ctx, session.id, "Block Goal through HTTP")
        return { session, goal }
      }),
    )
    .at((ctx) => ({
      path: route("/api/session/{sessionID}/goal/{goalID}/block", {
        sessionID: ctx.state.session.id,
        goalID: ctx.state.goal.id,
      }),
      headers: ctx.headers(),
      body: { expectedRevision: ctx.state.goal.revision, error: "Waiting for user approval" },
    }))
    .mutating()
    .json(200, (body) => {
      object(body)
      object(body.data)
      check(body.data.status === "blocked", "goal block should persist blocked status")
      check(body.data.lastError === "Waiting for user approval", "goal block should persist the blocker")
    }),
  http.protected
    .post("/api/session/{sessionID}/goal/{goalID}/cancel", "v2.goal.cancel")
    .seeded((ctx) =>
      Effect.gen(function* () {
        const session = yield* apiSession(ctx)
        const goal = yield* apiGoal(ctx, session.id, "Cancel Goal through HTTP")
        return { session, goal }
      }),
    )
    .at((ctx) => ({
      path: route("/api/session/{sessionID}/goal/{goalID}/cancel", {
        sessionID: ctx.state.session.id,
        goalID: ctx.state.goal.id,
      }),
      headers: ctx.headers(),
      body: { expectedRevision: ctx.state.goal.revision },
    }))
    .mutating()
    .json(200, (body) => {
      object(body)
      object(body.data)
      check(body.data.status === "cancelled", "goal cancel should persist terminal status")
    }),
  http.protected
    .post("/api/session/{sessionID}/goal/{goalID}/replace", "v2.goal.replace")
    .seeded((ctx) =>
      Effect.gen(function* () {
        const session = yield* apiSession(ctx)
        const goal = yield* apiGoal(ctx, session.id, "Original Goal objective")
        return { session, goal }
      }),
    )
    .at((ctx) => ({
      path: route("/api/session/{sessionID}/goal/{goalID}/replace", {
        sessionID: ctx.state.session.id,
        goalID: ctx.state.goal.id,
      }),
      headers: ctx.headers(),
      body: { expectedRevision: ctx.state.goal.revision, objective: "Replacement Goal objective" },
    }))
    .mutating()
    .json(200, (body) => {
      object(body)
      object(body.data)
      check(body.data.objective === "Replacement Goal objective", "goal replace should persist the new objective")
      check(body.data.revision === 2, "goal replace should advance the revision")
    }),
  http.protected
    .delete("/api/session/{sessionID}/goal/{goalID}", "v2.goal.deleteQueued")
    .seeded((ctx) =>
      Effect.gen(function* () {
        const session = yield* apiSession(ctx)
        yield* apiGoal(ctx, session.id, "Active Goal keeps the queue occupied")
        const queued = yield* apiGoal(ctx, session.id, "Delete queued Goal", true)
        return { session, queued }
      }),
    )
    .at((ctx) => ({
      path: route("/api/session/{sessionID}/goal/{goalID}", {
        sessionID: ctx.state.session.id,
        goalID: ctx.state.queued.id,
      }),
      headers: ctx.headers(),
      body: { expectedRevision: ctx.state.queued.revision },
    }))
    .mutating()
    .status(204),
  http.protected
    .post("/api/session/{sessionID}/goal/reorder", "v2.goal.reorder")
    .seeded((ctx) =>
      Effect.gen(function* () {
        const session = yield* apiSession(ctx)
        yield* apiGoal(ctx, session.id, "Active Goal owns execution")
        const first = yield* apiGoal(ctx, session.id, "First queued Goal", true)
        const second = yield* apiGoal(ctx, session.id, "Second queued Goal", true)
        return { session, first, second }
      }),
    )
    .at((ctx) => ({
      path: route("/api/session/{sessionID}/goal/reorder", { sessionID: ctx.state.session.id }),
      headers: ctx.headers(),
      body: {
        goals: [
          { id: ctx.state.second.id, revision: ctx.state.second.revision },
          { id: ctx.state.first.id, revision: ctx.state.first.revision },
        ],
      },
    }))
    .mutating()
    .json(200, (body, ctx) => {
      object(body)
      object(body.data)
      array(body.data.queued)
      check(body.data.queued.length === 2, "goal reorder should retain every queued goal")
      object(body.data.queued[0])
      object(body.data.queued[1])
      check(body.data.queued[0].id === ctx.state.second.id, "goal reorder should move the second goal first")
      check(body.data.queued[1].id === ctx.state.first.id, "goal reorder should move the first goal second")
    }),
  http.protected
    .post("/api/session/{sessionID}/task", "v2.taskGraph.create")
    .seeded(apiSession)
    .at((ctx) => ({
      path: route("/api/session/{sessionID}/task", { sessionID: ctx.state.id }),
      headers: ctx.headers(),
      body: {
        title: "Verify the unified Task create route",
        description: "Created through the public HTTP contract",
        activeForm: "Verifying Task creation",
        metadata: { source: "httpapi-exercise" },
      },
    }))
    .mutating()
    .json(200, (body) => {
      object(body)
      object(body.data)
      check(body.data.title === "Verify the unified Task create route", "task create should preserve title")
      check(body.data.status === "pending", "a new task should start pending")
      check(body.data.revision === 1, "a new task should start at revision 1")
      object(body.data.metadata)
      check(body.data.metadata.source === "httpapi-exercise", "task create should preserve metadata")
    }),
  http.protected
    .get("/api/session/{sessionID}/task", "v2.taskGraph.list")
    .seeded((ctx) =>
      Effect.gen(function* () {
        const session = yield* apiSession(ctx)
        const first = yield* apiTask(ctx, session.id, "First HTTP task")
        const second = yield* apiTask(ctx, session.id, "Second HTTP task")
        return { session, first, second }
      }),
    )
    .at((ctx) => ({
      path: `${route("/api/session/{sessionID}/task", { sessionID: ctx.state.session.id })}?status=pending&search=HTTP`,
      headers: ctx.headers(),
    }))
    .mutating()
    .json(200, (body, ctx) => {
      object(body)
      object(body.data)
      array(body.data.items)
      check(body.data.total === 2, "task list should return both matching tasks")
      check(
        body.data.items.some((item) => isRecord(item) && item.id === ctx.state.first.id),
        "task list should contain the first task",
      )
      check(
        body.data.items.some((item) => isRecord(item) && item.id === ctx.state.second.id),
        "task list should contain the second task",
      )
    }),
  http.protected
    .get("/api/session/{sessionID}/task/{taskID}", "v2.taskGraph.get")
    .seeded((ctx) =>
      Effect.gen(function* () {
        const session = yield* apiSession(ctx)
        const task = yield* apiTask(ctx, session.id, "Task HTTP get")
        return { session, task }
      }),
    )
    .at((ctx) => ({
      path: route("/api/session/{sessionID}/task/{taskID}", {
        sessionID: ctx.state.session.id,
        taskID: ctx.state.task.id,
      }),
      headers: ctx.headers(),
    }))
    .mutating()
    .json(200, (body, ctx) => {
      object(body)
      object(body.data)
      check(body.data.id === ctx.state.task.id, "task get should return the requested task")
      check(body.data.title === "Task HTTP get", "task get should return the persisted title")
    }),
  http.protected
    .patch("/api/session/{sessionID}/task/{taskID}", "v2.taskGraph.update")
    .seeded((ctx) =>
      Effect.gen(function* () {
        const session = yield* apiSession(ctx)
        const task = yield* apiTask(ctx, session.id, "Original Task title")
        return { session, task }
      }),
    )
    .at((ctx) => ({
      path: route("/api/session/{sessionID}/task/{taskID}", {
        sessionID: ctx.state.session.id,
        taskID: ctx.state.task.id,
      }),
      headers: ctx.headers(),
      body: {
        expectedRevision: ctx.state.task.revision,
        title: "Updated Task title",
        description: "Updated through the public HTTP contract",
      },
    }))
    .mutating()
    .json(200, (body) => {
      object(body)
      object(body.data)
      check(body.data.title === "Updated Task title", "task update should persist title")
      check(
        body.data.description === "Updated through the public HTTP contract",
        "task update should persist description",
      )
      check(body.data.revision === 2, "task update should advance the revision")
    }),
  http.protected
    .post("/api/session/{sessionID}/task/{taskID}/claim", "v2.taskGraph.claim")
    .seeded((ctx) =>
      Effect.gen(function* () {
        const session = yield* apiSession(ctx)
        const task = yield* apiTask(ctx, session.id, "Claim Task through HTTP")
        return { session, task }
      }),
    )
    .at((ctx) => ({
      path: route("/api/session/{sessionID}/task/{taskID}/claim", {
        sessionID: ctx.state.session.id,
        taskID: ctx.state.task.id,
      }),
      headers: ctx.headers(),
      body: { expectedRevision: ctx.state.task.revision, owner: "httpapi-worker" },
    }))
    .mutating()
    .json(200, (body) => {
      object(body)
      object(body.data)
      check(body.data.status === "in_progress", "task claim should transition to in_progress")
      check(body.data.owner === "httpapi-worker", "task claim should persist the owner")
    }),
  http.protected
    .post("/api/session/{sessionID}/task/{taskID}/release", "v2.taskGraph.release")
    .seeded((ctx) =>
      Effect.gen(function* () {
        const session = yield* apiSession(ctx)
        const task = yield* apiTask(ctx, session.id, "Release Task through HTTP")
        const claimed = apiData(
          yield* ctx.api("POST", {
            path: route("/api/session/{sessionID}/task/{taskID}/claim", {
              sessionID: session.id,
              taskID: task.id,
            }),
            headers: ctx.headers(),
            body: { expectedRevision: task.revision, owner: "httpapi-worker" },
          }),
          "task claim seed",
        )
        check(typeof claimed.revision === "number", "claimed task should return a revision")
        return { session, task, claimedRevision: claimed.revision }
      }),
    )
    .at((ctx) => ({
      path: route("/api/session/{sessionID}/task/{taskID}/release", {
        sessionID: ctx.state.session.id,
        taskID: ctx.state.task.id,
      }),
      headers: ctx.headers(),
      body: { expectedRevision: ctx.state.claimedRevision, owner: "httpapi-worker" },
    }))
    .mutating()
    .json(200, (body) => {
      object(body)
      object(body.data)
      check(body.data.status === "pending", "task release should return the task to pending")
      check(body.data.owner === undefined, "task release should clear the owner")
    }),
  http.protected
    .post("/api/session/{sessionID}/task/{taskID}/complete", "v2.taskGraph.complete")
    .seeded((ctx) =>
      Effect.gen(function* () {
        const session = yield* apiSession(ctx)
        const task = yield* apiTask(ctx, session.id, "Complete Task through HTTP")
        return { session, task }
      }),
    )
    .at((ctx) => ({
      path: route("/api/session/{sessionID}/task/{taskID}/complete", {
        sessionID: ctx.state.session.id,
        taskID: ctx.state.task.id,
      }),
      headers: ctx.headers(),
      body: { expectedRevision: ctx.state.task.revision },
    }))
    .mutating()
    .json(200, (body) => {
      object(body)
      object(body.data)
      check(body.data.status === "completed", "task complete should persist terminal status")
    }),
  http.protected
    .post("/api/session/{sessionID}/task/{taskID}/cancel", "v2.taskGraph.cancel")
    .seeded((ctx) =>
      Effect.gen(function* () {
        const session = yield* apiSession(ctx)
        const task = yield* apiTask(ctx, session.id, "Cancel Task through HTTP")
        return { session, task }
      }),
    )
    .at((ctx) => ({
      path: route("/api/session/{sessionID}/task/{taskID}/cancel", {
        sessionID: ctx.state.session.id,
        taskID: ctx.state.task.id,
      }),
      headers: ctx.headers(),
      body: { expectedRevision: ctx.state.task.revision },
    }))
    .mutating()
    .json(200, (body) => {
      object(body)
      object(body.data)
      check(body.data.status === "cancelled", "task cancel should persist terminal status")
    }),
  http.protected
    .delete("/api/session/{sessionID}/task/{taskID}", "v2.taskGraph.delete")
    .seeded((ctx) =>
      Effect.gen(function* () {
        const session = yield* apiSession(ctx)
        const task = yield* apiTask(ctx, session.id, "Delete Task through HTTP")
        return { session, task }
      }),
    )
    .at((ctx) => ({
      path: route("/api/session/{sessionID}/task/{taskID}", {
        sessionID: ctx.state.session.id,
        taskID: ctx.state.task.id,
      }),
      headers: ctx.headers(),
      body: { expectedRevision: ctx.state.task.revision },
    }))
    .mutating()
    .status(204),
  http.protected
    .post("/api/session/{sessionID}/task/clear", "v2.taskGraph.clear")
    .seeded((ctx) =>
      Effect.gen(function* () {
        const session = yield* apiSession(ctx)
        const completed = yield* apiTask(ctx, session.id, "Clear completed Task")
        const pending = yield* apiTask(ctx, session.id, "Keep pending Task")
        yield* ctx.api("POST", {
          path: route("/api/session/{sessionID}/task/{taskID}/complete", {
            sessionID: session.id,
            taskID: completed.id,
          }),
          headers: ctx.headers(),
          body: { expectedRevision: completed.revision },
        })
        return { session, completed, pending }
      }),
    )
    .at((ctx) => ({
      path: route("/api/session/{sessionID}/task/clear", { sessionID: ctx.state.session.id }),
      headers: ctx.headers(),
      body: { terminalOnly: true },
    }))
    .mutating()
    .json(200, (body) => {
      object(body)
      object(body.data)
      check(body.data.deleted === 1, "task clear should delete only the completed task")
    }),
  http.protected
    .get("/api/session/{sessionID}/prompt/queue", "v2.session.promptQueueList")
    .seeded((ctx) =>
      Effect.gen(function* () {
        const session = yield* apiSession(ctx)
        const prompt = yield* apiPrompt(ctx, session.id, "Queued prompt from HTTP")
        return { session, prompt }
      }),
    )
    .at((ctx) => ({
      path: route("/api/session/{sessionID}/prompt/queue", { sessionID: ctx.state.session.id }),
      headers: ctx.headers(),
    }))
    .mutating()
    .json(200, (body, ctx) => {
      object(body)
      array(body.data)
      check(body.data.length === 1, "prompt queue list should return the queued item")
      object(body.data[0])
      check(body.data[0].id === ctx.state.prompt.id, "prompt queue list should preserve message identity")
      object(body.data[0].prompt)
      check(body.data[0].prompt.text === "Queued prompt from HTTP", "prompt queue list should preserve text")
    }),
  http.protected
    .patch("/api/session/{sessionID}/prompt/queue/{messageID}", "v2.session.promptQueueUpdate")
    .seeded((ctx) =>
      Effect.gen(function* () {
        const session = yield* apiSession(ctx)
        const prompt = yield* apiPrompt(ctx, session.id, "Original queued prompt")
        return { session, prompt }
      }),
    )
    .at((ctx) => ({
      path: route("/api/session/{sessionID}/prompt/queue/{messageID}", {
        sessionID: ctx.state.session.id,
        messageID: ctx.state.prompt.id,
      }),
      headers: ctx.headers(),
      body: {
        expectedAdmittedSeq: ctx.state.prompt.admittedSeq,
        prompt: { text: "Updated queued prompt" },
      },
    }))
    .mutating()
    .json(200, (body, ctx) => {
      object(body)
      object(body.data)
      check(body.data.id === ctx.state.prompt.id, "prompt queue update should retain message identity")
      check(
        body.data.admittedSeq === ctx.state.prompt.admittedSeq,
        "prompt queue update should retain FIFO admission position",
      )
      object(body.data.prompt)
      check(body.data.prompt.text === "Updated queued prompt", "prompt queue update should persist text")
    }),
  http.protected
    .delete("/api/session/{sessionID}/prompt/queue/{messageID}", "v2.session.promptQueueRemove")
    .seeded((ctx) =>
      Effect.gen(function* () {
        const session = yield* apiSession(ctx)
        const prompt = yield* apiPrompt(ctx, session.id, "Remove queued prompt")
        return { session, prompt }
      }),
    )
    .at((ctx) => ({
      path: route("/api/session/{sessionID}/prompt/queue/{messageID}", {
        sessionID: ctx.state.session.id,
        messageID: ctx.state.prompt.id,
      }),
      headers: ctx.headers(),
      body: { expectedAdmittedSeq: ctx.state.prompt.admittedSeq },
    }))
    .mutating()
    .status(204, (ctx) =>
      ctx
        .api("GET", {
          path: route("/api/session/{sessionID}/prompt/queue", { sessionID: ctx.state.session.id }),
          headers: ctx.headers(),
        })
        .pipe(
          Effect.map((result) => {
            check(result.status === 200, `prompt queue verification expected 200, got ${result.status}`)
            object(result.body)
            array(result.body.data)
            check(result.body.data.length === 0, "prompt queue remove should leave the queue empty")
          }),
        ),
    ),
  http.protected
    .get("/api/session/{sessionID}", "v2.session.get")
    .seeded((ctx) => ctx.session({ title: "Session get" }))
    .at((ctx) => ({
      path: route("/api/session/{sessionID}", { sessionID: ctx.state.id }),
      headers: ctx.headers(),
    }))
    .json(200, data(object)),
  http.protected
    .put("/api/session/{sessionID}/tags", "v2.session.tags.update")
    .seeded(apiSession)
    .at((ctx) => ({
      path: route("/api/session/{sessionID}/tags", { sessionID: ctx.state.id }),
      headers: ctx.headers(),
      body: { tags: ["HTTP verified", "Session recovery"] },
    }))
    .mutating()
    .json(200, (body) => {
      object(body)
      array(body.data)
      check(body.data.length === 2, "session tags should preserve the bounded set")
      check(body.data[0] === "HTTP verified", "session tags should preserve order and spelling")
      check(body.data[1] === "Session recovery", "session tags should preserve the second tag")
    }),
  http.protected
    .post("/api/session/{sessionID}/checkpoint", "v2.session.checkpoint.create")
    .seeded(apiSession)
    .at((ctx) => ({
      path: route("/api/session/{sessionID}/checkpoint", { sessionID: ctx.state.id }),
      headers: ctx.headers(),
      body: { label: "Before HTTP refactor" },
    }))
    .mutating()
    .json(200, (body, ctx) => {
      object(body)
      object(body.data)
      check(typeof body.data.id === "string", "checkpoint create should return an ID")
      check(body.data.sessionID === ctx.state.id, "checkpoint create should retain session ownership")
      check(body.data.label === "Before HTTP refactor", "checkpoint create should preserve its label")
      check(body.data.sequence === 0, "an empty-session checkpoint should record sequence zero")
    }),
  http.protected
    .get("/api/session/{sessionID}/checkpoint", "v2.session.checkpoint.list")
    .seeded((ctx) =>
      Effect.gen(function* () {
        const session = yield* apiSession(ctx)
        const first = yield* apiCheckpoint(ctx, session.id, "First checkpoint")
        const second = yield* apiCheckpoint(ctx, session.id, "Second checkpoint")
        return { session, first, second }
      }),
    )
    .at((ctx) => ({
      path: route("/api/session/{sessionID}/checkpoint", { sessionID: ctx.state.session.id }),
      headers: ctx.headers(),
    }))
    .mutating()
    .json(200, (body, ctx) => {
      object(body)
      array(body.data)
      check(body.data.length === 2, "checkpoint list should return both persisted checkpoints")
      check(
        body.data.some((checkpoint) => isRecord(checkpoint) && checkpoint.id === ctx.state.first.id),
        "checkpoint list should contain the first checkpoint",
      )
      check(
        body.data.some((checkpoint) => isRecord(checkpoint) && checkpoint.id === ctx.state.second.id),
        "checkpoint list should contain the second checkpoint",
      )
    }),
  http.protected
    .post("/api/session/{sessionID}/rewind/preview", "v2.session.rewind.preview")
    .withLlm()
    .seeded((ctx) =>
      Effect.gen(function* () {
        const session = yield* apiSession(ctx, true)
        yield* apiTurn(ctx, session.id, "Establish the checkpoint baseline", "Baseline established")
        const checkpoint = yield* apiCheckpoint(ctx, session.id, "Stable baseline")
        yield* apiTurn(ctx, session.id, "Create a later turn", "Later turn created")
        return { session, checkpoint }
      }),
    )
    .at((ctx) => ({
      path: route("/api/session/{sessionID}/rewind/preview", { sessionID: ctx.state.session.id }),
      headers: ctx.headers(),
      body: { checkpointID: ctx.state.checkpoint.id },
    }))
    .mutating()
    .json(200, (body, ctx) => {
      object(body)
      object(body.data)
      object(body.data.checkpoint)
      check(body.data.checkpoint.id === ctx.state.checkpoint.id, "rewind preview should identify the checkpoint")
      check(typeof body.data.affectedMessages === "number", "rewind preview should return an affected-message count")
      check(
        body.data.affectedMessages > 0,
        `rewind preview should count messages after the checkpoint (got ${String(body.data.affectedMessages)})`,
      )
      check(typeof body.data.expectedLastSequence === "number", "rewind preview should return a last-sequence token")
      check(
        body.data.expectedLastSequence > ctx.state.checkpoint.sequence,
        "rewind preview should return a concurrency token after the checkpoint",
      )
      check(body.data.workspaceEffectsUnchanged === true, "rewind preview must not claim workspace rollback")
    }),
  http.protected
    .post("/api/session/{sessionID}/rewind/apply", "v2.session.rewind.apply")
    .withLlm()
    .seeded((ctx) =>
      Effect.gen(function* () {
        const session = yield* apiSession(ctx, true)
        yield* apiTurn(ctx, session.id, "Establish the rewind baseline", "Rewind baseline established")
        const checkpoint = yield* apiCheckpoint(ctx, session.id, "Apply baseline")
        yield* apiTurn(ctx, session.id, "Create messages to rewind", "Messages ready for rewind")
        const preview = apiData(
          yield* ctx.api("POST", {
            path: route("/api/session/{sessionID}/rewind/preview", { sessionID: session.id }),
            headers: ctx.headers(),
            body: { checkpointID: checkpoint.id },
          }),
          "rewind preview seed",
        )
        check(typeof preview.expectedLastSequence === "number", "rewind preview should return a concurrency token")
        return { session, checkpoint, expectedLastSequence: preview.expectedLastSequence }
      }),
    )
    .at((ctx) => ({
      path: route("/api/session/{sessionID}/rewind/apply", { sessionID: ctx.state.session.id }),
      headers: ctx.headers(),
      body: {
        checkpointID: ctx.state.checkpoint.id,
        expectedLastSequence: ctx.state.expectedLastSequence,
      },
    }))
    .mutating()
    .json(200, (body, ctx) => {
      object(body)
      object(body.data)
      object(body.data.checkpoint)
      check(body.data.checkpoint.id === ctx.state.checkpoint.id, "rewind apply should identify the checkpoint")
      check(typeof body.data.rewoundMessages === "number", "rewind apply should return a rewound-message count")
      check(
        body.data.rewoundMessages > 0,
        `rewind apply should archive messages after the checkpoint (got ${String(body.data.rewoundMessages)})`,
      )
      check(
        body.data.lastSequence === ctx.state.checkpoint.sequence,
        "rewind apply should return to checkpoint sequence",
      )
      check(body.data.workspaceEffectsUnchanged === true, "rewind apply must leave workspace side effects unchanged")
    }),
  http.protected
    .get("/api/memory", "v2.memory.list")
    .seeded((ctx) =>
      Effect.gen(function* () {
        const matching = yield* apiMemory(ctx, {
          content: "PostgreSQL backup rehearsal passed with a verified restore checksum",
          type: "operations",
          tags: ["postgresql", "verified"],
          importance: 4,
        })
        yield* apiMemory(ctx, {
          content: "Desktop navigation color preference is graphite",
          type: "preference",
          tags: ["desktop"],
          importance: 1,
        })
        return { matching }
      }),
    )
    .at((ctx) => ({
      path: "/api/memory?query=backup&tag=postgresql&type=operations&minimumImportance=3&includeGlobal=false",
      headers: ctx.headers(),
    }))
    .mutating()
    .json(200, (body, ctx) => {
      object(body)
      object(body.data)
      array(body.data.items)
      check(body.data.count === 1, "memory list filters should return exactly one matching memory")
      check(body.data.total === 1, "memory list total should describe the filtered result")
      object(body.data.items[0])
      check(body.data.items[0].id === ctx.state.matching.id, "memory list should return the matching memory")
    }),
  http.protected
    .post("/api/memory", "v2.memory.create")
    .at((ctx) => ({
      path: "/api/memory",
      headers: ctx.headers(),
      body: {
        content: "Arforge HTTP memory creation is verified",
        type: "verification",
        tags: ["http", "memory"],
        importance: 5,
        strength: 0.9,
        reviewLevel: 2,
      },
    }))
    .mutating()
    .json(200, (body, ctx) => {
      object(body)
      object(body.data)
      check(typeof body.data.id === "string", "memory create should return an ID")
      check(body.data.content === "Arforge HTTP memory creation is verified", "memory create should preserve content")
      check(body.data.type === "verification", "memory create should preserve type")
      check(body.data.scope === "workspace", "memory create should default to workspace isolation")
      check(body.data.source === "user", "memory create should default to a user-owned source")
      check(typeof ctx.directory === "string", "memory create scenario should have a workspace directory")
      check(
        body.data.workspacePath === canonicalWorkspacePath(ctx.directory),
        "memory create should bind to the canonical request workspace",
      )
      check(body.data.importance === 5, "memory create should preserve importance")
      check(body.data.strength === 0.9, "memory create should preserve strength")
      check(body.data.reviewLevel === 2, "memory create should preserve review level")
    }),
  http.protected
    .get("/api/memory/{memoryID}", "v2.memory.get")
    .seeded((ctx) =>
      apiMemory(ctx, {
        content: "Retrieve this workspace memory by its durable identifier",
        type: "verification",
        tags: ["get"],
      }),
    )
    .at((ctx) => ({
      path: route("/api/memory/{memoryID}", { memoryID: ctx.state.id }),
      headers: ctx.headers(),
    }))
    .mutating()
    .json(200, (body, ctx) => {
      object(body)
      object(body.data)
      check(body.data.id === ctx.state.id, "memory get should return the requested memory")
      check(body.data.content === ctx.state.content, "memory get should preserve persisted content")
      check(typeof ctx.directory === "string", "memory get scenario should have a workspace directory")
      check(
        body.data.workspacePath === canonicalWorkspacePath(ctx.directory),
        "memory get should remain bound to the canonical request workspace",
      )
    }),
  http.protected
    .patch("/api/memory/{memoryID}", "v2.memory.update")
    .seeded((ctx) =>
      apiMemory(ctx, {
        content: "Memory awaiting an HTTP update",
        type: "draft",
        tags: ["before"],
        importance: 1,
      }),
    )
    .at((ctx) => ({
      path: route("/api/memory/{memoryID}", { memoryID: ctx.state.id }),
      headers: ctx.headers(),
      body: {
        content: "Memory updated through the public HTTP contract",
        type: "verification",
        tags: ["after", "verified"],
        importance: 4,
        strength: 0.75,
        reviewLevel: 3,
      },
    }))
    .mutating()
    .json(200, (body, ctx) => {
      object(body)
      object(body.data)
      check(body.data.id === ctx.state.id, "memory update should preserve identity")
      check(
        body.data.content === "Memory updated through the public HTTP contract",
        "memory update should persist content",
      )
      check(body.data.type === "verification", "memory update should persist type")
      array(body.data.tags)
      check(body.data.tags.join(",") === "after,verified", "memory update should persist the complete tag set")
      check(body.data.importance === 4, "memory update should persist importance")
      check(body.data.strength === 0.75, "memory update should persist strength")
      check(body.data.reviewLevel === 3, "memory update should persist review level")
    }),
  http.protected
    .delete("/api/memory/maintenance/{memoryID}", "v2.memory.maintenanceDelete")
    .seeded((ctx) =>
      apiMemory(ctx, {
        content: "Delete this memory through the public HTTP contract",
        type: "verification",
        tags: ["delete"],
      }),
    )
    .at((ctx) => ({
      path: route("/api/memory/maintenance/{memoryID}", { memoryID: ctx.state.id }),
      headers: ctx.headers(),
      body: {
        expectedVersion: 1,
        actionID: "act_http_memory_delete",
        redactionEvidenceID: "evd_http_memory_delete",
        reason: "Authorized HTTP maintenance deletion",
      },
    }))
    .mutating()
    .status(204, (ctx) =>
      ctx
        .api("GET", {
          path: route("/api/memory/{memoryID}", { memoryID: ctx.state.id }),
          headers: ctx.headers(),
        })
        .pipe(
          Effect.map((result) => {
            check(result.status === 404, `deleted memory should return 404, got ${result.status}: ${result.text}`)
          }),
        ),
    ),
  http.protected
    .post("/api/memory/maintenance/delete", "v2.memory.maintenanceDeleteMany")
    .seeded((ctx) =>
      Effect.gen(function* () {
        const first = yield* apiMemory(ctx, {
          content: "First memory selected for bounded bulk deletion",
          type: "verification",
        })
        const second = yield* apiMemory(ctx, {
          content: "Second memory selected for bounded bulk deletion",
          type: "verification",
        })
        return { first, second, missingID: "mem_httpapi_missing" }
      }),
    )
    .at((ctx) => ({
      path: "/api/memory/maintenance/delete",
      headers: ctx.headers(),
      body: {
        items: [
          {
            memoryID: ctx.state.first.id,
            expectedVersion: 1,
            actionID: "act_http_memory_bulk_delete_first",
            redactionEvidenceID: "evd_http_memory_bulk_delete_first",
            reason: "Authorized HTTP bulk maintenance deletion",
          },
          {
            memoryID: ctx.state.second.id,
            expectedVersion: 1,
            actionID: "act_http_memory_bulk_delete_second",
            redactionEvidenceID: "evd_http_memory_bulk_delete_second",
            reason: "Authorized HTTP bulk maintenance deletion",
          },
          {
            memoryID: ctx.state.missingID,
            expectedVersion: 1,
            actionID: "act_http_memory_bulk_delete_missing",
            redactionEvidenceID: "evd_http_memory_bulk_delete_missing",
            reason: "Authorized HTTP bulk maintenance deletion",
          },
        ],
      },
    }))
    .mutating()
    .json(200, (body, ctx) => {
      object(body)
      object(body.data)
      array(body.data.deleted)
      array(body.data.notFound)
      check(body.data.deleted.length === 2, "memory bulk delete should report both deleted memories")
      check(body.data.deleted.includes(ctx.state.first.id), "memory bulk delete should report the first ID")
      check(body.data.deleted.includes(ctx.state.second.id), "memory bulk delete should report the second ID")
      check(body.data.notFound.includes(ctx.state.missingID), "memory bulk delete should report missing IDs")
    }),
  http.protected
    .get("/api/memory/semantic", "v2.memory.semantic")
    .seeded((ctx) =>
      apiMemory(ctx, {
        content: "PostgreSQL restore rehearsal verified the encrypted nightly backup checksum",
        type: "operations",
        tags: ["postgresql", "restore"],
        importance: 5,
      }),
    )
    .at((ctx) => ({
      path: "/api/memory/semantic?query=PostgreSQL%20restore%20checksum&topK=5&includeGlobal=false",
      headers: ctx.headers(),
    }))
    .mutating()
    .json(200, (body, ctx) => {
      object(body)
      object(body.data)
      check(
        body.data.algorithm === "hybrid_bm25_hashing_vector",
        "semantic memory should report its retrieval algorithm",
      )
      check(body.data.localOnly === true, "semantic memory should remain local-only")
      array(body.data.items)
      check(typeof body.data.count === "number" && body.data.count > 0, "semantic memory should return a relevant hit")
      const hit = body.data.items.find(
        (item: unknown) => isRecord(item) && isRecord(item.memory) && item.memory.id === ctx.state.id,
      )
      object(hit)
      check(typeof hit.score === "number", "semantic memory hit should include a score")
      array(hit.matchedTerms)
      check(hit.matchedTerms.length > 0, "semantic memory hit should explain matched terms")
    }),
  http.protected
    .get("/api/memory/facets", "v2.memory.facets")
    .seeded((ctx) =>
      apiMemory(ctx, {
        content: "Facet verification memory for Arforge desktop diagnostics",
        type: "diagnostic",
        tags: ["desktop", "verified"],
        source: "user-corrected",
      }),
    )
    .at((ctx) => ({
      path: "/api/memory/facets?includeGlobal=false",
      headers: ctx.headers(),
    }))
    .mutating()
    .json(200, (body) => {
      object(body)
      object(body.data)
      array(body.data.types)
      array(body.data.tags)
      array(body.data.sources)
      check(
        body.data.types.some((facet: unknown) => isRecord(facet) && facet.value === "diagnostic" && facet.count === 1),
        "memory facets should aggregate type counts",
      )
      check(
        body.data.tags.some((facet: unknown) => isRecord(facet) && facet.value === "desktop" && facet.count === 1),
        "memory facets should aggregate tag counts",
      )
      check(
        body.data.sources.some(
          (facet: unknown) => isRecord(facet) && facet.value === "user-corrected" && facet.count === 1,
        ),
        "memory facets should aggregate source counts",
      )
    }),
  http.protected
    .get("/api/memory/status", "v2.memory.status")
    .seeded((ctx) =>
      apiMemory(ctx, {
        content: "Important workspace memory used to validate operational status",
        type: "verification",
        tags: ["status"],
        importance: 5,
      }),
    )
    .at((ctx) => ({
      path: "/api/memory/status",
      headers: ctx.headers(),
    }))
    .mutating()
    .json(200, (body, ctx) => {
      object(body)
      object(body.data)
      check(body.data.total === 1, "memory status should count workspace memories")
      check(body.data.workspace === 1, "memory status should count workspace-scoped memories")
      check(body.data.global === 0, "memory status should not invent global memories")
      check(body.data.important === 1, "memory status should count important memories")
      check(body.data.quarantined === 0, "memory status should not quarantine user memories")
      array(body.data.recent)
      check(
        body.data.recent.some((memory: unknown) => isRecord(memory) && memory.id === ctx.state.id),
        "memory status should include the recent memory",
      )
    }),
  http.protected
    .get("/api/memory/recall-quality", "v2.memory.recallQuality")
    .seeded((ctx) =>
      apiMemory(ctx, {
        content: "Recall quality baseline memory for PostgreSQL recovery",
        type: "verification",
        tags: ["recall"],
      }),
    )
    .at((ctx) => ({
      path: "/api/memory/recall-quality",
      headers: ctx.headers(),
    }))
    .mutating()
    .json(200, (body) => {
      object(body)
      object(body.data)
      check(body.data.status === "operational_baseline", "recall quality should expose its baseline status")
      check(typeof body.data.sampleSize === "number", "recall quality should report sample size")
      check(typeof body.data.top1Rate === "number", "recall quality should report top-one rate")
      check(typeof body.data.meanReciprocalRank === "number", "recall quality should report reciprocal rank")
      check(typeof body.data.noResultRate === "number", "recall quality should report no-result rate")
      array(body.data.examples)
      check(
        typeof body.data.caveat === "string" && body.data.caveat.length > 0,
        "recall quality should disclose caveats",
      )
    }),
  http.protected
    .get("/api/memory/governance/preview", "v2.memory.governancePreview")
    .seeded((ctx) =>
      apiMemory(ctx, {
        content: "Temporary build output from one task",
        type: "project",
        tags: ["temporary"],
        source: "auto",
      }),
    )
    .at((ctx) => ({
      path: "/api/memory/governance/preview?scanLimit=100&sampleLimit=20",
      headers: ctx.headers(),
    }))
    .mutating()
    .json(200, (body, ctx) => {
      object(body)
      object(body.data)
      check(body.data.schemaVersion === 1, "memory governance preview should report schema version")
      check(body.data.action === "quarantine", "memory governance preview should propose quarantine")
      check(body.data.reversible === true, "memory governance preview should remain reversible")
      check(body.data.candidateCount === 1, "memory governance preview should find unsafe automatic memory")
      array(body.data.candidates)
      const candidate = body.data.candidates.find((item: unknown) => isRecord(item) && item.id === ctx.state.id)
      object(candidate)
      check(candidate.reason === "review_required_project", "memory governance preview should explain its decision")
    }),
  http.protected
    .post("/api/memory/governance/apply", "v2.memory.governanceApply")
    .seeded((ctx) =>
      apiMemory(ctx, {
        content: "Temporary generated project summary awaiting governance review",
        type: "project",
        tags: ["generated"],
        source: "auto",
        importance: 4,
        strength: 0.8,
      }),
    )
    .at((ctx) => ({
      path: "/api/memory/governance/apply",
      headers: ctx.headers(),
      body: { scanLimit: 100 },
    }))
    .mutating()
    .jsonEffect(200, (body, ctx) =>
      Effect.gen(function* () {
        object(body)
        object(body.data)
        check(body.data.schemaVersion === 1, "memory governance apply should report schema version")
        check(body.data.status === "applied", "memory governance apply should report applied status")
        check(body.data.reversible === true, "memory governance apply should remain reversible")
        check(body.data.quarantined === 1, "memory governance apply should quarantine one unsafe memory")
        array(body.data.quarantinedIDs)
        check(body.data.quarantinedIDs.includes(ctx.state.id), "memory governance apply should report the memory ID")

        const result = yield* ctx.api("GET", {
          path: route("/api/memory/{memoryID}", { memoryID: ctx.state.id }),
          headers: ctx.headers(),
        })
        const memory = apiData(result, "memory governance verification")
        check(memory.source === "quarantined:auto", "memory governance should preserve provenance while quarantining")
        check(memory.importance === 1, "memory governance should lower quarantined importance")
        check(memory.strength === 0.1, "memory governance should lower quarantined strength")
        array(memory.tags)
        check(memory.tags.includes("quarantine:review_required_project"), "memory governance should persist its reason")
      }),
    ),
  http.protected
    .get("/api/memory/conflicts", "v2.memory.conflictList")
    .at((ctx) => ({
      path: "/api/memory/conflicts?includeClosed=false&limit=20",
      headers: ctx.headers(),
    }))
    .json(200, data(object)),
  http.protected
    .post("/api/memory/conflicts/scan", "v2.memory.conflictScan")
    .at((ctx) => ({
      path: "/api/memory/conflicts/scan",
      headers: ctx.headers(),
      body: { scanLimit: 20, resultLimit: 10 },
    }))
    .mutating()
    .json(200, data(object)),
  http.protected
    .post("/api/memory/{memoryID}/correct", "v2.memory.correct")
    .at((ctx) => ({
      path: route("/api/memory/{memoryID}/correct", { memoryID: "mem_httpapi_missing" }),
      headers: ctx.headers(),
      body: { content: "Corrected memory", reason: "HTTP API exercise", expectedUpdatedAt: 0 },
    }))
    .status(404),
  http.protected
    .get("/api/memory/{memoryID}/corrections", "v2.memory.correctionHistory")
    .at((ctx) => ({
      path: route("/api/memory/{memoryID}/corrections", { memoryID: "mem_httpapi_missing" }),
      headers: ctx.headers(),
    }))
    .status(404),
  http.protected
    .post("/api/memory/corrections/{correctionID}/undo", "v2.memory.undoCorrection")
    .at((ctx) => ({
      path: route("/api/memory/corrections/{correctionID}/undo", { correctionID: "mcor_httpapi_missing" }),
      headers: ctx.headers(),
      body: { expectedSuccessorUpdatedAt: 0 },
    }))
    .status(409),
  http.protected
    .post("/api/memory/conflicts/{conflictID}/resolve", "v2.memory.resolveConflict")
    .at((ctx) => ({
      path: route("/api/memory/conflicts/{conflictID}/resolve", { conflictID: "mcf_httpapi_missing" }),
      headers: ctx.headers(),
      body: {
        chosenMemoryID: "mem_httpapi_missing",
        reason: "HTTP API exercise",
        expectedLeftUpdatedAt: 0,
        expectedRightUpdatedAt: 0,
      },
    }))
    .status(409),
  http.protected
    .post("/api/memory/conflicts/{conflictID}/dismiss", "v2.memory.dismissConflict")
    .at((ctx) => ({
      path: route("/api/memory/conflicts/{conflictID}/dismiss", { conflictID: "mcf_httpapi_missing" }),
      headers: ctx.headers(),
      body: { reason: "HTTP API exercise", expectedLeftUpdatedAt: 0, expectedRightUpdatedAt: 0 },
    }))
    .status(409),
  http.protected
    .post("/api/memory/conflicts/{conflictID}/undo", "v2.memory.undoConflict")
    .at((ctx) => ({
      path: route("/api/memory/conflicts/{conflictID}/undo", { conflictID: "mcf_httpapi_missing" }),
      headers: ctx.headers(),
      body: { expectedLeftUpdatedAt: 0, expectedRightUpdatedAt: 0 },
    }))
    .status(409),
  http.protected
    .post("/api/session/{sessionID}/team", "v2.team.create")
    .seeded(apiSession)
    .at((ctx) => ({
      path: route("/api/session/{sessionID}/team", { sessionID: ctx.state.id }),
      headers: ctx.headers(),
      body: {
        name: "HTTP Integration Team",
        description: "Verify the session-owned collaboration contract",
      },
    }))
    .mutating()
    .json(200, (body, ctx) => {
      object(body)
      object(body.data)
      check(typeof body.data.id === "string", "team create should return an ID")
      check(body.data.sessionID === ctx.state.id, "team create should bind ownership to the session")
      check(body.data.name === "HTTP Integration Team", "team create should preserve its name")
      check(
        body.data.description === "Verify the session-owned collaboration contract",
        "team create should preserve its description",
      )
      check(body.data.memberCount === 0, "team create should start without collaborators")
      check(body.data.messageCount === 0, "team create should start with an empty mailbox")
      array(body.data.members)
      check(
        body.data.members.length === 1 && isRecord(body.data.members[0]) && body.data.members[0].name === "lead",
        "team create should install the implicit lead member",
      )
    }),
  http.protected
    .get("/api/session/{sessionID}/team", "v2.team.get")
    .seeded((ctx) => apiTeam(ctx, "Durable Retrieval Team", "Read the complete team projection"))
    .at((ctx) => ({
      path: route("/api/session/{sessionID}/team", { sessionID: ctx.state.session.id }),
      headers: ctx.headers(),
    }))
    .mutating()
    .json(200, (body, ctx) => {
      object(body)
      object(body.data)
      check(body.data.id === ctx.state.team.id, "team get should return the session-owned team")
      check(body.data.sessionID === ctx.state.session.id, "team get should preserve session ownership")
      check(body.data.name === "Durable Retrieval Team", "team get should preserve persisted metadata")
      check(typeof body.data.revision === "number" && body.data.revision > 0, "team get should expose revision state")
    }),
  http.protected
    .post("/api/session/{sessionID}/team/member", "v2.team.memberAdd")
    .seeded((ctx) => apiTeam(ctx, "Member Lifecycle Team"))
    .at((ctx) => ({
      path: route("/api/session/{sessionID}/team/member", { sessionID: ctx.state.session.id }),
      headers: ctx.headers(),
      body: { memberName: "Researcher", agentID: "explore" },
    }))
    .mutating()
    .jsonEffect(200, (body, ctx) =>
      Effect.gen(function* () {
        object(body)
        object(body.data)
        check(body.data.name === "Researcher", "team member add should preserve the collaborator name")
        check(body.data.agentID === "explore", "team member add should bind an existing subagent role")
        check(body.data.status === "active", "team member add should activate the collaborator")

        const team = apiData(
          yield* ctx.api("GET", {
            path: route("/api/session/{sessionID}/team", { sessionID: ctx.state.session.id }),
            headers: ctx.headers(),
          }),
          "team member verification",
        )
        check(team.memberCount === 1, "team member add should increment the collaborator count")
        array(team.members)
        check(
          team.members.some(
            (member: unknown) =>
              isRecord(member) &&
              member.name === "Researcher" &&
              member.agentID === "explore" &&
              member.status === "active",
          ),
          "team member add should persist the complete collaborator projection",
        )
      }),
    ),
  http.protected
    .delete("/api/session/{sessionID}/team/member/{memberName}", "v2.team.memberRemove")
    .seeded((ctx) =>
      Effect.gen(function* () {
        const state = yield* apiTeam(ctx, "Protected Removal Team")
        const member = yield* apiTeamMember(ctx, state.session.id, "Builder")
        return { ...state, member }
      }),
    )
    .at((ctx) => ({
      path: route("/api/session/{sessionID}/team/member/{memberName}", {
        sessionID: ctx.state.session.id,
        memberName: ctx.state.member.name,
      }),
      headers: ctx.headers(),
    }))
    .mutating()
    .jsonEffect(
      409,
      (_body, ctx) =>
        ctx
          .api("GET", {
            path: route("/api/session/{sessionID}/team", { sessionID: ctx.state.session.id }),
            headers: ctx.headers(),
          })
          .pipe(
            Effect.map((result) => {
              const team = apiData(result, "protected team member removal verification")
              array(team.members)
              check(
                team.members.some(
                  (member: unknown) =>
                    isRecord(member) && member.name === ctx.state.member.name && member.status === "active",
                ),
                "team member removal must retain an active member until explicit shutdown approval",
              )
            }),
          ),
      "status",
    ),
  http.protected
    .post("/api/session/{sessionID}/team/message", "v2.team.messageSend")
    .seeded((ctx) =>
      Effect.gen(function* () {
        const state = yield* apiTeam(ctx, "Mailbox Send Team")
        const member = yield* apiTeamMember(ctx, state.session.id, "Implementer")
        return { ...state, member }
      }),
    )
    .at((ctx) => ({
      path: route("/api/session/{sessionID}/team/message", { sessionID: ctx.state.session.id }),
      headers: ctx.headers(),
      body: {
        recipient: ctx.state.member.name,
        message: "Implement the verified HTTP lifecycle",
        summary: "Lifecycle implementation request",
        kind: "request",
      },
    }))
    .mutating()
    .json(200, (body, ctx) => {
      object(body)
      object(body.data)
      check(typeof body.data.id === "string", "team message send should return a durable ID")
      check(body.data.teamID === ctx.state.team.id, "team message send should remain within the session team")
      check(body.data.sequence === 1, "the first team message should reserve sequence one")
      check(body.data.sender === "lead", "the HTTP team message sender should be the lead")
      check(body.data.recipient === ctx.state.member.name, "team message send should preserve the recipient")
      array(body.data.recipients)
      check(
        body.data.recipients.length === 1 && body.data.recipients[0] === ctx.state.member.name,
        "team message send should persist the resolved recipient set",
      )
      check(body.data.kind === "request", "team message send should preserve message kind")
      check(body.data.summary === "Lifecycle implementation request", "team message send should preserve its summary")
      check(body.data.message === "Implement the verified HTTP lifecycle", "team message send should preserve its text")
    }),
  http.protected
    .get("/api/session/{sessionID}/team/message", "v2.team.messageList")
    .seeded((ctx) =>
      Effect.gen(function* () {
        const state = yield* apiTeam(ctx, "Mailbox Isolation Team")
        const member = yield* apiTeamMember(ctx, state.session.id, "Reviewer")
        apiData(
          yield* ctx.api("POST", {
            path: route("/api/session/{sessionID}/team/message", { sessionID: state.session.id }),
            headers: ctx.headers(),
            body: {
              recipient: member.name,
              message: "Only the reviewer should receive this message",
              kind: "info",
            },
          }),
          "team message seed",
        )
        return { ...state, member }
      }),
    )
    .at((ctx) => ({
      path:
        route("/api/session/{sessionID}/team/message", { sessionID: ctx.state.session.id }) +
        "?afterSequence=0&limit=20",
      headers: ctx.headers(),
    }))
    .mutating()
    .json(200, (body, ctx) => {
      object(body)
      object(body.data)
      check(body.data.teamID === ctx.state.team.id, "team inbox should remain scoped to its team")
      check(body.data.member === "lead", "the HTTP inbox should represent the implicit lead")
      check(body.data.count === 0, "lead should not receive a direct message addressed to another member")
      check(body.data.lastSequence === 0, "an empty lead inbox should retain its requested cursor")
      array(body.data.messages)
      check(body.data.messages.length === 0, "team inbox must not leak another member's direct messages")
    }),
  http.protected
    .post("/api/session/{sessionID}/team/member/{memberName}/shutdown", "v2.team.shutdownRequest")
    .seeded((ctx) =>
      Effect.gen(function* () {
        const state = yield* apiTeam(ctx, "Graceful Shutdown Team")
        const member = yield* apiTeamMember(ctx, state.session.id, "Operator")
        return { ...state, member }
      }),
    )
    .at((ctx) => ({
      path: route("/api/session/{sessionID}/team/member/{memberName}/shutdown", {
        sessionID: ctx.state.session.id,
        memberName: ctx.state.member.name,
      }),
      headers: ctx.headers(),
      body: { reason: "Assigned lifecycle work is complete" },
    }))
    .mutating()
    .jsonEffect(200, (body, ctx) =>
      Effect.gen(function* () {
        object(body)
        object(body.data)
        check(typeof body.data.id === "string", "shutdown request should return a durable ID")
        check(body.data.teamID === ctx.state.team.id, "shutdown request should remain scoped to its team")
        check(body.data.member === ctx.state.member.name, "shutdown request should preserve the target member")
        check(body.data.status === "pending", "shutdown request should require a collaborator decision")
        check(body.data.reason === "Assigned lifecycle work is complete", "shutdown request should preserve its reason")

        const team = apiData(
          yield* ctx.api("GET", {
            path: route("/api/session/{sessionID}/team", { sessionID: ctx.state.session.id }),
            headers: ctx.headers(),
          }),
          "shutdown request verification",
        )
        check(team.pendingShutdowns === 1, "shutdown request should increment pending shutdown state")
        array(team.members)
        check(
          team.members.some(
            (member: unknown) =>
              isRecord(member) && member.name === ctx.state.member.name && member.status === "shutdown_requested",
          ),
          "shutdown request should transition only the requested collaborator",
        )
      }),
    ),
  http.protected
    .delete("/api/session/{sessionID}/team", "v2.team.delete")
    .seeded((ctx) => apiTeam(ctx, "Disposable Empty Team"))
    .at((ctx) => ({
      path: route("/api/session/{sessionID}/team", { sessionID: ctx.state.session.id }),
      headers: ctx.headers(),
    }))
    .mutating()
    .status(204, (ctx) =>
      ctx
        .api("GET", {
          path: route("/api/session/{sessionID}/team", { sessionID: ctx.state.session.id }),
          headers: ctx.headers(),
        })
        .pipe(
          Effect.map((result) => {
            check(result.status === 404, `deleted team should return 404, got ${result.status}: ${result.text}`)
          }),
        ),
    ),
  http.protected
    .post("/api/session/{sessionID}/schedule", "v2.scheduledPrompt.create")
    .seeded(apiSession)
    .at((ctx) => ({
      path: route("/api/session/{sessionID}/schedule", { sessionID: ctx.state.id }),
      headers: ctx.headers(),
      body: {
        name: "Nightly PostgreSQL rehearsal",
        cron: "0 0 * * *",
        prompt: "Run the private PostgreSQL backup and restore verification",
        recurring: true,
        durable: true,
      },
    }))
    .mutating()
    .json(200, (body, ctx) => {
      object(body)
      object(body.data)
      check(typeof body.data.id === "string", "scheduled prompt create should return an ID")
      check(body.data.sessionID === ctx.state.id, "scheduled prompt create should remain session-owned")
      check(body.data.name === "Nightly PostgreSQL rehearsal", "scheduled prompt create should preserve its name")
      check(body.data.cron === "0 0 * * *", "scheduled prompt create should preserve its cron expression")
      check(
        body.data.prompt === "Run the private PostgreSQL backup and restore verification",
        "scheduled prompt create should preserve its prompt",
      )
      check(body.data.recurring === true, "scheduled prompt create should preserve recurring mode")
      check(body.data.durable === true, "scheduled prompt create should preserve durable mode")
      check(body.data.enabled === true, "scheduled prompt create should begin enabled")
      check(body.data.status === "scheduled", "scheduled prompt create should begin scheduled")
      check(body.data.revision === 1, "scheduled prompt create should begin at revision one")
      object(body.data.time)
      check(typeof body.data.time.created === "number", "scheduled prompt create should record its creation time")
      check(typeof body.data.time.nextRun === "number", "scheduled prompt create should compute the next run")
      check(typeof body.data.time.expires === "number", "scheduled prompt create should enforce a bounded lifetime")
      check(body.data.time.nextRun > body.data.time.created, "scheduled prompt create should compute a future run")
      check(
        body.data.time.expires > body.data.time.nextRun,
        "scheduled prompt create should enforce a lifetime after its next run",
      )
    }),
  http.protected
    .get("/api/session/{sessionID}/schedule", "v2.scheduledPrompt.list")
    .seeded((ctx) =>
      Effect.gen(function* () {
        const session = yield* apiSession(ctx)
        const first = yield* apiSchedule(ctx, session.id, {
          name: "First scheduled verification",
          prompt: "Verify the first scheduled operation",
        })
        const second = yield* apiSchedule(ctx, session.id, {
          name: "Second scheduled verification",
          prompt: "Verify the second scheduled operation",
          recurring: true,
        })
        return { session, first, second }
      }),
    )
    .at((ctx) => ({
      path: route("/api/session/{sessionID}/schedule", { sessionID: ctx.state.session.id }),
      headers: ctx.headers(),
    }))
    .mutating()
    .json(200, (body, ctx) => {
      object(body)
      array(body.data)
      check(body.data.length === 2, "scheduled prompt list should return both persisted schedules")
      check(
        body.data.some((schedule: unknown) => isRecord(schedule) && schedule.id === ctx.state.first.id),
        "scheduled prompt list should include the first schedule",
      )
      check(
        body.data.some((schedule: unknown) => isRecord(schedule) && schedule.id === ctx.state.second.id),
        "scheduled prompt list should include the second schedule",
      )
    }),
  http.protected
    .get("/api/session/{sessionID}/schedule/{scheduleID}", "v2.scheduledPrompt.get")
    .seeded((ctx) =>
      Effect.gen(function* () {
        const session = yield* apiSession(ctx)
        const schedule = yield* apiSchedule(ctx, session.id, {
          name: "Scheduled prompt retrieval",
          prompt: "Retrieve this durable scheduled prompt",
        })
        return { session, schedule }
      }),
    )
    .at((ctx) => ({
      path: route("/api/session/{sessionID}/schedule/{scheduleID}", {
        sessionID: ctx.state.session.id,
        scheduleID: ctx.state.schedule.id,
      }),
      headers: ctx.headers(),
    }))
    .mutating()
    .json(200, (body, ctx) => {
      object(body)
      object(body.data)
      check(body.data.id === ctx.state.schedule.id, "scheduled prompt get should return the requested schedule")
      check(body.data.sessionID === ctx.state.session.id, "scheduled prompt get should preserve session ownership")
      check(body.data.name === "Scheduled prompt retrieval", "scheduled prompt get should preserve metadata")
      check(
        body.data.prompt === "Retrieve this durable scheduled prompt",
        "scheduled prompt get should preserve prompt text",
      )
    }),
  http.protected
    .patch("/api/session/{sessionID}/schedule/{scheduleID}", "v2.scheduledPrompt.update")
    .seeded((ctx) =>
      Effect.gen(function* () {
        const session = yield* apiSession(ctx)
        const schedule = yield* apiSchedule(ctx, session.id, {
          name: "Schedule before update",
          prompt: "Original scheduled prompt",
        })
        return { session, schedule }
      }),
    )
    .at((ctx) => ({
      path: route("/api/session/{sessionID}/schedule/{scheduleID}", {
        sessionID: ctx.state.session.id,
        scheduleID: ctx.state.schedule.id,
      }),
      headers: ctx.headers(),
      body: {
        expectedRevision: ctx.state.schedule.revision,
        name: "Schedule after update",
        cron: "30 1 * * *",
        prompt: "Updated scheduled prompt",
        enabled: false,
        recurring: true,
      },
    }))
    .mutating()
    .json(200, (body, ctx) => {
      object(body)
      object(body.data)
      check(body.data.id === ctx.state.schedule.id, "scheduled prompt update should preserve identity")
      check(body.data.revision === ctx.state.schedule.revision + 1, "scheduled prompt update should advance revision")
      check(body.data.name === "Schedule after update", "scheduled prompt update should persist its name")
      check(body.data.cron === "30 1 * * *", "scheduled prompt update should persist its cron expression")
      check(body.data.prompt === "Updated scheduled prompt", "scheduled prompt update should persist prompt text")
      check(body.data.enabled === false, "scheduled prompt update should persist disabled state")
      check(body.data.recurring === true, "scheduled prompt update should persist recurring mode")
    }),
  http.protected
    .delete("/api/session/{sessionID}/schedule/{scheduleID}", "v2.scheduledPrompt.delete")
    .seeded((ctx) =>
      Effect.gen(function* () {
        const session = yield* apiSession(ctx)
        const schedule = yield* apiSchedule(ctx, session.id, {
          name: "Schedule selected for deletion",
          prompt: "Delete this scheduled prompt",
        })
        return { session, schedule }
      }),
    )
    .at((ctx) => ({
      path: route("/api/session/{sessionID}/schedule/{scheduleID}", {
        sessionID: ctx.state.session.id,
        scheduleID: ctx.state.schedule.id,
      }),
      headers: ctx.headers(),
      body: { expectedRevision: ctx.state.schedule.revision },
    }))
    .mutating()
    .status(204, (ctx) =>
      ctx
        .api("GET", {
          path: route("/api/session/{sessionID}/schedule/{scheduleID}", {
            sessionID: ctx.state.session.id,
            scheduleID: ctx.state.schedule.id,
          }),
          headers: ctx.headers(),
        })
        .pipe(
          Effect.map((result) => {
            check(result.status === 404, `deleted schedule should return 404, got ${result.status}: ${result.text}`)
          }),
        ),
    ),
  http.protected
    .post("/api/session/{sessionID}/schedule/{scheduleID}/run", "v2.scheduledPrompt.run")
    .seeded((ctx) =>
      Effect.gen(function* () {
        const session = yield* apiSession(ctx)
        const schedule = yield* apiSchedule(ctx, session.id, {
          name: "Explicit scheduled run",
          prompt: "Execute the scheduled HTTP verification",
        })
        return { session, schedule }
      }),
    )
    .at((ctx) => ({
      path: route("/api/session/{sessionID}/schedule/{scheduleID}/run", {
        sessionID: ctx.state.session.id,
        scheduleID: ctx.state.schedule.id,
      }),
      headers: ctx.headers(),
      body: { expectedRevision: ctx.state.schedule.revision },
    }))
    .mutating()
    .jsonEffect(200, (body, ctx) =>
      Effect.gen(function* () {
        object(body)
        object(body.data)
        check(body.data.id === ctx.state.schedule.id, "scheduled prompt run should preserve identity")
        check(body.data.status === "completed", "one-shot scheduled prompt run should reach completed state")
        check(body.data.enabled === true, "explicit scheduled prompt run should preserve its enabled setting")
        check(body.data.revision === ctx.state.schedule.revision + 1, "scheduled prompt run should advance revision")
        object(body.data.time)
        check(typeof body.data.time.lastRun === "number", "scheduled prompt run should record its execution time")
        check(body.data.time.nextRun === undefined, "completed one-shot scheduled prompt should clear its next run")

        const queue = apiPayload(
          yield* ctx.api("GET", {
            path: route("/api/session/{sessionID}/prompt/queue", { sessionID: ctx.state.session.id }),
            headers: ctx.headers(),
          }),
          "scheduled prompt queue verification",
        )
        array(queue)
        check(queue.length === 1, "scheduled prompt run should admit exactly one durable prompt")
        object(queue[0])
        object(queue[0].prompt)
        check(
          queue[0].prompt.text === "Execute the scheduled HTTP verification",
          "scheduled prompt run should use the canonical prompt queue",
        )
      }),
    ),
  http.protected
    .post("/api/session/{sessionID}/schedule/{scheduleID}/run-missed", "v2.scheduledPrompt.runMissed")
    .seeded((ctx) =>
      Effect.gen(function* () {
        const session = yield* apiSession(ctx)
        const schedule = yield* apiSchedule(ctx, session.id, {
          name: "Not-yet-missed schedule",
          prompt: "This prompt must not run before it is missed",
        })
        return { session, schedule }
      }),
    )
    .at((ctx) => ({
      path: route("/api/session/{sessionID}/schedule/{scheduleID}/run-missed", {
        sessionID: ctx.state.session.id,
        scheduleID: ctx.state.schedule.id,
      }),
      headers: ctx.headers(),
      body: { expectedRevision: ctx.state.schedule.revision },
    }))
    .mutating()
    .jsonEffect(
      409,
      (_body, ctx) =>
        Effect.gen(function* () {
          const schedule = apiData(
            yield* ctx.api("GET", {
              path: route("/api/session/{sessionID}/schedule/{scheduleID}", {
                sessionID: ctx.state.session.id,
                scheduleID: ctx.state.schedule.id,
              }),
              headers: ctx.headers(),
            }),
            "run-missed invariant verification",
          )
          check(schedule.status === "scheduled", "run-missed must retain a schedule that has not become missed")
          check(
            schedule.revision === ctx.state.schedule.revision,
            "run-missed rejection must not consume the concurrency revision",
          )
          const queue = apiPayload(
            yield* ctx.api("GET", {
              path: route("/api/session/{sessionID}/prompt/queue", { sessionID: ctx.state.session.id }),
              headers: ctx.headers(),
            }),
            "run-missed queue verification",
          )
          array(queue)
          check(queue.length === 0, "run-missed must not enqueue a prompt before the schedule is missed")
        }),
      "status",
    ),
  http.protected.get("/api/trigger/profile", "v2.trigger.profiles").json(200, (body) => {
    object(body)
    object(body.data)
    array(body.data.items)
    check(
      typeof body.data.count === "number" && body.data.count >= 1,
      "trigger profiles should include at least the local provider",
    )
    const local = body.data.items.find((profile: unknown) => isRecord(profile) && profile.name === "local")
    object(local)
    check(local.kind === "local", "local trigger profile should report local execution")
    check(local.baseUrl === "", "local trigger profile should not expose a remote URL")
    check(local.timeout === 20, "local trigger profile should expose its bounded timeout")
    array(local.headerNames)
    check(local.headerNames.length === 0, "local trigger profile should not expose host headers")
    check(local.auth === undefined, "local trigger profile should not expose credential metadata")
  }),
  http.protected
    .get("/api/session/{sessionID}/trigger/{profile}", "v2.trigger.list")
    .seeded((ctx) =>
      Effect.gen(function* () {
        const session = yield* apiSession(ctx)
        const schedule = yield* apiSchedule(ctx, session.id, {
          name: "Trigger list schedule",
          prompt: "List this schedule through the local trigger profile",
        })
        return { session, schedule }
      }),
    )
    .at((ctx) => ({
      path: route("/api/session/{sessionID}/trigger/{profile}", {
        sessionID: ctx.state.session.id,
        profile: "local",
      }),
      headers: ctx.headers(),
    }))
    .mutating()
    .json(200, (body, ctx) => {
      object(body)
      object(body.data)
      check(body.data.profile === "local", "trigger list should report its profile")
      check(body.data.kind === "local", "trigger list should report local execution")
      check(body.data.action === "list", "trigger list should report its action")
      check(
        body.data.status === 200 && body.data.ok === true,
        "trigger list should report a successful provider result",
      )
      object(body.data.data)
      array(body.data.data.items)
      check(body.data.data.count === 1, "trigger list should return the session schedule")
      check(
        body.data.data.items.some((schedule: unknown) => isRecord(schedule) && schedule.id === ctx.state.schedule.id),
        "trigger list should include the schedule owned by the session",
      )
    }),
  http.protected
    .get("/api/session/{sessionID}/trigger/{profile}/{triggerID}", "v2.trigger.get")
    .seeded((ctx) =>
      Effect.gen(function* () {
        const session = yield* apiSession(ctx)
        const schedule = yield* apiSchedule(ctx, session.id, {
          name: "Trigger retrieval schedule",
          prompt: "Retrieve this schedule through its trigger identifier",
        })
        return { session, schedule }
      }),
    )
    .at((ctx) => ({
      path: route("/api/session/{sessionID}/trigger/{profile}/{triggerID}", {
        sessionID: ctx.state.session.id,
        profile: "local",
        triggerID: ctx.state.schedule.id,
      }),
      headers: ctx.headers(),
    }))
    .mutating()
    .json(200, (body, ctx) => {
      object(body)
      object(body.data)
      check(body.data.profile === "local", "trigger get should report its profile")
      check(body.data.action === "get", "trigger get should report its action")
      check(body.data.ok === true, "trigger get should report a successful provider result")
      object(body.data.data)
      check(body.data.data.id === ctx.state.schedule.id, "trigger get should return the requested schedule")
      check(body.data.data.sessionID === ctx.state.session.id, "trigger get should preserve session isolation")
      check(body.data.data.name === "Trigger retrieval schedule", "trigger get should preserve schedule metadata")
    }),
  http.protected
    .post("/api/session/{sessionID}/trigger/{profile}", "v2.trigger.create")
    .seeded(apiSession)
    .at((ctx) => ({
      path: route("/api/session/{sessionID}/trigger/{profile}", {
        sessionID: ctx.state.id,
        profile: "local",
      }),
      headers: ctx.headers(),
      body: {
        body: {
          name: "Local trigger creation",
          cron_expression: "15 2 * * *",
          prompt: "Run the local trigger creation verification",
          recurring: false,
          durable: true,
          enabled: true,
        },
      },
    }))
    .mutating()
    .json(200, (body, ctx) => {
      object(body)
      object(body.data)
      check(body.data.profile === "local", "trigger create should report its profile")
      check(body.data.kind === "local", "trigger create should use local execution")
      check(body.data.action === "create", "trigger create should report its action")
      check(body.data.status === 200 && body.data.ok === true, "trigger create should report success")
      object(body.data.data)
      check(typeof body.data.data.id === "string", "trigger create should return a schedule ID")
      check(body.data.data.sessionID === ctx.state.id, "trigger create should bind the schedule to its session")
      check(body.data.data.name === "Local trigger creation", "trigger create should preserve its name")
      check(body.data.data.cron === "15 2 * * *", "trigger create should normalize cron_expression")
      check(
        body.data.data.prompt === "Run the local trigger creation verification",
        "trigger create should preserve prompt text",
      )
      check(body.data.data.recurring === false, "trigger create should preserve one-shot mode")
      check(body.data.data.durable === true, "trigger create should preserve durable mode")
      check(body.data.data.status === "scheduled", "trigger create should create a scheduled prompt")
    }),
  http.protected
    .patch("/api/session/{sessionID}/trigger/{profile}/{triggerID}", "v2.trigger.update")
    .seeded((ctx) =>
      Effect.gen(function* () {
        const session = yield* apiSession(ctx)
        const schedule = yield* apiSchedule(ctx, session.id, {
          name: "Trigger before update",
          prompt: "Original trigger prompt",
        })
        return { session, schedule }
      }),
    )
    .at((ctx) => ({
      path: route("/api/session/{sessionID}/trigger/{profile}/{triggerID}", {
        sessionID: ctx.state.session.id,
        profile: "local",
        triggerID: ctx.state.schedule.id,
      }),
      headers: ctx.headers(),
      body: {
        body: {
          name: "Trigger after update",
          cron: "45 3 * * *",
          prompt: "Updated trigger prompt",
          recurring: true,
          enabled: false,
        },
      },
    }))
    .mutating()
    .json(200, (body, ctx) => {
      object(body)
      object(body.data)
      check(body.data.profile === "local", "trigger update should report its profile")
      check(body.data.action === "update", "trigger update should report its action")
      check(body.data.ok === true, "trigger update should report success")
      object(body.data.data)
      check(body.data.data.id === ctx.state.schedule.id, "trigger update should preserve schedule identity")
      check(
        body.data.data.revision === ctx.state.schedule.revision + 1,
        "trigger update should advance schedule revision",
      )
      check(body.data.data.name === "Trigger after update", "trigger update should persist its name")
      check(body.data.data.cron === "45 3 * * *", "trigger update should persist its cron expression")
      check(body.data.data.prompt === "Updated trigger prompt", "trigger update should persist its prompt")
      check(body.data.data.recurring === true, "trigger update should persist recurring mode")
      check(body.data.data.enabled === false, "trigger update should persist disabled state")
    }),
  http.protected
    .post("/api/session/{sessionID}/trigger/{profile}/{triggerID}/run", "v2.trigger.run")
    .seeded((ctx) =>
      Effect.gen(function* () {
        const session = yield* apiSession(ctx)
        const schedule = yield* apiSchedule(ctx, session.id, {
          name: "Trigger explicit run",
          prompt: "Execute this prompt through the local trigger",
        })
        return { session, schedule }
      }),
    )
    .at((ctx) => ({
      path: route("/api/session/{sessionID}/trigger/{profile}/{triggerID}/run", {
        sessionID: ctx.state.session.id,
        profile: "local",
        triggerID: ctx.state.schedule.id,
      }),
      headers: ctx.headers(),
    }))
    .mutating()
    .jsonEffect(200, (body, ctx) =>
      Effect.gen(function* () {
        object(body)
        object(body.data)
        check(body.data.profile === "local", "trigger run should report its profile")
        check(body.data.action === "run", "trigger run should report its action")
        check(body.data.ok === true, "trigger run should report success")
        object(body.data.data)
        check(body.data.data.id === ctx.state.schedule.id, "trigger run should preserve schedule identity")
        check(body.data.data.status === "completed", "one-shot trigger run should complete its schedule")
        check(
          body.data.data.revision === ctx.state.schedule.revision + 1,
          "trigger run should advance the schedule revision",
        )

        const queue = apiPayload(
          yield* ctx.api("GET", {
            path: route("/api/session/{sessionID}/prompt/queue", { sessionID: ctx.state.session.id }),
            headers: ctx.headers(),
          }),
          "trigger run queue verification",
        )
        array(queue)
        check(queue.length === 1, "trigger run should admit one prompt through the canonical queue")
        object(queue[0])
        object(queue[0].prompt)
        check(
          queue[0].prompt.text === "Execute this prompt through the local trigger",
          "trigger run should preserve the scheduled prompt text",
        )
      }),
    ),
  http.protected
    .post("/api/feedback", "v2.feedback.submit")
    .at((ctx) => ({
      path: "/api/feedback",
      headers: ctx.headers(),
      body: {
        category: "experience",
        rating: 5,
        message: "The unified Arforge lifecycle is clear and responsive",
      },
    }))
    .mutating()
    .json(200, (body) => {
      object(body)
      object(body.data)
      check(body.data.schemaVersion === 1, "feedback submit should report schema version")
      check(body.data.storedLocally === true, "feedback submit should remain local")
      object(body.data.feedback)
      check(typeof body.data.feedback.id === "string", "feedback submit should return an ID")
      check(body.data.feedback.category === "experience", "feedback submit should preserve category")
      check(body.data.feedback.rating === 5, "feedback submit should preserve rating")
      check(
        body.data.feedback.message === "The unified Arforge lifecycle is clear and responsive",
        "feedback submit should preserve its message",
      )
    }),
  http.protected
    .get("/api/feedback", "v2.feedback.list")
    .seeded((ctx) =>
      Effect.gen(function* () {
        const matching = yield* apiFeedback(ctx, {
          category: "bug",
          rating: 2,
          message: "A reproducible desktop rendering defect",
        })
        yield* apiFeedback(ctx, {
          category: "feature",
          rating: 4,
          message: "Request a private deployment dashboard",
        })
        return { matching }
      }),
    )
    .at((ctx) => ({
      path: "/api/feedback?category=bug&limit=10",
      headers: ctx.headers(),
    }))
    .mutating()
    .json(200, (body, ctx) => {
      object(body)
      object(body.data)
      check(body.data.schemaVersion === 1 && body.data.storedLocally === true, "feedback list should remain local")
      check(body.data.category === "bug", "feedback list should report its filter")
      check(body.data.count === 1 && body.data.total === 1, "feedback list should apply category filtering")
      array(body.data.items)
      check(
        body.data.items.length === 1 && isRecord(body.data.items[0]) && body.data.items[0].id === ctx.state.matching.id,
        "feedback list should return only the matching record",
      )
    }),
  http.protected
    .get("/api/feedback/summary", "v2.feedback.summary")
    .seeded((ctx) =>
      Effect.gen(function* () {
        yield* apiFeedback(ctx, { category: "bug", rating: 2, message: "First summary record" })
        yield* apiFeedback(ctx, { category: "feature", rating: 4, message: "Second summary record" })
      }),
    )
    .at((ctx) => ({ path: "/api/feedback/summary", headers: ctx.headers() }))
    .mutating()
    .json(200, (body) => {
      object(body)
      object(body.data)
      check(body.data.schemaVersion === 1 && body.data.storedLocally === true, "feedback summary should remain local")
      check(body.data.total === 2, "feedback summary should count all workspace feedback")
      check(body.data.averageRating === 3, "feedback summary should calculate the average rating")
      array(body.data.byCategory)
      check(
        body.data.byCategory.some((item: unknown) => isRecord(item) && item.category === "bug" && item.count === 1),
        "feedback summary should aggregate bug feedback",
      )
      check(
        body.data.byCategory.some((item: unknown) => isRecord(item) && item.category === "feature" && item.count === 1),
        "feedback summary should aggregate feature feedback",
      )
    }),
  http.protected
    .delete("/api/feedback/{feedbackID}", "v2.feedback.delete")
    .seeded((ctx) =>
      apiFeedback(ctx, {
        category: "other",
        rating: 3,
        message: "Feedback selected for reversible local deletion",
      }),
    )
    .at((ctx) => ({
      path: route("/api/feedback/{feedbackID}", { feedbackID: ctx.state.id }),
      headers: ctx.headers(),
    }))
    .mutating()
    .jsonEffect(200, (body, ctx) =>
      Effect.gen(function* () {
        object(body)
        object(body.data)
        check(body.data.feedbackID === ctx.state.id, "feedback delete should report its target")
        check(body.data.deleted === true && body.data.status === "deleted", "feedback delete should report success")
        const page = apiData(
          yield* ctx.api("GET", { path: "/api/feedback?limit=10", headers: ctx.headers() }),
          "feedback delete verification",
        )
        check(page.total === 0, "feedback delete should remove the record from workspace queries")
      }),
    ),
  http.protected
    .get("/api/learning/dream", "v2.learning.dream")
    .at((ctx) => ({
      path: `/api/learning/dream?location[directory]=${encodeURIComponent(ctx.directory ?? "")}`,
      headers: ctx.headers(),
    }))
    .json(200, (body) => {
      object(body)
      object(body.data)
      check(body.data.executionMode === "read-only-core-projection", "learning dream should remain read-only")
      check(body.data.sideEffects === "none", "learning dream should disclose no side effects")
      object(body.data.consolidation)
      check(body.data.consolidation.status === "not_run", "learning dream must not consolidate patterns")
      object(body.data.dream)
      check(Array.isArray(body.data.dream.insights), "learning dream should return bounded insights")
      check(Array.isArray(body.data.dream.suggestions), "learning dream should return bounded suggestions")
    }),
  http.protected
    .post("/api/learning/outcome", "v2.learning.record")
    .at((ctx) => ({
      path: "/api/learning/outcome",
      headers: ctx.headers(),
      body: {
        userInput: "Diagnose the scheduled prompt state transition",
        intent: "debug",
        route: "httpapi",
        tools: ["read", "test"],
        success: false,
        errorType: "state_machine",
        errorMessage: "Conflict response changed scheduled state",
        fixStrategy: "Validate before acquiring the execution lease",
        regression: true,
        tokenCount: 1200,
        responseTimeMs: 320,
        tags: ["schedule", "regression"],
        importance: 5,
        injectedContextSize: 256,
      },
    }))
    .mutating()
    .json(200, (body, ctx) => {
      object(body)
      object(body.data)
      check(typeof body.data.id === "string", "learning record should return an ID")
      check(body.data.userInput === "Diagnose the scheduled prompt state transition", "learning should preserve input")
      check(body.data.success === false, "learning should preserve the failed outcome")
      check(body.data.errorType === "state_machine", "learning should preserve error classification")
      check(
        body.data.fixStrategy === "Validate before acquiring the execution lease",
        "learning should preserve the remediation",
      )
      check(body.data.regression === true, "learning should preserve regression classification")
      check(body.data.workspacePath === canonicalWorkspacePath(ctx.directory!), "learning should bind to the workspace")
    }),
  http.protected
    .get("/api/learning/status", "v2.learning.status")
    .seeded((ctx) =>
      Effect.gen(function* () {
        const successful = yield* apiLearning(ctx, {
          userInput: "Successful lifecycle verification",
          success: true,
          tags: ["httpapi"],
          importance: 3,
        })
        const failed = yield* apiLearning(ctx, {
          userInput: "Failed lifecycle verification",
          success: false,
          errorType: "integration",
          errorMessage: "The integration failed before remediation",
          fixStrategy: "Add an end-to-end scenario",
          regression: true,
          tags: ["httpapi", "regression"],
          importance: 5,
        })
        return { successful, failed }
      }),
    )
    .at((ctx) => ({ path: "/api/learning/status", headers: ctx.headers() }))
    .mutating()
    .json(200, (body, ctx) => {
      object(body)
      object(body.data)
      check(body.data.totalTurns === 2, "learning status should count both outcomes")
      check(body.data.successfulTurns === 1 && body.data.failedTurns === 1, "learning status should split outcomes")
      check(body.data.successRate === 0.5, "learning status should calculate success rate")
      check(body.data.fixCount === 1, "learning status should count explicit fixes")
      check(body.data.regressionCount === 1, "learning status should count regressions")
      array(body.data.recent)
      check(
        body.data.recent.some((item: unknown) => isRecord(item) && item.id === ctx.state.successful.id) &&
          body.data.recent.some((item: unknown) => isRecord(item) && item.id === ctx.state.failed.id),
        "learning status should expose both recent outcomes",
      )
      object(body.data.impact)
      check(body.data.impact.status === "insufficient_data", "small samples should disclose insufficient impact data")
    }),
  http.protected
    .delete("/api/learning/outcome/{outcomeID}", "v2.learning.undo")
    .seeded((ctx) =>
      apiLearning(ctx, {
        userInput: "Outcome selected for undo",
        success: false,
        errorType: "temporary",
        tags: ["undo"],
      }),
    )
    .at((ctx) => ({
      path: route("/api/learning/outcome/{outcomeID}", { outcomeID: ctx.state.id }),
      headers: ctx.headers(),
    }))
    .mutating()
    .jsonEffect(200, (body, ctx) =>
      Effect.gen(function* () {
        object(body)
        object(body.data)
        check(body.data.outcomeID === ctx.state.id, "learning undo should report its target")
        check(body.data.deleted === true, "learning undo should report deletion")
        array(body.data.linkedPatterns)
        const status = apiData(
          yield* ctx.api("GET", { path: "/api/learning/status", headers: ctx.headers() }),
          "learning undo verification",
        )
        check(status.totalTurns === 0, "learning undo should remove the outcome from workspace status")
      }),
    ),
  http.protected
    .get("/api/personal-workspace", "v2.personalWorkspace.snapshot")
    .at((ctx) => ({
      path: `/api/personal-workspace?location[directory]=${encodeURIComponent(ctx.directory ?? "")}&limit=10`,
      headers: ctx.headers(),
    }))
    .json(200, (body, ctx) => {
      object(body)
      object(body.project)
      object(body.location)
      check(body.location.directory === ctx.directory, "personal workspace should bind to the requested directory")
      array(body.sessions)
      array(body.tasks)
      array(body.runs)
      array(body.personalJobs)
      array(body.memoryCandidates)
      array(body.attention)
      object(body.counts)
      object(body.cost)
      check(typeof body.asOf === "string", "personal workspace should expose a bounded snapshot timestamp")
    }),
  http.protected
    .post("/api/session/{sessionID}/personal-job", "v2.personalJob.create")
    .seeded(apiSession)
    .at((ctx) => ({
      path: route("/api/session/{sessionID}/personal-job", { sessionID: ctx.state.id }),
      headers: ctx.headers(),
      body: {
        idempotencyKey: "httpapi-personal-job-create",
        title: "HTTP API visible background job",
        prompt: "Read the current workspace and report a bounded verification summary.",
        schedule: {
          kind: "once",
          label: "HTTP API verification",
          nextRunAt: new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString(),
          timezone: "UTC",
        },
        budget: { maxAttempts: 2, maxDurationMs: 60_000, maxCostMicros: 10_000 },
        approvalPolicy: { mode: "automatic", rationale: "The HTTP exerciser owns this isolated job." },
        notificationPolicy: { mode: "in_app", events: ["completed", "failed", "cancelled"] },
      },
    }))
    .mutating()
    .json(200, (body, ctx) => {
      object(body)
      object(body.data)
      const data = body.data as Record<string, unknown>
      check(typeof data.id === "string" && data.id.startsWith("pjob_"), "personal job create should return an ID")
      check(data.sessionID === ctx.state.id, "personal job create should bind to the session")
      check(data.status === "queued", "automatic personal job create should start queued")
      check(
        isRecord(data.visibility) && data.visibility.userVisible === true,
        "personal job create should be user-visible",
      )
      check(data.approvalState === "not_required", "automatic personal job create should not require approval")
    }),
  http.protected
    .get("/api/session/{sessionID}/personal-job", "v2.personalJob.list")
    .seeded((ctx) =>
      Effect.gen(function* () {
        const session = yield* apiSession(ctx)
        const job = yield* apiPersonalJob(ctx, session.id)
        return { session, job }
      }),
    )
    .at((ctx) => ({
      path: route("/api/session/{sessionID}/personal-job", { sessionID: ctx.state.session.id }),
      headers: ctx.headers(),
    }))
    .mutating()
    .json(200, (body, ctx) => {
      object(body)
      array(body.data)
      check(body.data.length === 1, "personal job list should return the seeded job")
      object(body.data[0])
      check(body.data[0].id === ctx.state.job.id, "personal job list should preserve job identity")
      check(body.data[0].sessionID === ctx.state.session.id, "personal job list should preserve session ownership")
    }),
  http.protected
    .get("/api/session/{sessionID}/personal-job/{jobID}", "v2.personalJob.get")
    .seeded((ctx) =>
      Effect.gen(function* () {
        const session = yield* apiSession(ctx)
        const job = yield* apiPersonalJob(ctx, session.id)
        return { session, job }
      }),
    )
    .at((ctx) => ({
      path: route("/api/session/{sessionID}/personal-job/{jobID}", {
        sessionID: ctx.state.session.id,
        jobID: ctx.state.job.id,
      }),
      headers: ctx.headers(),
    }))
    .mutating()
    .json(200, (body, ctx) => {
      object(body)
      object(body.data)
      check(body.data.id === ctx.state.job.id, "personal job get should return the requested job")
      check(body.data.sessionID === ctx.state.session.id, "personal job get should enforce session ownership")
      check(body.data.title === "HTTP API visible background job", "personal job get should preserve the title")
      check(body.data.status === "queued", "personal job get should preserve the queued lifecycle state")
    }),
  http.protected
    .get("/api/session/{sessionID}/personal-job/{jobID}/notifications", "v2.personalJob.notifications")
    .seeded((ctx) =>
      Effect.gen(function* () {
        const session = yield* apiSession(ctx)
        const job = yield* apiPersonalJob(ctx, session.id)
        return { session, job }
      }),
    )
    .at((ctx) => ({
      path: route("/api/session/{sessionID}/personal-job/{jobID}/notifications", {
        sessionID: ctx.state.session.id,
        jobID: ctx.state.job.id,
      }),
      headers: ctx.headers(),
    }))
    .mutating()
    .json(200, (body) => {
      object(body)
      array(body.data)
      check(body.data.length === 0, "a queued automatic personal job should have no unread notifications")
    }),
  http.protected
    .post("/api/session/{sessionID}/personal-job/dispatch", "v2.personalJob.dispatch")
    .seeded(apiSession)
    .at((ctx) => ({
      path: route("/api/session/{sessionID}/personal-job/dispatch", { sessionID: ctx.state.id }),
      headers: ctx.headers(),
      body: { limit: 10 },
    }))
    .mutating()
    .json(200, (body) => {
      object(body)
      object(body.data)
      for (const key of ["recovered", "advanced", "attempted", "completed", "failed", "skipped"]) {
        check(typeof body.data[key] === "number" && body.data[key] >= 0, `personal job dispatch should expose ${key}`)
      }
      check(body.data.attempted === 0, "dispatch should not attempt work when the session has no due jobs")
    }),
  http.protected
    .post("/api/session/{sessionID}/personal-job/{jobID}/approve", "v2.personalJob.approve")
    .seeded(apiSession)
    .at((ctx) => ({
      path: route("/api/session/{sessionID}/personal-job/{jobID}/approve", {
        sessionID: ctx.state.id,
        jobID: "pjob_httpapi_missing",
      }),
      headers: ctx.headers(),
      body: { expectedRevision: 1 },
    }))
    .status(404),
  http.protected
    .post("/api/session/{sessionID}/personal-job/{jobID}/reject", "v2.personalJob.reject")
    .seeded(apiSession)
    .at((ctx) => ({
      path: route("/api/session/{sessionID}/personal-job/{jobID}/reject", {
        sessionID: ctx.state.id,
        jobID: "pjob_httpapi_missing",
      }),
      headers: ctx.headers(),
      body: { expectedRevision: 1, reason: "HTTP API missing-job guard" },
    }))
    .status(404),
  http.protected
    .post("/api/session/{sessionID}/personal-job/{jobID}/start", "v2.personalJob.start")
    .seeded(apiSession)
    .at((ctx) => ({
      path: route("/api/session/{sessionID}/personal-job/{jobID}/start", {
        sessionID: ctx.state.id,
        jobID: "pjob_httpapi_missing",
      }),
      headers: ctx.headers(),
      body: { expectedRevision: 1 },
    }))
    .status(404),
  http.protected
    .post("/api/session/{sessionID}/personal-job/{jobID}/execute", "v2.personalJob.execute")
    .seeded(apiSession)
    .at((ctx) => ({
      path: route("/api/session/{sessionID}/personal-job/{jobID}/execute", {
        sessionID: ctx.state.id,
        jobID: "pjob_httpapi_missing",
      }),
      headers: ctx.headers(),
      body: { expectedRevision: 1 },
    }))
    .status(404),
  http.protected
    .post("/api/session/{sessionID}/personal-job/{jobID}/pause", "v2.personalJob.pause")
    .seeded(apiSession)
    .at((ctx) => ({
      path: route("/api/session/{sessionID}/personal-job/{jobID}/pause", {
        sessionID: ctx.state.id,
        jobID: "pjob_httpapi_missing",
      }),
      headers: ctx.headers(),
      body: { expectedRevision: 1 },
    }))
    .status(404),
  http.protected
    .post("/api/session/{sessionID}/personal-job/{jobID}/resume", "v2.personalJob.resume")
    .seeded(apiSession)
    .at((ctx) => ({
      path: route("/api/session/{sessionID}/personal-job/{jobID}/resume", {
        sessionID: ctx.state.id,
        jobID: "pjob_httpapi_missing",
      }),
      headers: ctx.headers(),
      body: { expectedRevision: 1 },
    }))
    .status(404),
  http.protected
    .post("/api/session/{sessionID}/personal-job/{jobID}/cancel", "v2.personalJob.cancel")
    .seeded(apiSession)
    .at((ctx) => ({
      path: route("/api/session/{sessionID}/personal-job/{jobID}/cancel", {
        sessionID: ctx.state.id,
        jobID: "pjob_httpapi_missing",
      }),
      headers: ctx.headers(),
      body: { expectedRevision: 1, reason: "HTTP API missing-job guard" },
    }))
    .status(404),
  http.protected
    .post(
      "/api/session/{sessionID}/personal-job/{jobID}/notifications/{notificationID}/read",
      "v2.personalJob.notificationRead",
    )
    .seeded(apiSession)
    .at((ctx) => ({
      path: route("/api/session/{sessionID}/personal-job/{jobID}/notifications/{notificationID}/read", {
        sessionID: ctx.state.id,
        jobID: "pjob_httpapi_missing",
        notificationID: "pjn_httpapi_missing",
      }),
      headers: ctx.headers(),
      body: { expectedRevision: 1 },
    }))
    .status(404),
  http.protected
    .delete("/api/session/{sessionID}/personal-job/{jobID}", "v2.personalJob.delete")
    .seeded(apiSession)
    .at((ctx) => ({
      path: route("/api/session/{sessionID}/personal-job/{jobID}", {
        sessionID: ctx.state.id,
        jobID: "pjob_httpapi_missing",
      }),
      headers: ctx.headers(),
      body: { expectedRevision: 1 },
    }))
    .status(404),
  http.protected
    .post("/api/learning/dogfood/sync", "v2.learning.syncDogfood")
    .at((ctx) => ({
      path: "/api/learning/dogfood/sync",
      headers: ctx.headers(),
      body: {
        candidates: [
          {
            task: "Verify the desktop and CLI share one lifecycle",
            success: true,
            timestamp: "2026-07-27T12:00:00.000Z",
            steps: 4,
            toolCalls: ["httpapi", "typecheck"],
          },
          {
            task: "Detect a schedule state corruption",
            success: false,
            timestamp: "2026-07-27T12:05:00.000Z",
            steps: 3,
            toolCalls: ["httpapi"],
            error: "Conflict response mutated state",
          },
        ],
      },
    }))
    .mutating()
    .jsonEffect(200, (body, ctx) =>
      Effect.gen(function* () {
        object(body)
        object(body.data)
        check(body.data.seen === 2, "dogfood sync should count all candidates")
        check(body.data.imported === 2, "dogfood sync should import valid unique candidates")
        check(body.data.skipped === 0 && body.data.failedCandidates === 0, "dogfood sync should report a clean import")
        const status = apiData(
          yield* ctx.api("GET", { path: "/api/learning/status", headers: ctx.headers() }),
          "dogfood sync verification",
        )
        check(status.totalTurns === 2, "dogfood sync should persist imported outcomes")
        check(status.successfulTurns === 1 && status.failedTurns === 1, "dogfood sync should preserve outcomes")
      }),
    ),
  http.protected.get("/api/tenant-platform/overview", "v2.tenantPlatform.overview").json(200, (body) => {
    object(body)
    check(body.schema_version === 1, "tenant platform overview should expose schema version 1")
    object(body.policy)
    object(body.policy.quota)
    object(body.policy.rate_limit)
    object(body.usage)
    check(typeof body.policy.tenant_id === "string", "tenant platform overview should disclose a tenant binding")
    check(typeof body.active_rate_window_count === "number", "tenant platform overview should expose rate windows")
    check(typeof body.pending_requests === "number", "tenant platform overview should expose pending requests")
  }),
  http.protected.get("/api/tenant-platform/secrets", "v2.tenantPlatform.listSecrets").json(200, (body) => {
    array(body)
    for (const item of body) {
      object(item)
      check(typeof item.tenant_id === "string", "tenant secret metadata should remain tenant-bound")
      check(typeof item.secret_id === "string", "tenant secret metadata should expose an opaque ID")
      check(
        typeof item.fingerprint === "string" && /^[a-f0-9]{64}$/.test(item.fingerprint),
        "secret fingerprint should be a digest",
      )
      check(item.status === "active" || item.status === "revoked", "secret metadata should expose a bounded status")
    }
  }),
  http.protected
    .post("/api/tenant-platform/policy", "v2.tenantPlatform.setPolicy")
    .at((ctx) => ({ path: "/api/tenant-platform/policy", headers: ctx.headers(), body: {} }))
    .status(400),
  http.protected
    .post("/api/tenant-platform/data-requests", "v2.tenantPlatform.requestData")
    .at((ctx) => ({ path: "/api/tenant-platform/data-requests", headers: ctx.headers(), body: {} }))
    .status(400),
  http.protected
    .post("/api/tenant-platform/data-requests/{requestID}/approval", "v2.tenantPlatform.approveData")
    .at((ctx) => ({
      path: "/api/tenant-platform/data-requests/tdr_httpapi_missing/approval",
      headers: ctx.headers(),
      body: {},
    }))
    .status(400),
  http.protected
    .post("/api/tenant-platform/backups", "v2.tenantPlatform.createBackup")
    .at((ctx) => ({ path: "/api/tenant-platform/backups", headers: ctx.headers(), body: {} }))
    .status(400),
  http.protected
    .post("/api/tenant-platform/backups/{manifestID}/verify", "v2.tenantPlatform.verifyBackup")
    .at((ctx) => ({
      path: "/api/tenant-platform/backups/tbk_httpapi_missing/verify",
      headers: ctx.headers(),
      body: {},
    }))
    .status(400),
  http.protected
    .post("/api/tenant-platform/audit/export", "v2.tenantPlatform.exportAudit")
    .at((ctx) => ({ path: "/api/tenant-platform/audit/export", headers: ctx.headers() }))
    .mutating()
    .json(200, (body) => {
      object(body)
      check(typeof body.id === "string" && body.id.startsWith("tae_"), "tenant audit export should expose an ID")
      check(typeof body.tenant_id === "string", "tenant audit export should remain tenant-bound")
      check(
        typeof body.export_digest === "string" && /^[a-f0-9]{64}$/.test(body.export_digest),
        "tenant audit export should expose a digest",
      )
      check(body.artifact_media_type === "application/json", "tenant audit export should expose JSON media type")
      check(
        typeof body.artifact_json === "string" && body.artifact_json.length > 0,
        "tenant audit export should include JSON",
      )
    }),
  http.protected
    .post("/api/tenant-platform/secrets/{secretID}/revoke", "v2.tenantPlatform.revokeSecret")
    .at((ctx) => ({
      path: "/api/tenant-platform/secrets/secret_httpapi_missing/revoke",
      headers: ctx.headers(),
    }))
    .status(400),
  http.protected.get("/api/artifacts/owner-context", "v2.artifact.ownerContext").json(200, (body) => {
    object(body)
    object(body.profile)
    object(body.tenant)
    check(body.profile.scope === "profile", "artifact owner context should expose the profile scope")
    check(
      typeof body.profile.id === "string" && body.profile.id.length > 0,
      "artifact owner context should expose profile ID",
    )
    check(body.tenant.scope === "tenant", "artifact owner context should expose the tenant scope")
    check(
      typeof body.tenant.id === "string" && body.tenant.id.length > 0,
      "artifact owner context should expose tenant ID",
    )
    check(typeof body.tenantReadable === "boolean", "artifact owner context should expose tenant read capability")
    check(
      !JSON.stringify(body).toLowerCase().includes("path"),
      "artifact owner context must not expose filesystem paths",
    )
  }),
  http.protected
    .get("/api/artifacts/maintenance-context", "v2.artifact.maintenanceContext")
    .at((ctx) => ({
      path: "/api/artifacts/maintenance-context?scope=profile",
      headers: ctx.headers(),
    }))
    .json(200, (body) => {
      object(body)
      object(body.owner)
      check(body.owner.scope === "profile", "artifact maintenance should remain profile-scoped")
      check(body.maintenanceScope === "profile", "artifact maintenance should disclose its scope")
      check(typeof body.canMaintain === "boolean", "artifact maintenance should expose the capability bit")
      check(body.scan === null || isRecord(body.scan), "artifact maintenance should expose a bounded scan record")
      check(
        typeof body.reason === "string" && body.reason.length > 0,
        "artifact maintenance should explain its current state",
      )
      check(
        !JSON.stringify(body).toLowerCase().includes("path"),
        "artifact maintenance must not expose filesystem paths",
      )
    }),
  http.protected
    .get("/api/agent-capabilities/experience/candidates", "v2.agentCapability.experienceCandidateList")
    .at((ctx) => ({
      path: `/api/agent-capabilities/experience/candidates?location[directory]=${encodeURIComponent(ctx.directory ?? "")}&limit=10`,
      headers: ctx.headers(),
    }))
    .json(
      200,
      locationData((value) => {
        object(value)
        check(value.schema_version === 1, "experience candidate list should expose schema version 1")
        check(value.count === 0, "a fresh workspace should have no experience candidates")
        array(value.items)
        check(value.items.length === 0, "experience candidate list should be empty for a fresh workspace")
      }),
    ),
  http.protected
    .get("/api/agent-capabilities/experience/sources", "v2.agentCapability.experienceSourceList")
    .at((ctx) => ({
      path: `/api/agent-capabilities/experience/sources?location[directory]=${encodeURIComponent(ctx.directory ?? "")}&limit=10`,
      headers: ctx.headers(),
    }))
    .json(
      200,
      locationData((value) => {
        object(value)
        check(value.schema_version === 1, "experience source list should expose schema version 1")
        check(value.count === 0, "a fresh workspace should have no experience sources")
        array(value.items)
        check(value.items.length === 0, "experience source list should be empty for a fresh workspace")
      }),
    ),
  http.protected
    .get("/api/agent-capabilities/skill-lifecycle/candidates", "v2.agentCapability.skillLifecycleCandidateList")
    .at((ctx) => ({
      path: `/api/agent-capabilities/skill-lifecycle/candidates?location[directory]=${encodeURIComponent(ctx.directory ?? "")}&limit=10`,
      headers: ctx.headers(),
    }))
    .json(
      200,
      locationData((value) => {
        object(value)
        check(value.schema_version === 1, "skill lifecycle candidate list should expose schema version 1")
        check(value.count === 0, "a fresh workspace should have no skill lifecycle candidates")
        array(value.items)
        check(value.items.length === 0, "skill lifecycle candidate list should be empty for a fresh workspace")
      }),
    ),
  http.protected
    .post("/api/artifacts/read", "v2.artifact.readScoped")
    .at((ctx) => ({ path: "/api/artifacts/read", headers: ctx.headers(), body: {} }))
    .status(400),
  http.protected
    .post("/api/artifacts/read-range", "v2.artifact.readScopedRange")
    .at((ctx) => ({ path: "/api/artifacts/read-range", headers: ctx.headers(), body: {} }))
    .status(400),
  http.protected
    .post("/api/artifacts/catalog", "v2.artifact.catalogScoped")
    .at((ctx) => ({ path: "/api/artifacts/catalog", headers: ctx.headers(), body: {} }))
    .status(400),
  http.protected
    .post("/api/artifacts/audit", "v2.artifact.auditScoped")
    .at((ctx) => ({ path: "/api/artifacts/audit", headers: ctx.headers(), body: {} }))
    .status(400),
  http.protected
    .post("/api/session/{sessionID}/artifacts/read", "v2.artifact.read")
    .seeded(apiSession)
    .at((ctx) => ({
      path: route("/api/session/{sessionID}/artifacts/read", { sessionID: ctx.state.id }),
      headers: ctx.headers(),
      body: {},
    }))
    .status(400),
  http.protected
    .post("/api/session/{sessionID}/artifacts/read-range", "v2.artifact.readRange")
    .seeded(apiSession)
    .at((ctx) => ({
      path: route("/api/session/{sessionID}/artifacts/read-range", { sessionID: ctx.state.id }),
      headers: ctx.headers(),
      body: {},
    }))
    .status(400),
  http.protected
    .post("/api/session/{sessionID}/artifacts/catalog", "v2.artifact.catalog")
    .seeded(apiSession)
    .at((ctx) => ({
      path: route("/api/session/{sessionID}/artifacts/catalog", { sessionID: ctx.state.id }),
      headers: ctx.headers(),
      body: {},
    }))
    .status(400),
  http.protected
    .post("/api/session/{sessionID}/artifacts/audit", "v2.artifact.audit")
    .seeded(apiSession)
    .at((ctx) => ({
      path: route("/api/session/{sessionID}/artifacts/audit", { sessionID: ctx.state.id }),
      headers: ctx.headers(),
      body: {},
    }))
    .status(400),
  http.protected
    .get("/api/agent-capabilities/experience/candidates/{candidateID}", "v2.agentCapability.experienceCandidateGet")
    .at((ctx) => ({
      path: `/api/agent-capabilities/experience/candidates/exc_httpapi_missing?location[directory]=${encodeURIComponent(ctx.directory ?? "")}`,
      headers: ctx.headers(),
    }))
    .status(400),
  http.protected
    .get(
      "/api/agent-capabilities/skill-lifecycle/candidates/{candidateID}",
      "v2.agentCapability.skillLifecycleCandidateGet",
    )
    .at((ctx) => ({
      path: `/api/agent-capabilities/skill-lifecycle/candidates/skc_000000000000000000000000?location[directory]=${encodeURIComponent(ctx.directory ?? "")}`,
      headers: ctx.headers(),
    }))
    .status(400),
  http.protected
    .get(
      "/api/agent-capabilities/skill-lifecycle/deployments/{skillID}",
      "v2.agentCapability.skillLifecycleDeploymentGet",
    )
    .at((ctx) => ({
      path: `/api/agent-capabilities/skill-lifecycle/deployments/httpapi_missing?location[directory]=${encodeURIComponent(ctx.directory ?? "")}`,
      headers: ctx.headers(),
    }))
    .status(400),
  http.protected
    .get("/api/memory/candidates/{candidateID}", "v2.memory.candidateReview")
    .at((ctx) => ({
      path: `/api/memory/candidates/mcan_httpapi_missing?location[directory]=${encodeURIComponent(ctx.directory ?? "")}`,
      headers: ctx.headers(),
    }))
    .status(400),
  http.protected
    .post(
      "/api/agent-capabilities/experience/candidates/{candidateID}/review",
      "v2.agentCapability.experienceCandidateReview",
    )
    .at((ctx) => ({
      path: `/api/agent-capabilities/experience/candidates/exc_httpapi_missing/review?location[directory]=${encodeURIComponent(ctx.directory ?? "")}`,
      headers: ctx.headers(),
      body: { expectedRevision: 1, decision: "approve", reason: "HTTP API missing-candidate guard" },
    }))
    .status(400),
  http.protected
    .post("/api/agent-capabilities/skill-lifecycle/candidates", "v2.agentCapability.skillLifecycleCandidateCreate")
    .at((ctx) => ({
      path: `/api/agent-capabilities/skill-lifecycle/candidates?location[directory]=${encodeURIComponent(ctx.directory ?? "")}`,
      headers: ctx.headers(),
      body: {},
    }))
    .status(400),
  http.protected
    .post(
      "/api/agent-capabilities/skill-lifecycle/candidates/{candidateID}/evaluate",
      "v2.agentCapability.skillLifecycleEvaluate",
    )
    .at((ctx) => ({
      path: `/api/agent-capabilities/skill-lifecycle/candidates/skc_000000000000000000000000/evaluate?location[directory]=${encodeURIComponent(ctx.directory ?? "")}`,
      headers: ctx.headers(),
      body: {},
    }))
    .status(400),
  http.protected
    .post(
      "/api/agent-capabilities/skill-lifecycle/candidates/{candidateID}/canary/observations",
      "v2.agentCapability.skillLifecycleCanaryObservation",
    )
    .at((ctx) => ({
      path: `/api/agent-capabilities/skill-lifecycle/candidates/skc_000000000000000000000000/canary/observations?location[directory]=${encodeURIComponent(ctx.directory ?? "")}`,
      headers: ctx.headers(),
      body: {},
    }))
    .status(400),
  http.protected
    .post(
      "/api/agent-capabilities/skill-lifecycle/candidates/{candidateID}/canary",
      "v2.agentCapability.skillLifecycleCanaryStart",
    )
    .at((ctx) => ({
      path: `/api/agent-capabilities/skill-lifecycle/candidates/skc_000000000000000000000000/canary?location[directory]=${encodeURIComponent(ctx.directory ?? "")}`,
      headers: ctx.headers(),
      body: {},
    }))
    .status(400),
  http.protected
    .post(
      "/api/agent-capabilities/skill-lifecycle/candidates/{candidateID}/promote",
      "v2.agentCapability.skillLifecyclePromote",
    )
    .at((ctx) => ({
      path: `/api/agent-capabilities/skill-lifecycle/candidates/skc_000000000000000000000000/promote?location[directory]=${encodeURIComponent(ctx.directory ?? "")}`,
      headers: ctx.headers(),
      body: {},
    }))
    .status(400),
  http.protected
    .post(
      "/api/agent-capabilities/skill-lifecycle/candidates/{candidateID}/rollback",
      "v2.agentCapability.skillLifecycleRollback",
    )
    .at((ctx) => ({
      path: `/api/agent-capabilities/skill-lifecycle/candidates/skc_000000000000000000000000/rollback?location[directory]=${encodeURIComponent(ctx.directory ?? "")}`,
      headers: ctx.headers(),
      body: {},
    }))
    .status(400),
  http.protected
    .post("/api/memory/candidates/{candidateID}/approve", "v2.memory.candidateApprove")
    .at((ctx) => ({
      path: `/api/memory/candidates/mcan_httpapi_missing/approve?location[directory]=${encodeURIComponent(ctx.directory ?? "")}`,
      headers: ctx.headers(),
      body: { expectedUpdatedAt: 0, reason: "HTTP API missing-candidate guard" },
    }))
    .status(400),
  http.protected
    .post("/api/memory/candidates/{candidateID}/reject", "v2.memory.candidateReject")
    .at((ctx) => ({
      path: `/api/memory/candidates/mcan_httpapi_missing/reject?location[directory]=${encodeURIComponent(ctx.directory ?? "")}`,
      headers: ctx.headers(),
      body: { expectedUpdatedAt: 0, reason: "HTTP API missing-candidate guard" },
    }))
    .status(400),
  http.protected
    .post("/api/memory/candidates/{candidateID}/activate", "v2.memory.candidateActivate")
    .at((ctx) => ({
      path: `/api/memory/candidates/mcan_httpapi_missing/activate?location[directory]=${encodeURIComponent(ctx.directory ?? "")}`,
      headers: ctx.headers(),
      body: { expectedUpdatedAt: 0, reason: "HTTP API missing-candidate guard" },
    }))
    .status(400),
  http.protected
    .get("/api/private-operations/overview", "v2.privateOperations.overview")
    .json(200, locationData(object)),
  http.protected
    .get("/api/runtime-insight/snapshot", "v2.runtimeInsight.snapshot")
    .at((ctx) => ({
      path: "/api/runtime-insight/snapshot?limit=20",
      headers: ctx.headers(),
    }))
    .json(200, object),
  http.protected
    .get("/api/runtime-insight/actions/{actionID}/recovery", "v2.runtimeInsight.actionRecovery")
    .at((ctx) => ({
      path: `/api/runtime-insight/actions/act_httpapi_missing/recovery?location[directory]=${encodeURIComponent(ctx.directory ?? "")}`,
      headers: ctx.headers(),
    }))
    .status(400),
  http.protected
    .post("/api/runtime-insight/actions/{actionID}/recovery/review", "v2.runtimeInsight.actionRecoveryReview")
    .at((ctx) => ({
      path: `/api/runtime-insight/actions/act_httpapi_missing/recovery/review?location[directory]=${encodeURIComponent(ctx.directory ?? "")}`,
      headers: ctx.headers(),
      body: {},
    }))
    .status(400),
  http.protected
    .post("/api/runtime-insight/actions/{actionID}/recovery/rollback", "v2.runtimeInsight.actionRecoveryRollback")
    .at((ctx) => ({
      path: `/api/runtime-insight/actions/act_httpapi_missing/recovery/rollback?location[directory]=${encodeURIComponent(ctx.directory ?? "")}`,
      headers: ctx.headers(),
      body: {},
    }))
    .status(400),
  http.protected
    .get("/api/runtime-insight/artifacts/maintenance", "v2.runtimeInsight.artifactMaintenance")
    .at((ctx) => ({
      path: "/api/runtime-insight/artifacts/maintenance",
      headers: ctx.headers(),
    }))
    .json(200, (body) => {
      object(body)
      check(body.scope === "profile", "artifact maintenance should report profile scope")
      check(body.operation === "audit", "artifact maintenance GET must remain read-only")
      check(typeof body.referencedCount === "number", "artifact audit should expose reference count")
    }),
  http.protected
    .post("/api/runtime-insight/artifacts/maintenance", "v2.runtimeInsight.artifactMaintenanceSweep")
    .at((ctx) => ({
      path: `/api/runtime-insight/artifacts/maintenance?location[directory]=${encodeURIComponent(ctx.directory ?? "")}`,
      headers: ctx.headers(),
      body: {},
    }))
    .status(400),
  http.protected.get("/api/runtime-insight/audit/verify", "v2.runtimeInsight.auditVerify").json(200, object),
  http.protected
    .get("/api/runtime-insight/settlements/{parentRunID}/{childRunID}", "v2.runtimeInsight.childSettlementAudit")
    .at((ctx) => ({
      path: `/api/runtime-insight/settlements/run_parent_httpapi_missing/run_child_httpapi_missing?location[directory]=${encodeURIComponent(ctx.directory ?? "")}`,
      headers: ctx.headers(),
    }))
    .status(400),
  http.protected
    .post(
      "/api/runtime-insight/settlements/{parentRunID}/{childRunID}/recover",
      "v2.runtimeInsight.childSettlementRecover",
    )
    .at((ctx) => ({
      path: `/api/runtime-insight/settlements/run_parent_httpapi_missing/run_child_httpapi_missing/recover?location[directory]=${encodeURIComponent(ctx.directory ?? "")}`,
      headers: ctx.headers(),
      body: {},
    }))
    .status(400),
  http.protected
    .post("/api/runtime-insight/settlements/recover-pending", "v2.runtimeInsight.childSettlementRecoverySweep")
    .at((ctx) => ({
      path: `/api/runtime-insight/settlements/recover-pending?location[directory]=${encodeURIComponent(ctx.directory ?? "")}`,
      headers: ctx.headers(),
      body: { approval: "recover_settlements", limit: 10 },
    }))
    .json(200, (body) => {
      object(body)
      check(body.schemaVersion === 1, "settlement recovery sweep should expose schema version")
      check(body.status === null, "empty settlement recovery sweep should have no status filter")
      check(body.limit === 10, "settlement recovery sweep should preserve bounded limit")
      check(
        body.scanned === 0 && Array.isArray(body.items) && body.items.length === 0,
        "empty settlement recovery sweep should be empty",
      )
      check(body.deterministic === true, "settlement recovery sweep should be deterministic")
      check(body.providerExecutionAllowed === false, "settlement recovery sweep must not execute providers")
      check(
        isRecord(body.access) && body.access.role === "owner",
        "settlement recovery sweep should expose owner access",
      )
    }),
  http.protected
    .get("/api/subagent-control/{parentRunID}/children", "v2.subagentControl.children")
    .at((ctx) => ({
      path: `/api/subagent-control/run_parent_httpapi_missing/children?location[directory]=${encodeURIComponent(ctx.directory ?? "")}`,
      headers: ctx.headers(),
    }))
    .status(400),
  http.protected
    .post("/api/subagent-control/{parentRunID}/{childRunID}/steer", "v2.subagentControl.steer")
    .at((ctx) => ({
      path: `/api/subagent-control/run_parent_httpapi_missing/run_child_httpapi_missing/steer?location[directory]=${encodeURIComponent(ctx.directory ?? "")}`,
      headers: ctx.headers(),
      body: {},
    }))
    .status(400),
  http.protected
    .post("/api/subagent-control/{parentRunID}/{childRunID}/followup", "v2.subagentControl.followup")
    .at((ctx) => ({
      path: `/api/subagent-control/run_parent_httpapi_missing/run_child_httpapi_missing/followup?location[directory]=${encodeURIComponent(ctx.directory ?? "")}`,
      headers: ctx.headers(),
      body: {},
    }))
    .status(400),
  http.protected
    .post("/api/subagent-control/{parentRunID}/{childRunID}/wait", "v2.subagentControl.wait")
    .at((ctx) => ({
      path: `/api/subagent-control/run_parent_httpapi_missing/run_child_httpapi_missing/wait?location[directory]=${encodeURIComponent(ctx.directory ?? "")}`,
      headers: ctx.headers(),
      body: {},
    }))
    .status(400),
  http.protected
    .post("/api/subagent-control/{parentRunID}/{childRunID}/cancel", "v2.subagentControl.cancel")
    .at((ctx) => ({
      path: `/api/subagent-control/run_parent_httpapi_missing/run_child_httpapi_missing/cancel?location[directory]=${encodeURIComponent(ctx.directory ?? "")}`,
      headers: ctx.headers(),
      body: {},
    }))
    .status(400),
  http.protected
    .get("/api/subagent-control/{parentRunID}/{childRunID}/{operation}/{requestID}", "v2.subagentControl.status")
    .at((ctx) => ({
      path: `/api/subagent-control/run_parent_httpapi_missing/run_child_httpapi_missing/steer/cpr_httpapi_missing?location[directory]=${encodeURIComponent(ctx.directory ?? "")}`,
      headers: ctx.headers(),
    }))
    .status(400),
  http.protected
    .get("/api/mcp/capabilities", "v2.mcp.capabilities")
    .at((ctx) => ({
      path: `/api/mcp/capabilities?location[directory]=${encodeURIComponent(ctx.directory ?? "")}`,
      headers: ctx.headers(),
    }))
    .json(
      200,
      locationData((value) => {
        array(value)
        check(value.length === 0, "embedded Core MCP capabilities should explicitly report no owned transports")
      }),
    ),
  http.protected.get("/api/mcp", "v2.mcp.list").json(
    200,
    locationData((value) => {
      array(value)
      check(value.length === 0, "embedded Core MCP list should explicitly report no owned transports")
    }),
  ),
  http.protected.get("/api/mcp/resource", "v2.mcp.resource.catalog").json(
    200,
    locationData((value) => {
      object(value)
      array(value.resources)
      array(value.templates)
      check(
        value.resources.length === 0 && value.templates.length === 0,
        "embedded Core MCP catalog should explicitly report no transport resources",
      )
    }),
  ),
  http.protected
    .get("/api/mcp/actions/{actionID}/reconciliation", "v2.mcp.action.reconciliation")
    .at((ctx) => ({
      path: `/api/mcp/actions/action_httpapi_missing/reconciliation?location[directory]=${encodeURIComponent(ctx.directory ?? "")}&intentDigest=${"0".repeat(64)}&idempotencyKey=httpapi-missing`,
      headers: ctx.headers(),
    }))
    .status(400),
  http.protected
    .post("/api/mcp/actions/{actionID}/reconciliation/record", "v2.mcp.action.reconciliationRecord")
    .at((ctx) => ({
      path: `/api/mcp/actions/action_httpapi_missing/reconciliation/record?location[directory]=${encodeURIComponent(ctx.directory ?? "")}&intentDigest=${"0".repeat(64)}&idempotencyKey=httpapi-missing`,
      headers: ctx.headers(),
      body: { expectedEvidenceDigest: "0".repeat(64), approval: "record_evidence" },
    }))
    .status(400),
  http.protected
    .post("/api/mcp/{server}/connect", "v2.mcp.connect")
    .at((ctx) => ({
      path: route("/api/mcp/{server}/connect", { server: "unconfigured-httpapi-server" }),
      headers: ctx.headers(),
    }))
    .json(
      404,
      (body) => {
        object(body)
        check(body._tag === "McpServerNotFoundError", "MCP connect should return the typed unavailable-server error")
        check(body.server === "unconfigured-httpapi-server", "MCP connect should report the requested server")
        check(
          typeof body.message === "string" && body.message.length > 0,
          "MCP connect should disclose why the server is unavailable",
        )
      },
      "status",
    ),
  http.protected
    .post("/api/mcp/{server}/disconnect", "v2.mcp.disconnect")
    .at((ctx) => ({
      path: route("/api/mcp/{server}/disconnect", { server: "unconfigured-httpapi-server" }),
      headers: ctx.headers(),
    }))
    .json(
      404,
      (body) => {
        object(body)
        check(body._tag === "McpServerNotFoundError", "MCP disconnect should return the typed unavailable-server error")
        check(body.server === "unconfigured-httpapi-server", "MCP disconnect should report the requested server")
        check(
          typeof body.message === "string" && body.message.length > 0,
          "MCP disconnect should disclose why the server is unavailable",
        )
      },
      "status",
    ),
  http.protected
    .get("/experimental/control-approval", "experimental.controlApproval.list")
    .at((ctx) => ({
      path: "/experimental/control-approval",
      headers: ctx.headers(),
    }))
    .json(200, array),
  http.protected
    .post("/experimental/control-approval/{requestID}/reply", "experimental.controlApproval.reply")
    .at((ctx) => ({
      path: "/experimental/control-approval/per_httpapi_missing/reply",
      headers: ctx.headers(),
      body: { reply: "reject", message: "HTTP API exercise" },
    }))
    .status(400),
  http.protected
    .get("/experimental/control-operation/{requestID}", "experimental.controlOperation.status")
    .at((ctx) => ({
      path: "/experimental/control-operation/cpr_status_missing?operation=worktree.create",
      headers: ctx.headers(),
    }))
    .status(400),
  http.protected
    .get("/api/session/{sessionID}/wait", "v2.cooperativeWait.active")
    .seeded(apiSession)
    .at((ctx) => ({
      path: route("/api/session/{sessionID}/wait", { sessionID: ctx.state.id }),
      headers: ctx.headers(),
    }))
    .mutating()
    .json(200, (body) => {
      object(body)
      check(body.data === null, "a session without an Agent-created wait should report no active wait")
    }),
  http.protected
    .post("/api/session/{sessionID}/wait/{waitID}/wake", "v2.cooperativeWait.wake")
    .seeded(apiSession)
    .at((ctx) => ({
      path: route("/api/session/{sessionID}/wait/{waitID}/wake", {
        sessionID: ctx.state.id,
        waitID: "wait_httpapi_missing",
      }),
      headers: ctx.headers(),
    }))
    .mutating()
    .json(
      404,
      (body, ctx) => {
        object(body)
        check(body._tag === "WaitNotFoundError", "wake should return the typed no-active-wait error")
        check(body.sessionID === ctx.state.id, "wake error should preserve session ownership")
        check(typeof body.message === "string" && body.message.length > 0, "wake error should explain the state")
      },
      "status",
    ),
  http.protected
    .post("/api/diagnostics/multimodal", "v2.multimodalDiagnosis.diagnose")
    .at((ctx) => ({
      path: "/api/diagnostics/multimodal",
      headers: ctx.headers(),
      body: {
        filename: "desktop-error-screenshot.png",
        extractedText:
          "Module not found: Can't resolve 'missing-private-adapter'\n    at E:\\Arforge-Agent\\src\\desktop.ts:42:7\nNameError: name 'rendererState' is not defined",
        limit: 10,
      },
    }))
    .json(200, (body) => {
      object(body)
      object(body.data)
      check(body.data.schemaVersion === 1, "multimodal diagnosis should report schema version")
      check(body.data.localOnly === true, "multimodal diagnosis should remain local")
      check(body.data.modelCalls === 0, "multimodal diagnosis should make zero model calls")
      check(body.data.success === true, "provided diagnostic text should be processed successfully")
      object(body.data.source)
      check(body.data.source.type === "provided_text", "multimodal diagnosis should disclose the provided-text source")
      check(body.data.source.success === true, "provided diagnostic text should be readable")
      array(body.data.signals)
      check(body.data.signals.length >= 2, "multimodal diagnosis should extract multiple deterministic error signals")
      check(
        body.data.signals.some(
          (signal: unknown) =>
            isRecord(signal) && signal.kind === "missing_module" && signal.value === "missing-private-adapter",
        ),
        "multimodal diagnosis should identify the missing module",
      )
      array(body.data.searchTerms)
      check(
        body.data.searchTerms.includes("missing-private-adapter"),
        "multimodal diagnosis should derive search terms",
      )
      object(body.data.summary)
      check(body.data.summary.signals === body.data.signals.length, "multimodal summary should count extracted signals")
    }),
  http.protected
    .post("/api/session/{sessionID}/agent", "v2.session.switchAgent")
    .seeded((ctx) => ctx.session({ title: "Switch agent" }))
    .at((ctx) => ({
      path: route("/api/session/{sessionID}/agent", { sessionID: ctx.state.id }),
      headers: { ...ctx.headers(), "content-type": "application/json" },
      body: { agent: "plan" },
    }))
    .status(204, undefined, "none"),
  http.protected
    .post("/api/session/{sessionID}/model", "v2.session.switchModel")
    .seeded((ctx) => ctx.session({ title: "Switch model" }))
    .at((ctx) => ({
      path: route("/api/session/{sessionID}/model", { sessionID: ctx.state.id }),
      headers: { ...ctx.headers(), "content-type": "application/json" },
      body: { model: { providerID: "arforge", id: "big-pickle" } },
    }))
    .status(204, undefined, "none"),
  http.protected
    .get("/api/session/{sessionID}/context", "v2.session.context")
    .at((ctx) => ({
      path: route("/api/session/{sessionID}/context", { sessionID: "ses_httpapi_missing" }),
      headers: ctx.headers(),
    }))
    .json(404, object, "status"),
  http.protected
    .post("/api/session/{sessionID}/revert/stage", "v2.session.revert.stage")
    .at((ctx) => ({
      path: route("/api/session/{sessionID}/revert/stage", { sessionID: "ses_httpapi_missing" }),
      headers: { ...ctx.headers(), "content-type": "application/json" },
      body: { messageID: "msg_httpapi_missing" },
    }))
    .json(404, object, "status"),
  http.protected
    .post("/api/session/{sessionID}/revert/clear", "v2.session.revert.clear")
    .at((ctx) => ({
      path: route("/api/session/{sessionID}/revert/clear", { sessionID: "ses_httpapi_missing" }),
      headers: ctx.headers(),
    }))
    .json(404, object, "status"),
  http.protected
    .post("/api/session/{sessionID}/revert/commit", "v2.session.revert.commit")
    .at((ctx) => ({
      path: route("/api/session/{sessionID}/revert/commit", { sessionID: "ses_httpapi_missing" }),
      headers: ctx.headers(),
    }))
    .json(404, object, "status"),
  http.protected
    .get("/api/session/{sessionID}/message", "v2.session.messages")
    .at((ctx) => ({
      path: route("/api/session/{sessionID}/message", { sessionID: "ses_httpapi_missing" }),
      headers: ctx.headers(),
    }))
    .json(404, object, "status"),
  http.protected
    .get("/api/session/{sessionID}/message", "v2.session.messages.params")
    .at((ctx) => ({
      path: `${route("/api/session/{sessionID}/message", { sessionID: "ses_httpapi_missing" })}?${new URLSearchParams({
        limit: "2",
        order: "asc",
      })}`,
      headers: ctx.headers(),
    }))
    .json(404, object, "status"),
  http.protected
    .get("/api/session/{sessionID}/message", "v2.session.messages.cursor")
    .at((ctx) => ({
      path: `${route("/api/session/{sessionID}/message", { sessionID: "ses_httpapi_missing" })}?${new URLSearchParams({
        limit: "2",
        directory: ctx.directory ?? "",
        cursor: cursor({ id: "msg_httpapi_missing", time: 0, order: "desc", direction: "next" }),
      })}`,
      headers: ctx.headers(),
    }))
    .json(404, object, "status"),
  http.protected
    .get("/api/session/{sessionID}/message", "v2.session.messages.cursor.invalid")
    .seeded((ctx) => ctx.session({ title: "Invalid message cursor owner" }))
    .at((ctx) => ({
      path: `${route("/api/session/{sessionID}/message", { sessionID: ctx.state.id })}?${new URLSearchParams({
        cursor: cursor({ id: "msg_httpapi_missing", time: 0, order: "desc", direction: "next" }),
        order: "asc",
      })}`,
      headers: ctx.headers(),
    }))
    .status(400, undefined, "none"),
  http.protected
    .get("/api/session/{sessionID}/history", "v2.session.history")
    .seeded((ctx) => ctx.session({ title: "Session history" }))
    .at((ctx) => ({
      path: `${route("/api/session/{sessionID}/history", { sessionID: ctx.state.id })}?${new URLSearchParams({
        after: "0",
        limit: "2",
      })}`,
      headers: ctx.headers(),
    }))
    .json(
      200,
      (body) => {
        object(body)
        array(body.data)
        check(typeof body.hasMore === "boolean", "Expected a history exhaustion signal")
      },
      "none",
    ),
  http.protected
    .get("/api/session/{sessionID}/history", "v2.session.history.missing")
    .at((ctx) => ({
      path: route("/api/session/{sessionID}/history", { sessionID: "ses_httpapi_missing" }),
      headers: ctx.headers(),
    }))
    .json(404, object, "status"),
  http.protected
    .get("/api/session/{sessionID}/history", "v2.session.history.invalid")
    .seeded((ctx) => ctx.session({ title: "Invalid history sequence" }))
    .at((ctx) => ({
      path: `${route("/api/session/{sessionID}/history", { sessionID: ctx.state.id })}?after=-1`,
      headers: ctx.headers(),
    }))
    .json(400, object, "status"),
  http.protected
    .get("/api/session/{sessionID}/event", "v2.session.events.missing")
    .at((ctx) => ({
      path: `${route("/api/session/{sessionID}/event", { sessionID: "ses_httpapi_missing" })}?after=0`,
      headers: ctx.headers(),
    }))
    .status(404, undefined, "status"),
  http.protected
    .post("/api/session/{sessionID}/interrupt", "v2.session.interrupt")
    .seeded((ctx) => ctx.session({ title: "Interrupt session" }))
    .at((ctx) => ({
      path: route("/api/session/{sessionID}/interrupt", { sessionID: ctx.state.id }),
      headers: ctx.headers(),
    }))
    .status(204, undefined, "none"),
  http.protected
    .get("/api/session/{sessionID}/message/{messageID}", "v2.session.message.missing")
    .at((ctx) => ({
      path: route("/api/session/{sessionID}/message/{messageID}", {
        sessionID: "ses_httpapi_missing",
        messageID: "msg_httpapi_missing",
      }),
      headers: ctx.headers(),
    }))
    .json(404, object, "status"),
  http.protected
    .post("/api/session/{sessionID}/prompt", "v2.session.prompt.invalid")
    .seeded((ctx) => ctx.session({ title: "Invalid prompt owner" }))
    .at((ctx) => ({
      path: route("/api/session/{sessionID}/prompt", { sessionID: ctx.state.id }),
      headers: ctx.headers(),
      body: {},
    }))
    .status(400, undefined, "none"),
  http.protected
    .post("/api/session/{sessionID}/compact", "v2.session.compact")
    .at((ctx) => ({
      path: route("/api/session/{sessionID}/compact", { sessionID: "ses_httpapi_missing" }),
      headers: ctx.headers(),
    }))
    .status(404, undefined, "status"),
  http.protected
    .post("/api/session/{sessionID}/wait", "v2.session.wait")
    .at((ctx) => ({
      path: route("/api/session/{sessionID}/wait", { sessionID: "ses_httpapi_missing" }),
      headers: ctx.headers(),
    }))
    .status(404, undefined, "status"),
  http.protected
    .get("/session", "session.list")
    .seeded((ctx) => ctx.session({ title: "List me" }))
    .at((ctx) => ({ path: "/session?roots=true", headers: ctx.headers() }))
    .json(200, (body, ctx) => {
      array(body)
      check(
        body.some((item) => isRecord(item) && item.id === ctx.state.id && item.title === "List me"),
        "seeded session should be listed",
      )
    }),
  http.protected
    .get("/session/status", "session.status")
    .seeded((ctx) => ctx.session({ title: "Status session" }))
    .json(200, object),
  http.protected
    .post("/session", "session.create")
    .mutating()
    .at((ctx) => ({ path: "/session", headers: ctx.headers(), body: { title: "Created session" } }))
    .json(
      200,
      (body, ctx) => {
        object(body)
        check(body.title === "Created session", "created session should use requested title")
        check(body.directory === ctx.directory, "created session should use scenario directory")
      },
      "status",
    ),
  http.protected
    .get("/session/{sessionID}", "session.get")
    .seeded((ctx) => ctx.session({ title: "Get me" }))
    .at((ctx) => ({ path: route("/session/{sessionID}", { sessionID: ctx.state.id }), headers: ctx.headers() }))
    .json(200, (body, ctx) => {
      object(body)
      check(body.id === ctx.state.id, "should return requested session")
      check(body.title === "Get me", "should preserve seeded title")
    }),
  http.protected
    .get("/session/{sessionID}", "session.get.missing")
    .at((ctx) => ({
      path: route("/session/{sessionID}", { sessionID: "ses_httpapi_missing" }),
      headers: ctx.headers(),
    }))
    .status(404),
  http.protected
    .patch("/session/{sessionID}", "session.update")
    .mutating()
    .seeded((ctx) => ctx.session({ title: "Before rename" }))
    .at((ctx) => ({
      path: route("/session/{sessionID}", { sessionID: ctx.state.id }),
      headers: ctx.headers(),
      body: { title: "After rename" },
    }))
    .json(
      200,
      (body) => {
        object(body)
        check(body.title === "After rename", "updated session should use new title")
      },
      "status",
    ),
  http.protected
    .patch("/session/{sessionID}", "session.update.invalid")
    .mutating()
    .at((ctx) => ({
      path: route("/session/{sessionID}", { sessionID: "ses_httpapi_missing" }),
      headers: ctx.headers(),
      body: { title: 1 },
    }))
    .status(400),
  http.protected
    .delete("/session/{sessionID}", "session.delete")
    .mutating()
    .seeded((ctx) => ctx.session({ title: "Delete me" }))
    .at((ctx) => ({ path: route("/session/{sessionID}", { sessionID: ctx.state.id }), headers: ctx.headers() }))
    .jsonEffect(200, (body, ctx) =>
      Effect.gen(function* () {
        check(body === true, "delete should return true")
        check((yield* ctx.sessionGet(ctx.state.id)) === undefined, "deleted session should not remain in storage")
      }),
    ),
  http.protected
    .get("/session/{sessionID}/children", "session.children")
    .seeded((ctx) =>
      Effect.gen(function* () {
        const parent = yield* ctx.session({ title: "Parent" })
        const child = yield* ctx.session({ title: "Child", parentID: parent.id })
        return { parent, child }
      }),
    )
    .at((ctx) => ({
      path: route("/session/{sessionID}/children", { sessionID: ctx.state.parent.id }),
      headers: ctx.headers(),
    }))
    .json(200, (body, ctx) => {
      array(body)
      check(
        body.some((item) => isRecord(item) && item.id === ctx.state.child.id && item.parentID === ctx.state.parent.id),
        "children should include seeded child",
      )
    }),
  http.protected
    .get("/session/{sessionID}/todo", "session.todo")
    .seeded((ctx) =>
      Effect.gen(function* () {
        const session = yield* ctx.session({ title: "Todo session" })
        const todos = [{ content: "cover session todo", status: "pending" as const, priority: "high" as const }]
        yield* ctx.todos(session.id, todos)
        return { session, todos }
      }),
    )
    .at((ctx) => ({
      path: route("/session/{sessionID}/todo", { sessionID: ctx.state.session.id }),
      headers: ctx.headers(),
    }))
    .json(200, (body, ctx) => {
      check(stable(body) === stable(ctx.state.todos), "todos should match seeded state")
    }),
  http.protected
    .get("/session/{sessionID}/diff", "session.diff")
    .seeded((ctx) => ctx.session({ title: "Diff session" }))
    .at((ctx) => ({ path: route("/session/{sessionID}/diff", { sessionID: ctx.state.id }), headers: ctx.headers() }))
    .json(200, array),
  http.protected
    .get("/session/{sessionID}/message", "session.messages")
    .seeded((ctx) => ctx.session({ title: "Messages session" }))
    .at((ctx) => ({ path: route("/session/{sessionID}/message", { sessionID: ctx.state.id }), headers: ctx.headers() }))
    .json(200, (body) => {
      array(body)
      check(body.length === 0, "new session should have no messages")
    }),
  http.protected
    .get("/session/{sessionID}/message/{messageID}", "session.message")
    .seeded((ctx) =>
      Effect.gen(function* () {
        const session = yield* ctx.session({ title: "Message get session" })
        const message = yield* ctx.message(session.id, { text: "read me" })
        return { session, message }
      }),
    )
    .at((ctx) => ({
      path: route("/session/{sessionID}/message/{messageID}", {
        sessionID: ctx.state.session.id,
        messageID: ctx.state.message.info.id,
      }),
      headers: ctx.headers(),
    }))
    .json(200, (body, ctx) => {
      object(body)
      check(isRecord(body.info) && body.info.id === ctx.state.message.info.id, "should return requested message")
      check(
        Array.isArray(body.parts) && body.parts.some((part) => isRecord(part) && part.id === ctx.state.message.part.id),
        "message should include seeded part",
      )
    }),
  http.protected
    .patch("/session/{sessionID}/message/{messageID}/part/{partID}", "part.update")
    .mutating()
    .seeded((ctx) =>
      Effect.gen(function* () {
        const session = yield* ctx.session({ title: "Part update session" })
        const message = yield* ctx.message(session.id, { text: "before" })
        return { session, message }
      }),
    )
    .at((ctx) => ({
      path: route("/session/{sessionID}/message/{messageID}/part/{partID}", {
        sessionID: ctx.state.session.id,
        messageID: ctx.state.message.info.id,
        partID: ctx.state.message.part.id,
      }),
      headers: ctx.headers(),
      body: { ...ctx.state.message.part, text: "after" },
    }))
    .json(
      200,
      (body) => {
        object(body)
        check(body.type === "text" && body.text === "after", "updated part should be returned")
      },
      "status",
    ),
  http.protected
    .delete("/session/{sessionID}/message/{messageID}/part/{partID}", "part.delete")
    .mutating()
    .seeded((ctx) =>
      Effect.gen(function* () {
        const session = yield* ctx.session({ title: "Part delete session" })
        const message = yield* ctx.message(session.id, { text: "delete part" })
        return { session, message }
      }),
    )
    .at((ctx) => ({
      path: route("/session/{sessionID}/message/{messageID}/part/{partID}", {
        sessionID: ctx.state.session.id,
        messageID: ctx.state.message.info.id,
        partID: ctx.state.message.part.id,
      }),
      headers: ctx.headers(),
    }))
    .jsonEffect(200, (body, ctx) =>
      Effect.gen(function* () {
        check(body === true, "delete part should return true")
        const messages = yield* ctx.messages(ctx.state.session.id)
        check(messages[0]?.parts.length === 0, "deleted part should not remain on message")
      }),
    ),
  http.protected
    .delete("/session/{sessionID}/message/{messageID}", "session.deleteMessage")
    .mutating()
    .seeded((ctx) =>
      Effect.gen(function* () {
        const session = yield* ctx.session({ title: "Message delete session" })
        const message = yield* ctx.message(session.id, { text: "delete message" })
        return { session, message }
      }),
    )
    .at((ctx) => ({
      path: route("/session/{sessionID}/message/{messageID}", {
        sessionID: ctx.state.session.id,
        messageID: ctx.state.message.info.id,
      }),
      headers: ctx.headers(),
    }))
    .jsonEffect(200, (body, ctx) =>
      Effect.gen(function* () {
        check(body === true, "delete message should return true")
        check((yield* ctx.messages(ctx.state.session.id)).length === 0, "deleted message should not remain")
      }),
    ),
  http.protected
    .post("/session/{sessionID}/fork", "session.fork")
    .mutating()
    .seeded((ctx) => ctx.session({ title: "Fork source" }))
    .at((ctx) => ({
      path: route("/session/{sessionID}/fork", { sessionID: ctx.state.id }),
      headers: ctx.headers(),
      body: {},
    }))
    .json(
      200,
      (body) => {
        object(body)
        check(typeof body.id === "string", "fork should return a session")
      },
      "status",
    ),
  http.protected
    .post("/session/{sessionID}/abort", "session.abort")
    .mutating()
    .seeded((ctx) => ctx.session({ title: "Abort session" }))
    .at((ctx) => ({ path: route("/session/{sessionID}/abort", { sessionID: ctx.state.id }), headers: ctx.headers() }))
    .json(200, (body) => {
      check(body === true, "abort should return true")
    }),
  http.protected
    .post("/session/{sessionID}/abort", "session.abort.missing")
    .at((ctx) => ({
      path: route("/session/{sessionID}/abort", { sessionID: "ses_httpapi_missing" }),
      headers: ctx.headers(),
    }))
    .json(200, (body) => {
      check(body === true, "missing session abort should remain a no-op success")
    }),
  http.protected
    .post("/session/{sessionID}/init", "session.init")
    .withLlm()
    .seeded((ctx) =>
      Effect.gen(function* () {
        const session = yield* ctx.session({ title: "Init session" })
        const message = yield* ctx.message(session.id, { text: "initialize" })
        yield* ctx.llmText("initialized")
        yield* ctx.llmText("initialized")
        return { session, message }
      }),
    )
    .at((ctx) => ({
      path: route("/session/{sessionID}/init", { sessionID: ctx.state.session.id }),
      headers: ctx.headers(),
      body: { providerID: "test", modelID: "test-model", messageID: ctx.state.message.info.id },
    }))
    .jsonEffect(200, (body, ctx) =>
      Effect.gen(function* () {
        check(body === true, "init should return true")
        yield* ctx.llmWait(1)
      }),
    ),
  http.protected
    .post("/session/{sessionID}/message", "session.prompt")
    .withLlm()
    .seeded((ctx) =>
      Effect.gen(function* () {
        const session = yield* ctx.session({ title: "LLM prompt session" })
        yield* ctx.llmText("fake assistant")
        yield* ctx.llmText("fake assistant")
        return session
      }),
    )
    .at((ctx) => ({
      path: route("/session/{sessionID}/message", { sessionID: ctx.state.id }),
      headers: ctx.headers(),
      body: {
        agent: "build",
        model: { providerID: "test", modelID: "test-model" },
        parts: [{ type: "text", text: "hello llm" }],
      },
    }))
    .jsonEffect(
      200,
      (body, ctx) =>
        Effect.gen(function* () {
          object(body)
          check(isRecord(body.info) && body.info.role === "assistant", "prompt should return assistant message")
          check(
            Array.isArray(body.parts) && body.parts.some((part) => isRecord(part) && part.text === "fake assistant"),
            "assistant message should use fake LLM text",
          )
          yield* ctx.llmWait(1)
        }),
      "status",
    ),
  http.protected
    .post("/session/{sessionID}/prompt_async", "session.prompt_async")
    .withLlm()
    .seeded((ctx) =>
      Effect.gen(function* () {
        const session = yield* ctx.session({ title: "Async prompt session" })
        yield* ctx.llmText("fake async assistant")
        yield* ctx.llmText("fake async assistant")
        return session
      }),
    )
    .at((ctx) => ({
      path: route("/session/{sessionID}/prompt_async", { sessionID: ctx.state.id }),
      headers: ctx.headers(),
      body: {
        agent: "build",
        model: { providerID: "test", modelID: "test-model" },
        parts: [{ type: "text", text: "hello async" }],
      },
    }))
    .status(204, (ctx) =>
      Effect.gen(function* () {
        yield* ctx.llmWait(1)
      }),
    ),
  http.protected
    .post("/session/{sessionID}/command", "session.command")
    .withLlm()
    .seeded((ctx) =>
      Effect.gen(function* () {
        const session = yield* ctx.session({ title: "Command session" })
        yield* ctx.llmText("command done")
        yield* ctx.llmText("command done")
        return session
      }),
    )
    .at((ctx) => ({
      path: route("/session/{sessionID}/command", { sessionID: ctx.state.id }),
      headers: ctx.headers(),
      body: { command: "init", arguments: "", model: "test/test-model" },
    }))
    .jsonEffect(
      200,
      (body, ctx) =>
        Effect.gen(function* () {
          object(body)
          check(isRecord(body.info) && body.info.role === "assistant", "command should return assistant message")
          yield* ctx.llmWait(1)
        }),
      "status",
    ),
  http.protected
    .post("/session/{sessionID}/shell", "session.shell")
    .mutating()
    .seeded((ctx) => ctx.session({ title: "Shell session" }))
    .at((ctx) => ({
      path: route("/session/{sessionID}/shell", { sessionID: ctx.state.id }),
      headers: ctx.headers(),
      body: { agent: "build", model: { providerID: "test", modelID: "test-model" }, command: 1 },
    }))
    .status(400),
  http.protected
    .post("/session/{sessionID}/summarize", "session.summarize")
    .preserveDatabase()
    .withLlm()
    .seeded((ctx) =>
      Effect.gen(function* () {
        const session = yield* ctx.session({ title: "Summarize session" })
        yield* ctx.message(session.id, { text: "summarize this work" })
        const summary = [
          "## Objective",
          "- Exercise session summarize.",
          "",
          "## Important Details",
          "- Use fake LLM.",
          "- Keep route local.",
          "- Test fixture: test/server/httpapi-exercise/index.ts.",
          "",
          "## Work State",
          "- Completed: Summary generated.",
          "- Active: (none)",
          "- Blocked: (none)",
          "",
          "## Next Move",
          "1. (none)",
        ].join("\n")
        yield* ctx.llmText(summary)
        yield* ctx.llmText(summary)
        return session
      }),
    )
    .at((ctx) => ({
      path: route("/session/{sessionID}/summarize", { sessionID: ctx.state.id }),
      headers: ctx.headers(),
      body: { providerID: "test", modelID: "test-model", auto: false },
    }))
    .jsonEffect(
      200,
      (body, ctx) =>
        Effect.gen(function* () {
          check(body === true, "summarize should return true")
          const messages = yield* ctx.messages(ctx.state.id)
          check(
            messages.some((message) => message.info.role === "assistant" && message.info.summary === true),
            "summarize should create a summary assistant message",
          )
          yield* ctx.llmWait(1)
        }),
      "status",
    ),
  http.protected
    .post("/session/{sessionID}/revert", "session.revert")
    .mutating()
    .seeded((ctx) =>
      Effect.gen(function* () {
        const session = yield* ctx.session({ title: "Revert session" })
        const message = yield* ctx.message(session.id, { text: "revert me" })
        return { session, message }
      }),
    )
    .at((ctx) => ({
      path: route("/session/{sessionID}/revert", { sessionID: ctx.state.session.id }),
      headers: ctx.headers(),
      body: { messageID: ctx.state.message.info.id },
    }))
    .json(503, (body) => {
      object(body)
      check(body._tag === "ServiceUnavailableError", "legacy revert should fail with a typed unavailable error")
      check(body.service === "session.revert", "legacy revert should identify the blocked service")
    }),
  http.protected
    .post("/session/{sessionID}/unrevert", "session.unrevert")
    .mutating()
    .seeded((ctx) => ctx.session({ title: "Unrevert session" }))
    .at((ctx) => ({
      path: route("/session/{sessionID}/unrevert", { sessionID: ctx.state.id }),
      headers: ctx.headers(),
    }))
    .json(503, (body) => {
      object(body)
      check(body._tag === "ServiceUnavailableError", "legacy unrevert should fail with a typed unavailable error")
      check(body.service === "session.unrevert", "legacy unrevert should identify the blocked service")
    }),
  http.protected
    .post("/session/{sessionID}/permissions/{permissionID}", "permission.respond")
    .seeded((ctx) => ctx.session({ title: "Deprecated permission session" }))
    .at((ctx) => ({
      path: route("/session/{sessionID}/permissions/{permissionID}", {
        sessionID: ctx.state.id,
        permissionID: "per_httpapi_deprecated",
      }),
      headers: ctx.headers(),
      body: { response: "once" },
    }))
    .json(404, object, "status"),
  http.protected
    .post("/session/{sessionID}/share", "session.share")
    .mutating()
    .seeded((ctx) => ctx.session({ title: "Share session" }))
    .at((ctx) => ({ path: route("/session/{sessionID}/share", { sessionID: ctx.state.id }), headers: ctx.headers() }))
    .json(503, (body) => {
      object(body)
      check(body._tag === "ServiceUnavailableError", "legacy share should fail with a typed unavailable error")
      check(body.service === "session.share", "legacy share should identify the blocked service")
    }),
  http.protected
    .delete("/session/{sessionID}/share", "session.unshare")
    .mutating()
    .seeded((ctx) => ctx.session({ title: "Unshare session" }))
    .at((ctx) => ({ path: route("/session/{sessionID}/share", { sessionID: ctx.state.id }), headers: ctx.headers() }))
    .json(503, (body) => {
      object(body)
      check(body._tag === "ServiceUnavailableError", "legacy unshare should fail with a typed unavailable error")
      check(body.service === "session.unshare", "legacy unshare should identify the blocked service")
    }),
  http.protected
    .post("/tui/append-prompt", "tui.appendPrompt")
    .at((ctx) => ({ path: "/tui/append-prompt", headers: ctx.headers(), body: { text: "hello" } }))
    .json(200, boolean, "status"),
  http.protected
    .post("/tui/select-session", "tui.selectSession.invalid")
    .at((ctx) => ({ path: "/tui/select-session", headers: ctx.headers(), body: { sessionID: "invalid" } }))
    .status(400),
  http.protected.post("/tui/open-help", "tui.openHelp").json(200, boolean, "status"),
  http.protected.post("/tui/open-sessions", "tui.openSessions").json(200, boolean, "status"),
  http.protected.post("/tui/open-themes", "tui.openThemes").json(200, boolean, "status"),
  http.protected.post("/tui/open-models", "tui.openModels").json(200, boolean, "status"),
  http.protected.post("/tui/submit-prompt", "tui.submitPrompt").json(200, boolean, "status"),
  http.protected.post("/tui/clear-prompt", "tui.clearPrompt").json(200, boolean, "status"),
  http.protected
    .post("/tui/execute-command", "tui.executeCommand")
    .at((ctx) => ({ path: "/tui/execute-command", headers: ctx.headers(), body: { command: "agent_cycle" } }))
    .json(200, boolean, "status"),
  http.protected
    .post("/tui/show-toast", "tui.showToast")
    .at((ctx) => ({
      path: "/tui/show-toast",
      headers: ctx.headers(),
      body: { title: "Exercise", message: "covered", variant: "info", duration: 1000 },
    }))
    .json(200, boolean, "status"),
  http.protected
    .post("/tui/publish", "tui.publish")
    .at((ctx) => ({
      path: "/tui/publish",
      headers: ctx.headers(),
      body: { type: "tui.prompt.append", properties: { text: "published" } },
    }))
    .json(200, boolean, "status"),
  http.protected
    .post("/tui/select-session", "tui.selectSession")
    .seeded((ctx) => ctx.session({ title: "TUI select" }))
    .at((ctx) => ({ path: "/tui/select-session", headers: ctx.headers(), body: { sessionID: ctx.state.id } }))
    .json(200, boolean, "status"),
  http.protected
    .post("/tui/control/response", "tui.control.response")
    .at((ctx) => ({ path: "/tui/control/response", headers: ctx.headers(), body: { ok: true } }))
    .json(200, boolean, "status"),
  http.protected
    .get("/tui/control/next", "tui.control.next")
    .mutating()
    .seeded((ctx) => ctx.tuiRequest({ path: "/tui/exercise", body: { text: "queued" } }))
    .json(
      200,
      (body) => {
        object(body)
        check(body.path === "/tui/exercise", "control next should return queued path")
        object(body.body)
        check(body.body.text === "queued", "control next should return queued body")
      },
      "status",
    ),
  http.protected
    .post("/global/upgrade", "global.upgrade")
    .global()
    .probe({ path: "/global/upgrade", body: { target: 1 } })
    .at(() => ({ path: "/global/upgrade", body: { target: 1 } }))
    .status(400),
]

const llmScenarios = new Set([
  "session.init",
  "session.prompt",
  "session.prompt_async",
  "session.command",
  "session.summarize",
])

const main = Effect.gen(function* () {
  yield* Effect.addFinalizer(() => Effect.promise(() => disposeApps()).pipe(Effect.andThen(cleanupExercisePaths)))
  const options = parseOptions(Bun.argv.slice(2))
  const modules = yield* Effect.promise(() => runtime())
  const effectRoutes = routeKeys(OpenApi.fromApi(modules.PublicApi))
  const selected = selectedScenarios(options, scenarios)
  const missing = effectRoutes.filter((route) => !scenarios.some((scenario) => route === routeKey(scenario)))
  const extra = scenarios.filter((scenario) => !effectRoutes.includes(routeKey(scenario)))

  for (const scenario of scenarios) {
    if (scenario.kind === "active" && llmScenarios.has(scenario.name) && !scenario.project?.llm) {
      return yield* Effect.fail(new Error(`${scenario.name} must use TestLLMServer via .withLlm()`))
    }
  }

  printHeader(options, effectRoutes, selected, missing, extra, {
    database: exerciseDatabasePath,
    global: exerciseGlobalRoot,
  })

  const results =
    options.mode === "coverage"
      ? selected.map(coverageResult)
      : yield* Effect.forEach(
          selected,
          (scenario) =>
            Effect.gen(function* () {
              if (options.progress) console.log(`${color.dim}RUN ${routeKey(scenario)} ${scenario.name}${color.reset}`)
              return yield* runScenario(options)(scenario)
            }),
          { concurrency: 1 },
        )
  printResults(results, missing, extra)

  if (results.some((result) => result.status === "fail"))
    return yield* Effect.fail(new Error("one or more scenarios failed"))
  if (options.failOnSkip && results.some((result) => result.status === "skip"))
    return yield* Effect.fail(new Error("one or more scenarios are skipped"))
  if (options.failOnMissing && missing.length > 0)
    return yield* Effect.fail(new Error("one or more routes have no scenario"))
  return undefined
})

Effect.runPromise(main.pipe(Effect.provide(TestLLMServer.layer), Effect.scoped)).then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(`${color.red}${message(error)}${color.reset}`)
    process.exit(1)
  },
)
