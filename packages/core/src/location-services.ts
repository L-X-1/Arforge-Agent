import { Context, Effect, Exit, Layer, LayerMap, Option, Scope } from "effect"
import { AgentV2 } from "./agent"
import { AISDK } from "./aisdk"
import { Catalog } from "./catalog"
import { CommandV2 } from "./command"
import { Config } from "./config"
import { LayerNode } from "./effect/layer-node"
import { Node } from "./effect/app-node"
import { FileMutation } from "./file-mutation"
import { TextDocument } from "./text-document"
import { PreviewResources } from "./preview-resources"
import { FileSystem } from "./filesystem"
import { FileSystemSearch } from "./filesystem/search"
import { GoalV2 } from "./goal"
import { GoalGuidance } from "./goal/guidance"
import { Watcher } from "./filesystem/watcher"
import { Image } from "./image"
import { Integration } from "./integration"
import { Location } from "./location"
import { LocationMutation } from "./location-mutation"
import { LocationServiceMap } from "./location-service-map"
import { AbsolutePath } from "./schema"
import { PermissionV2 } from "./permission"
import { PluginV2 } from "./plugin"
import { PluginInternal } from "./plugin/internal"
import { Policy } from "./policy"
import { ProjectCopy } from "./project/copy"
import { Pty } from "./pty"
import { QuestionV2 } from "./question"
import { Reference } from "./reference"
import { ReferenceGuidance } from "./reference/guidance"
import * as SessionRunnerLLM from "./session/runner/llm"
import { SessionRunnerModel } from "./session/runner/model"
import { SessionTodo } from "./session/todo"
import { SkillV2 } from "./skill"
import { SkillGuidance } from "./skill/guidance"
import { Snapshot } from "./snapshot"
import { SystemContextBuiltIns } from "./system-context/builtins"
import { SystemContextRegistry } from "./system-context/registry"
import { TaskV2 } from "./task"
import { TaskGraphV2 } from "./task-graph"
import { BuiltInTools } from "./tool/builtins"
import { ReadToolFileSystem } from "./tool/read-filesystem"
import { ToolRegistry } from "./tool/registry"
import { DeferredTools } from "./tool/deferred"
import { ToolOutputStore } from "./tool-output-store"
import { TeamV2 } from "./team"
import { NotebookV2 } from "./notebook"
import { CooperativeWaitV2 } from "./cooperative-wait"
import { PrimaryDeliveryV2 } from "./primary-delivery"
import { MemoryV2 } from "./memory"
import * as MemoryKernel from "./memory-kernel"
import { LearningV2 } from "./learning"
import { ExperienceStoreV1 } from "./experience-store"
import { FeedbackV2 } from "./feedback"
import { MultimodalDiagnosisV2 } from "./multimodal-diagnosis"
import { EvolutionV2 } from "./evolution"
import { GovernedEvolutionV1 } from "./evolution/governed"
import * as EvolutionCandidateV1 from "./evolution/candidate"
import * as EvolutionExposureV1 from "./evolution/exposure"
import { SkillStoreV1 } from "./skill-store"
import { DurableRun } from "./runtime/durable-run"
import { DurableAction } from "./runtime/durable-action"
import { Authorizer } from "./authorizer"
import { ActionGateway } from "./action-gateway"
import { Database } from "./database/database"
import { MailboxV2 } from "./mailbox"
import { PersonalWorkspaceV2 } from "./personal-workspace"
import * as ControlClaimIndex from "./runtime/control-claim-index"
import { PluginControl } from "./plugin-control"
import * as ChildSettlementAudit from "./runtime/child-settlement-audit"
import * as ChildSettlementRecovery from "./runtime/child-settlement-recovery"

export { LocationServiceMap } from "./location-service-map"

export const locationServices = LayerNode.group([
  Location.node,
  Policy.node,
  Config.node,
  AgentV2.node,
  CommandV2.node,
  Reference.node,
  Integration.node,
  Catalog.node,
  AISDK.node,
  PluginV2.node,
  PluginInternal.node,
  ProjectCopy.node,
  ProjectCopy.refreshNode,
  FileSystemSearch.node,
  FileSystem.node,
  Watcher.node,
  Pty.node,
  SkillV2.node,
  SystemContextRegistry.node,
  SystemContextBuiltIns.node,
  LocationMutation.node,
  FileMutation.node,
  TextDocument.node,
  PreviewResources.node,
  PermissionV2.node,
  Authorizer.node,
  ActionGateway.node,
  ToolOutputStore.node,
  ToolRegistry.node,
  DeferredTools.node,
  DeferredTools.configNode,
  ToolRegistry.toolsNode,
  Image.node,
  SkillGuidance.node,
  ReferenceGuidance.node,
  SessionTodo.node,
  QuestionV2.node,
  GoalV2.node,
  GoalGuidance.node,
  TaskGraphV2.node,
  TaskV2.node,
  TeamV2.node,
  MailboxV2.node,
  NotebookV2.node,
  CooperativeWaitV2.node,
  PrimaryDeliveryV2.node,
  MemoryV2.node,
  MemoryKernel.node,
  LearningV2.node,
  ExperienceStoreV1.node,
  ChildSettlementAudit.node,
  ChildSettlementRecovery.node,
  FeedbackV2.node,
  MultimodalDiagnosisV2.node,
  EvolutionV2.node,
  GovernedEvolutionV1.node,
  EvolutionCandidateV1.node,
  EvolutionExposureV1.node,
  SkillStoreV1.node,
  DurableRun.node,
  DurableAction.node,
  ControlClaimIndex.node,
  PluginControl.node,
  PersonalWorkspaceV2.node,
  ReadToolFileSystem.node,
  BuiltInTools.node,
  SessionRunnerModel.node,
  Snapshot.node,
  SessionRunnerLLM.node,
])

