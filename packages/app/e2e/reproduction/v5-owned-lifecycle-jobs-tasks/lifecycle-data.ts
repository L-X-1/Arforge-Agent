import type { OperationsApi } from "../../../src/utils/server"
type Job = Awaited<ReturnType<OperationsApi["personalJobs"]["list"]>>[number]
type Task = Awaited<ReturnType<OperationsApi["tasks"]["list"]>>["items"][number]
const now = () => Date.now()
export function seedTasks(sessionID: string): Task[] {
  return ["Root task", "Blocked task", "Finished task"].map((title, index) => ({
    id: "tsk_" + index, sessionID, title, description: "Durable fixture acceptance criteria", activeForm: "", metadata: {},
    status: index === 2 ? "completed" : "pending", blockedBy: index === 1 ? ["tsk_0"] : [], blocks: index === 0 ? ["tsk_1"] : [],
    unresolvedBlockers: index === 1 ? 1 : 0, revision: 1, time: { created: now(), updated: now() },
  }))
}
export function seedJobs(sessionID: string): Job[] {
  return (["awaiting_approval", "queued", "running", "paused", "failed", "completed"] as const).map((status, index) => ({
    id: "pjob_" + index, sessionID, title: "Fixture " + status, prompt: "Bounded isolated instructions for " + status, status,
    visibility: { mode: "background", label: "后台自动", userVisible: true },
    schedule: { kind: "once", label: "One-time fixture", nextRunAt: now() + 3600000, timezone: "UTC" }, credentialIDs: [],
    budget: { attemptsUsed: 0, maxAttempts: 3, durationMsUsed: 0, maxDurationMs: 600000, costMicrosUsed: 0, maxCostMicros: 500000 },
    approvalPolicy: { mode: "user_once", rationale: "Fixture explicit approval" }, approvalState: status === "awaiting_approval" ? "pending" : "approved",
    notificationPolicy: { mode: "in_app", events: ["started", "completed", "failed"] },
    notifications: status === "completed" ? [{ id: "pjn_0", jobID: "pjob_" + index, kind: "completed", title: "Fixture notification", body: "A recorded result is available.", availableAt: 1 }] : [],
    retention: {}, admissionDigest: "a".repeat(64), lastError: status === "failed" ? "Fixture execution failed; no delivery claimed" : "",
    revision: 1, time: { created: now(), updated: now() },
  }))
}
type Session = { tasks: Task[]; jobs: Job[] }
export function lifecycleRoute(input: { tail: string; method: string; body: Record<string, any> | undefined; session: Session; sessionID: string }) {
  const { tail, method, body = {}, session, sessionID } = input
  const json = (data: unknown) => Response.json({ data })
  const conflict = () => Response.json({ _tag: "ConflictError", message: "Fixture current revision or dependency conflict" }, { status: 409 })
  const [root, id, op, notificationID] = tail.split("/")
  if (root === "goal" && method === "GET") return { action: "goals:list", produce: () => json({ queued: [], history: [], items: [] }) }
  if (root === "task") return { action: "task:" + (id === "clear" ? "clear" : op ?? (method === "GET" ? id ? "get" : "list" : method === "POST" ? "create" : method === "PATCH" ? "update" : "delete")), produce: () => {
    const refresh = () => { session.tasks = session.tasks.map(task => ({ ...task, unresolvedBlockers: task.blockedBy.filter(id => session.tasks.find(t => t.id === id)?.status !== "completed").length })) }
    if (!id && method === "GET") { refresh(); return json({ items: session.tasks, total: session.tasks.length }) }
    if (!id && method === "POST") { const created = { ...seedTasks(sessionID)[0]!, id: "tsk_created", title: body.title, description: body.description ?? "", blockedBy: body.blockedBy ?? [] }; session.tasks.push(created); refresh(); return json(created) }
    if (id === "clear") { const before = session.tasks.length; session.tasks = session.tasks.filter(t => !["completed", "cancelled"].includes(t.status)); refresh(); return json({ deleted: before - session.tasks.length }) }
    const task = session.tasks.find(t => t.id === id)
    if (!task) return new Response(null, { status: 404 })
    if (method === "GET") return json(task)
    if (body.expectedRevision !== task.revision || ((op === "claim" || op === "complete") && task.unresolvedBlockers > 0)) return conflict()
    if (method === "DELETE") { session.tasks = session.tasks.filter(t => t.id !== id).map(t => ({ ...t, blockedBy: t.blockedBy.filter(b => b !== id) })); refresh(); return new Response(null, { status: 204 }) }
    const next: Task = { ...task, revision: task.revision + 1,
      ...(op === "claim" ? { owner: body.owner, status: "in_progress" } : op === "release" ? { owner: undefined, status: "pending" }
        : op === "complete" ? { status: "completed" } : op === "cancel" ? { status: "cancelled" }
          : { title: body.title ?? task.title, description: body.description ?? task.description, blockedBy: body.blockedBy ?? task.blockedBy }),
    }
    session.tasks = session.tasks.map(t => t.id === id ? next : t); refresh(); return json(next)
  } }
  if (root !== "personal-job" || id === "dispatch") return undefined
  return { action: "job:" + (op === "notifications" ? "notificationRead" : op ?? (method === "GET" ? id ? "get" : "list" : method === "POST" ? "create" : "delete")), produce: () => {
    if (!id && method === "GET") return json(session.jobs)
    if (!id && method === "POST") { const created: Job = { ...seedJobs(sessionID)[0]!, ...body, id: "pjob_created", sessionID,
      budget: { ...body.budget, attemptsUsed: 0, durationMsUsed: 0, costMicrosUsed: 0 }, notifications: [], revision: 1,
      status: body.approvalPolicy?.mode === "automatic" ? "queued" : "awaiting_approval", approvalState: body.approvalPolicy?.mode === "automatic" ? "not_required" : "pending" }; session.jobs.push(created); return json(created) }
    const job = session.jobs.find(j => j.id === id)
    if (!job) return new Response(null, { status: 404 })
    if (method === "GET") return json(job)
    if (body.expectedRevision !== job.revision) return conflict()
    if (method === "DELETE") { session.jobs = session.jobs.filter(j => j.id !== id); return new Response(null, { status: 204 }) }
    const next: Job = { ...job, revision: job.revision + 1,
      ...(op === "approve" ? { status: "queued", approvalState: "approved" } : op === "execute" ? { status: "running" }
        : op === "pause" ? { status: "paused" } : op === "resume" ? { status: "queued" } : op === "cancel" ? { status: "cancelled" } : {}),
      ...(op === "notifications" ? { notifications: job.notifications.map(n => n.id === notificationID ? { ...n, readAt: now() } : n) } : {}),
    }
    session.jobs = session.jobs.map(j => j.id === id ? next : j); return json(next)
  } }
}
