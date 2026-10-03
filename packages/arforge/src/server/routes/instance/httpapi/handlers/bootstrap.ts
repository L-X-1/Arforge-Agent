import { WorkspaceRef } from "@/effect/instance-ref"
import * as InstanceState from "@/effect/instance-state"
import { Project } from "@/project/project"
import { Vcs } from "@/project/vcs"
import { Global } from "@arforge-ai/core/global"
import { Location } from "@arforge-ai/schema/location"
import { AbsolutePath } from "@arforge-ai/schema/schema"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { BootstrapPathInfo, BootstrapProjectCurrent, BootstrapVcsDiffQuery, BootstrapVcsInfo } from "../groups/bootstrap"

export const bootstrapHandlers = HttpApiBuilder.group(InstanceHttpApi, "bootstrap", (handlers) =>
  Effect.gen(function* () {
    const project = yield* Project.Service
    const vcs = yield* Vcs.Service

    return handlers
      .handle("path", Effect.fn("BootstrapHttpApi.path")(function* () {
        const ctx = yield* InstanceState.context
        return new BootstrapPathInfo({
          home: Global.Path.home,
          state: Global.Path.state,
          config: Global.Path.config,
          worktree: ctx.worktree,
          directory: ctx.directory,
        })
      }))
      .handle("project.list", Effect.fn("BootstrapHttpApi.projects")(function* () {
        return yield* project.list()
      }))
      .handle("project.current", Effect.fn("BootstrapHttpApi.currentProject")(function* () {
        const ctx = yield* InstanceState.context
        return new BootstrapProjectCurrent({ id: ctx.project.id, directory: AbsolutePath.make(ctx.worktree) })
      }))
      .handle("vcs", Effect.fn("BootstrapHttpApi.vcs")(function* () {
        const ctx = yield* InstanceState.context
        const workspaceID = yield* WorkspaceRef
        const [branch, defaultBranch] = yield* Effect.all([vcs.branch(), vcs.defaultBranch()], {
          concurrency: "unbounded",
        })
        return {
          location: new Location.Info({
            directory: AbsolutePath.make(ctx.directory),
            workspaceID,
            project: { id: ctx.project.id, directory: AbsolutePath.make(ctx.worktree) },
          }),
          data: new BootstrapVcsInfo({ branch, defaultBranch }),
        }
      }))
      .handle("vcs.diff", Effect.fn("BootstrapHttpApi.vcsDiff")(function* (input: {
        query: typeof BootstrapVcsDiffQuery.Type
      }) {
        const ctx = yield* InstanceState.context
        const workspaceID = yield* WorkspaceRef
        // Adapt the current wire mode without duplicating the existing VCS owner.
        const data = yield* vcs.diff(input.query.mode === "working" ? "git" : "branch", {
          context: input.query.context,
        })
        return {
          location: new Location.Info({
            directory: AbsolutePath.make(ctx.directory),
            workspaceID,
            project: { id: ctx.project.id, directory: AbsolutePath.make(ctx.worktree) },
          }),
          data,
        }
      }))
  }),
)
