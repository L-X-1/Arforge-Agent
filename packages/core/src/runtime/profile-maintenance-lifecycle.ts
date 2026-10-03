import { Context, Effect, Layer, Schema } from "effect"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { LOCAL_TENANT_ID, LOCAL_USER_ID } from "../identity/sql"
import { canonicalHash } from "../util/canonical-hash"
import * as ArtifactMaintenanceScan from "./artifact-maintenance-scan"

/**
 * A stable, opaque profile identity derived from the request principal.
 *
 * The maintenance tables deliberately keep the tenant and owner columns as
 * their authorization boundary.  This ID is a safe lifecycle-facing alias:
 * callers can carry it between open/resume/idle/close hooks without copying
 * user or tenant identifiers into a UI or a worker payload.
 */
export const ProfileID = Schema.String.check(Schema.isPattern(/^prf_[a-f0-9]{64}$/)).pipe(
  Schema.brand("ProfileMaintenance.ProfileID"),
)
export type ProfileID = typeof ProfileID.Type

const PROFILE_ID_PATTERN = /^prf_[a-f0-9]{64}$/

export const isProfileID = (value: string): value is ProfileID => PROFILE_ID_PATTERN.test(value)

export type ProfileBinding = Readonly<{
  readonly profileID: ProfileID
  readonly tenantID: string
  readonly ownerUserID: string
}>

export const profileIDFor = (input: { readonly tenantID: string; readonly userID: string }): ProfileID => {
  const digest = canonicalHash({
    domain: "arforge.profile-maintenance-binding/v1",
    tenantID: input.tenantID,
    userID: input.userID,
  })
  if (digest === undefined) throw new Error("Profile binding is not canonically hashable")
  return ProfileID.make(`prf_${digest}`)
}

export type LifecyclePhase = "open" | "resume" | "idle" | "close"

export type Observation = Readonly<{
  readonly profileID: ProfileID
  readonly phase: LifecyclePhase
  readonly tick: ArtifactMaintenanceScan.MaintenanceTick
}>

export class InvalidProfileIDError extends Schema.TaggedErrorClass<InvalidProfileIDError>()(
  "ProfileMaintenance.InvalidProfileIDError",
  { profileID: Schema.String },
) {}

export class BindingMismatchError extends Schema.TaggedErrorClass<BindingMismatchError>()(
  "ProfileMaintenance.BindingMismatchError",
  {
    profileID: Schema.String,
    expectedProfileID: Schema.String,
  },
) {}

export type Error = InvalidProfileIDError | BindingMismatchError | ArtifactMaintenanceScan.DomainError

export type HookInput = Readonly<{
  /** Optional opaque ID returned by a prior lifecycle hook. */
  readonly profileID?: string
  readonly nowMs?: number
}>

export interface Interface {
  /** Resolve the tenant/user-owned profile binding without exposing it to a model. */
  readonly binding: Effect.Effect<ProfileBinding>
  /** Run one explicit maintenance tick for profile open. */
  readonly open: (input?: HookInput) => Effect.Effect<Observation, Error>
  /** Run one explicit maintenance tick before a profile/session resumes work. */
  readonly resume: (input?: HookInput) => Effect.Effect<Observation, Error>
  /** Run one explicit maintenance tick after work becomes idle. */
  readonly idle: (input?: HookInput) => Effect.Effect<Observation, Error>
  /** Run one final explicit maintenance tick before profile disposal. */
  readonly close: (input?: HookInput) => Effect.Effect<Observation, Error>
}

export class Service extends Context.Service<Service, Interface>()("@arforge/v2/ProfileMaintenanceLifecycle") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const scans = yield* ArtifactMaintenanceScan.Service

    const resolveBinding = Effect.fn("ProfileMaintenanceLifecycle.binding")(function* () {
      const principal = yield* Database.CurrentPrincipal
      const tenantID = principal?.tenantID ?? LOCAL_TENANT_ID
      const userID = principal?.userID ?? LOCAL_USER_ID
      return { profileID: profileIDFor({ tenantID, userID }), tenantID, ownerUserID: userID }
    })
    const binding: Interface["binding"] = resolveBinding()

    const observe = Effect.fn("ProfileMaintenanceLifecycle.observe")(function* (
      phase: LifecyclePhase,
      input?: HookInput,
    ) {
      const current = yield* resolveBinding()
      if (input?.profileID !== undefined) {
        if (!isProfileID(input.profileID)) return yield* new InvalidProfileIDError({ profileID: input.profileID })
        if (input.profileID !== current.profileID)
          return yield* new BindingMismatchError({
            profileID: input.profileID,
            expectedProfileID: current.profileID,
          })
      }
      const tick = yield* scans.tick(input?.nowMs === undefined ? undefined : { nowMs: input.nowMs })
      return { profileID: current.profileID, phase, tick }
    })

    return Service.of({
      binding,
      open: (input) => observe("open", input),
      resume: (input) => observe("resume", input),
      idle: (input) => observe("idle", input),
      close: (input) => observe("close", input),
    })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [Database.node, ArtifactMaintenanceScan.node],
})
