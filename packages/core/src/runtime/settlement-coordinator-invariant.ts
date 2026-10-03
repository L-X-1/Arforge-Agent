import { Effect } from "effect"
import * as ChildSettlement from "./child-settlement"
import * as SettlementCoordinator from "./settlement-coordinator"
import * as SettlementObservation from "./settlement-observation"
import type { InvariantMode, InvariantReport, RuntimeInvariantRegistry } from "./invariants"

/** Package-owned invariant for the transaction coordinator's payload-free receipt. */
export const OWNER = "settlement-coordinator" as const
export const KEY = "execution-receipt" as const
export const LEGACY_KEY = "legacy-execution-receipt" as const
export const OBSERVATION_KEY = "observation-window" as const
export const OBSERVATION_CHECKPOINT_KEY = "observation-checkpoint" as const
export const OBSERVATION_REVIEW_KEY = "observation-review" as const
export const VERSION = "1" as const

export type SettlementCoordinatorInvariantContext =
  | Readonly<{
      readonly kind: "execution"
      readonly execution: unknown
      readonly plan: ChildSettlement.SettlementCommitPlan
      readonly sharedTransactionEvidence: ChildSettlement.SettlementSharedTransactionEvidence
    }>
  | Readonly<{
      readonly kind: "legacy-execution"
      readonly execution: unknown
      readonly plan: ChildSettlement.SettlementCommitPlan
      readonly transactionID: string
    }>
  | Readonly<{
      readonly kind: "observation-window"
      readonly observation: unknown
    }>
  | Readonly<{
      readonly kind: "observation-checkpoint"
      readonly checkpoint: unknown
    }>
  | Readonly<{
      readonly kind: "observation-review"
      readonly review: unknown
    }>

export const registerInvariants = (registry: RuntimeInvariantRegistry): void => {
  if (!registry.get(OWNER, KEY, VERSION))
    registry.register({
      owner: OWNER,
      key: KEY,
      version: VERSION,
      cost: "cheap",
      check: (context) =>
        Effect.sync(() => {
          if (
            context === null ||
            typeof context !== "object" ||
            Array.isArray(context) ||
            ((context as Partial<SettlementCoordinatorInvariantContext>).kind !== "execution" &&
              (context as Partial<SettlementCoordinatorInvariantContext>).kind !== "legacy-execution" &&
              (context as Partial<SettlementCoordinatorInvariantContext>).kind !== "observation-window" &&
              (context as Partial<SettlementCoordinatorInvariantContext>).kind !== "observation-checkpoint" &&
              (context as Partial<SettlementCoordinatorInvariantContext>).kind !== "observation-review")
          )
            throw new Error("settlement coordinator invariant context is invalid")
          const value = context as SettlementCoordinatorInvariantContext
          if (value.kind === "execution")
            SettlementCoordinator.assertSettlementTransactionExecution(value.execution, {
              plan: value.plan,
              sharedTransactionEvidence: value.sharedTransactionEvidence,
            })
          else if (value.kind === "legacy-execution")
            SettlementCoordinator.assertLegacySettlementTransactionExecution(value.execution, {
              plan: value.plan,
              transactionID: value.transactionID,
            })
          else if (value.kind === "observation-window")
            SettlementObservation.assertSettlementObservationWindow(value.observation)
          else if (value.kind === "observation-checkpoint")
            SettlementObservation.assertSettlementObservationCheckpoint(value.checkpoint)
          else SettlementObservation.assertSettlementObservationReview(value.review)
        }),
    })
  if (!registry.get(OWNER, LEGACY_KEY, VERSION))
    registry.register({
      owner: OWNER,
      key: LEGACY_KEY,
      version: VERSION,
      cost: "cheap",
      check: (context) =>
        Effect.sync(() => {
          if (
            context === null ||
            typeof context !== "object" ||
            Array.isArray(context) ||
            (context as Partial<SettlementCoordinatorInvariantContext>).kind !== "legacy-execution"
          )
            throw new Error("legacy settlement coordinator invariant context is invalid")
          const value = context as Extract<SettlementCoordinatorInvariantContext, { readonly kind: "legacy-execution" }>
          SettlementCoordinator.assertLegacySettlementTransactionExecution(value.execution, {
            plan: value.plan,
            transactionID: value.transactionID,
          })
        }),
    })
  if (!registry.get(OWNER, OBSERVATION_KEY, VERSION))
    registry.register({
      owner: OWNER,
      key: OBSERVATION_KEY,
      version: VERSION,
      cost: "cheap",
      check: (context) =>
        Effect.sync(() => {
          if (
            context === null ||
            typeof context !== "object" ||
            Array.isArray(context) ||
            (context as Partial<SettlementCoordinatorInvariantContext>).kind !== "observation-window"
          )
            throw new Error("settlement observation invariant context is invalid")
          const value = context as Extract<
            SettlementCoordinatorInvariantContext,
            { readonly kind: "observation-window" }
          >
          SettlementObservation.assertSettlementObservationWindow(value.observation)
        }),
    })
  if (!registry.get(OWNER, OBSERVATION_CHECKPOINT_KEY, VERSION))
    registry.register({
      owner: OWNER,
      key: OBSERVATION_CHECKPOINT_KEY,
      version: VERSION,
      cost: "cheap",
      check: (context) =>
        Effect.sync(() => {
          if (
            context === null ||
            typeof context !== "object" ||
            Array.isArray(context) ||
            (context as Partial<SettlementCoordinatorInvariantContext>).kind !== "observation-checkpoint"
          )
            throw new Error("settlement observation checkpoint invariant context is invalid")
          const value = context as Extract<
            SettlementCoordinatorInvariantContext,
            { readonly kind: "observation-checkpoint" }
          >
          SettlementObservation.assertSettlementObservationCheckpoint(value.checkpoint)
        }),
    })
  if (!registry.get(OWNER, OBSERVATION_REVIEW_KEY, VERSION))
    registry.register({
      owner: OWNER,
      key: OBSERVATION_REVIEW_KEY,
      version: VERSION,
      cost: "cheap",
      check: (context) =>
        Effect.sync(() => {
          if (
            context === null ||
            typeof context !== "object" ||
            Array.isArray(context) ||
            (context as Partial<SettlementCoordinatorInvariantContext>).kind !== "observation-review"
          )
            throw new Error("settlement observation review invariant context is invalid")
          const value = context as Extract<
            SettlementCoordinatorInvariantContext,
            { readonly kind: "observation-review" }
          >
          SettlementObservation.assertSettlementObservationReview(value.review)
        }),
    })
}

export const inspect = (
  registry: RuntimeInvariantRegistry,
  context: SettlementCoordinatorInvariantContext,
  mode: InvariantMode = process.env.NODE_ENV === "production" ? "production" : "development",
): Effect.Effect<InvariantReport> => {
  registerInvariants(registry)
  return registry.run(context, {
    owner: OWNER,
    key:
      context.kind === "legacy-execution"
        ? LEGACY_KEY
        : context.kind === "observation-window"
          ? OBSERVATION_KEY
          : context.kind === "observation-checkpoint"
            ? OBSERVATION_CHECKPOINT_KEY
            : context.kind === "observation-review"
              ? OBSERVATION_REVIEW_KEY
              : KEY,
    mode,
  })
}