export type LocationServices = LayerNode.Output<typeof locationServices>
export type LocationError = LayerNode.Error<typeof locationServices>

// HTTP clients use forward slashes while Windows session workers use native
// separators. Normalize before cache lookup, not inside its layer factory:
// otherwise the same directory owns two permission queues and service scopes.
// Keep workspace IDs and case intact, and preserve literal POSIX backslashes.
const normalizeRef = (ref: Location.Ref) =>
  Location.Ref.make({
    directory: AbsolutePath.make(process.platform === "win32" ? ref.directory.replaceAll("/", "\\") : ref.directory),
    workspaceID: ref.workspaceID,
  })

const makeLocationServiceMap = (replacements: LayerNode.Replacements, database?: Database.Interface) =>
  Effect.gen(function* () {
    // LayerMap/RcMap closes cached location scopes from the scope-closing
    // fiber. That fiber can be a route/request scope whose context only
    // exposes location-facing services and has already pruned Database.
    // Keep the construction context and move the cache into a dedicated
    // scope. The map must be closed with the construction context before the
    // caller's potentially-pruned request scope starts its own finalizers.
    const constructionContext = Context.addOrOmit(
      yield* Effect.context(),
      Database.Service,
      Option.fromUndefinedOr(database),
    )
    const mapScope = yield* Scope.make("sequential")
    const map = yield* LayerMap.make(
      (ref: Location.Ref) => {
        const hasDatabaseReplacement = replacements.some(([source]) => source.name === Database.node.name)
        const durableReplacements: LayerNode.Replacements =
          database && !hasDatabaseReplacement ? [[Database.node, Layer.succeed(Database.Service, database)]] : []
        const allReplacements = replacements.concat([[Location.node, Location.boundNode(ref)]], durableReplacements)
        // Apply replacements during hoist, not afterward: replacements can
        // introduce new tagged dependencies (Location.boundNode depends on
        // Project), and the hoist walk is the only pass that can still slice
        // those back out.
        const location = LayerNode.hoist(locationServices, Node.tags.values.global, allReplacements)

        const compiled = LayerNode.compile(location.node).pipe(
          Layer.fresh,
          Layer.tap(() =>
            Effect.logInfo("booting location services", {
              directory: ref.directory,
              workspaceID: ref.workspaceID,
            }),
          ),
          Layer.provide(LayerNode.compile(location.hoisted)),
        )

        // Database is optional from the point of view of individual
        // location-state constructors, so LayerNode.hoist may legitimately
        // omit it when no node declares the dependency. The map nevertheless
        // owns one durable database handle; provide it explicitly while
        // building every location so InstanceState captures it for later
        // invalidation/finalization as well.
        return database ? compiled.pipe(Layer.provideMerge(Layer.succeed(Database.Service, database))) : compiled
      },
      { idleTimeToLive: "60 minutes" },
    ).pipe(Effect.provideService(Scope.Scope, mapScope))

    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        yield* Scope.close(mapScope, Exit.void).pipe(Effect.provide(constructionContext), Effect.ignore)
      }),
    )

    // `LayerMap` intentionally returns only the services declared by the
    // location layer. Database is a durable dependency rather than a
    // location-facing service, but callers provide the returned context as a
    // complete replacement context. Preserve the same database handle at this
    // boundary so async state/finalizers cannot inherit a pruned route context.
    const augmentedContexts = new WeakMap<object, Context.Context<LocationServices>>()
    const contextEffect = (ref: Location.Ref) =>
      map.contextEffect(normalizeRef(ref)).pipe(
        Effect.map((context) => {
          if (!database) return context
          const cached = augmentedContexts.get(context)
          if (cached) return cached
          const augmented = Context.merge(
            context,
            Context.make(Database.Service, database),
          ) as unknown as Context.Context<LocationServices>
          augmentedContexts.set(context, augmented)
          return augmented
        }),
      )

    return {
      ...map,
      contextEffect,
      get: (ref: Location.Ref) => Layer.effectContext(contextEffect(ref)),
      invalidate: (ref: Location.Ref) => map.invalidate(normalizeRef(ref)),
    } as LayerMap.LayerMap<Location.Ref, LocationServices, LocationError>
  })

export function buildLocationServiceMap(
  replacements: LayerNode.Replacements = [],
): Layer.Layer<LocationServiceMap.Service> {
  return Layer.effect(
    LocationServiceMap.Service,
    Effect.gen(function* () {
      // This compatibility builder may be used without a declared Database
      // dependency by older CLI/test graphs. When a database is present,
      // reuse it; otherwise retain the historical standalone behavior.
      const database = Option.getOrUndefined(yield* Effect.serviceOption(Database.Service))
      return yield* makeLocationServiceMap(replacements, database)
    }),
  )
}

/** Build a map that explicitly reuses the process-level durable database. */
export function buildSharedLocationServiceMap(
  replacements: LayerNode.Replacements = [],
): Layer.Layer<LocationServiceMap.Service, never, Database.Service> {
  return Layer.effect(
    LocationServiceMap.Service,
    Effect.gen(function* () {
      const database = yield* Database.Service
      return yield* makeLocationServiceMap(replacements, database)
    }),
  )
}

// This is temporary for backwards compatibility
export const locationServiceMapLayer = buildLocationServiceMap()
