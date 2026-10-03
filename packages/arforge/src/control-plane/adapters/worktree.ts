import { Effect, Schema } from "effect"
import { InstanceRef, WorkspaceRef } from "@/effect/instance-ref"
import { type WorkspaceAdapter, type WorkspaceAdapterContext, WorkspaceInfo } from "../types"

const WorktreeConfig = Schema.Struct({
  name: WorkspaceInfo.fields.name,
  branch: Schema.optional(Schema.NullOr(Schema.String)),
  directory: Schema.String,
})
const decodeWorktreeConfig = Schema.decodeUnknownSync(WorktreeConfig)

async function loadWorktree() {
  const [{ AppRuntime }, { Worktree }] = await Promise.all([import("@/effect/app-runtime"), import("@/worktree")])
  return { AppRuntime, Worktree }
}

function requireInstance(context: WorkspaceAdapterContext | undefined) {
  if (!context?.instance) throw new Error("Worktree adapter requires an instance context")
  return context.instance
}

const provideContext = <A, E, R>(effect: Effect.Effect<A, E, R>, context: WorkspaceAdapterContext | undefined) =>
  effect.pipe(
    Effect.provideService(InstanceRef, requireInstance(context)),
    Effect.provideService(WorkspaceRef, context?.workspaceID),
  )

export const WorktreeAdapter: WorkspaceAdapter = {
  name: "Worktree",
  description: "Worktree creation is disabled until this legacy adapter uses the control-plane Action Gateway",
  async configure(_info, _context) {
    throw new Error("Legacy Worktree adapter configuration is blocked by the Trust Kernel")
  },
  async create(_info, _env, _from, _context) {
    throw new Error("Legacy Worktree adapter creation is blocked by the Trust Kernel")
  },
  async list(context) {
    const { AppRuntime, Worktree } = await loadWorktree()
    const ctx = requireInstance(context)
    return (
      await AppRuntime.runPromise(
        provideContext(
          Worktree.Service.use((svc) => svc.list()),
          context,
        ),
      )
    ).map((info) => ({
      type: "worktree",
      name: info.name,
      branch: info.branch,
      directory: info.directory,
      projectID: ctx.project.id,
    }))
  },
  async remove(_info, _context) {
    throw new Error("Legacy Worktree adapter removal is blocked by the Trust Kernel")
  },
  target(info) {
    const config = decodeWorktreeConfig(info)
    return {
      type: "local",
      directory: config.directory,
    }
  },
}
