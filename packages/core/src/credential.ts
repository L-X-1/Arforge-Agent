export * as Credential from "./credential"

import { and, asc, eq } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { Credential } from "@arforge-ai/schema/credential"
import { Integration } from "@arforge-ai/schema/integration"
import { Database } from "./database/database"
import { makeGlobalNode } from "./effect/app-node"
import { CredentialTable } from "./credential/sql"
import { IdentityTenantMemberTable } from "./identity/sql"
import * as TenantPlatform from "./tenant-platform"

export const ID = Credential.ID
export type ID = Credential.ID

export const OAuth = Credential.OAuth
export type OAuth = Credential.OAuth

export const Key = Credential.Key
export type Key = Credential.Key

export const Value = Credential.Value
export type Value = Credential.Value

export class Info extends Schema.Class<Info>("Credential.Info")({
  id: ID,
  integrationID: Integration.ID,
  label: Schema.String,
  /** Opaque revision of the authenticated encrypted envelope, never a hash of plaintext. */
  version: Schema.String,
  value: Value,
}) {}

export interface Interface {
  /** Returns every stored credential. */
  readonly all: () => Effect.Effect<Info[]>
  /** Returns stored credentials belonging to one integration. */
  readonly list: (integrationID: Integration.ID) => Effect.Effect<Info[]>
  /** Returns one stored credential by ID. */
  readonly get: (id: ID) => Effect.Effect<Info | undefined>
  /** Replaces any credential for an integration and returns the new record. */
  readonly create: (input: {
    readonly integrationID: Integration.ID
    readonly value: Value
    readonly label?: string
  }) => Effect.Effect<Info>
  /** Updates the label or secret value of a stored credential. */
  readonly update: (
    id: ID,
    updates: Partial<Pick<Info, "label" | "value">>,
    options?: { readonly expectedVersion: string },
  ) => Effect.Effect<void>
  /** Removes a stored credential. */
  readonly remove: (id: ID) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@arforge/v2/Credential") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const database = yield* Database.Service
    const db = database.db
    const tenantPlatform = yield* TenantPlatform.Service
    const decode = Schema.decodeUnknownSync(Value)
    const encoder = new TextEncoder()
    const decoder = new TextDecoder()
    const redactedStoredValue = Credential.Key.make({ type: "key", key: "" })
    const purpose = (id: Credential.ID) => `credential:${id}`
    const ownership = (principal: TenantPlatform.Principal) =>
      and(eq(CredentialTable.tenant_id, principal.tenantID), eq(CredentialTable.owner_user_id, principal.userID))
    const hasCompleteEnvelope = (
      row: typeof CredentialTable.$inferSelect,
    ): row is typeof row & {
      readonly encrypted_value: string
      readonly value_key_version: number
      readonly value_fingerprint: string
    } => row.encrypted_value !== null && row.value_key_version !== null && row.value_fingerprint !== null

    const currentPrincipal = Effect.fn("Credential.currentPrincipal")(function* () {
      const current = (yield* Database.CurrentPrincipal) ?? Database.DefaultLocalPrincipal
      if (Database.isDefaultLocalPrincipal(current))
        return { ...current, role: "owner" as const } satisfies TenantPlatform.Principal
      const membership = yield* db
        .select({ role: IdentityTenantMemberTable.role })
        .from(IdentityTenantMemberTable)
        .where(
          and(
            eq(IdentityTenantMemberTable.tenant_id, current.tenantID),
            eq(IdentityTenantMemberTable.user_id, current.userID),
            eq(IdentityTenantMemberTable.status, "active"),
          ),
        )
        .get()
        .pipe(Effect.orDie)
      if (!membership) return yield* Effect.die(new Error("credential access requires an active tenant membership"))
      return {
        tenantID: current.tenantID,
        userID: current.userID,
        role: membership.role,
      } satisfies TenantPlatform.Principal
    })

    const sealBytes = (principal: TenantPlatform.Principal, id: Credential.ID, plaintext: Uint8Array) =>
      tenantPlatform
        .sealScopedValue(principal, {
          ownerUserID: principal.userID,
          purpose: purpose(id),
          plaintext,
        })
        .pipe(Effect.catch((error) => Effect.die(error)))

    const seal = (principal: TenantPlatform.Principal, id: Credential.ID, value: Credential.Value) =>
      sealBytes(principal, id, encoder.encode(JSON.stringify(value)))

    const unseal = (
      principal: TenantPlatform.Principal,
      row: typeof CredentialTable.$inferSelect & {
        readonly encrypted_value: string
        readonly value_key_version: number
        readonly value_fingerprint: string
      },
    ) =>
      tenantPlatform
        .unsealScopedValue(principal, {
          ownerUserID: row.owner_user_id,
          purpose: purpose(row.id),
          keyVersion: row.value_key_version,
          ciphertext: row.encrypted_value,
          fingerprint: row.value_fingerprint,
        })
        .pipe(
          Effect.map((plaintext) => decode(JSON.parse(decoder.decode(plaintext)))),
          Effect.catch((error) => Effect.die(error)),
        )

    const stored = (principal: TenantPlatform.Principal, row: typeof CredentialTable.$inferSelect) =>
      Effect.gen(function* () {
        const envelope = [row.encrypted_value, row.value_key_version, row.value_fingerprint]
        const encrypted = hasCompleteEnvelope(row)
        if (!encrypted && envelope.some((value) => value !== null))
          return yield* Effect.die(new Error(`credential ${row.id} has an incomplete encrypted envelope`))

        // Compatibility migration: old rows are readable once, then the same
        // tenant/user-bound envelope replaces their plaintext JSON at rest.
        // Obsolete pre-integration rows are also encrypted even though they are
        // no longer projected as usable provider connections.
        if (!encrypted) {
          const sealed = yield* sealBytes(principal, row.id, encoder.encode(JSON.stringify(row.value)))
          yield* db
            .update(CredentialTable)
            .set({
              value: redactedStoredValue,
              encrypted_value: sealed.ciphertext,
              value_key_version: sealed.keyVersion,
              value_fingerprint: sealed.fingerprint,
            })
            .where(and(ownership(principal), eq(CredentialTable.id, row.id)))
            .run()
            .pipe(Effect.orDie)
          if (!row.integration_id) return undefined
          return new Info({
            id: row.id,
            integrationID: row.integration_id,
            label: row.label,
            version: sealed.fingerprint,
            value: decode(row.value),
          })
        }

        if (!row.integration_id) return undefined
        const value = yield* unseal(principal, row)
        return new Info({
          id: row.id,
          integrationID: row.integration_id,
          label: row.label,
          version: row.value_fingerprint,
          value,
        })
      })

    const compact = (values: ReadonlyArray<Info | undefined>) =>
      values.filter((value): value is Info => value !== undefined)

    return Service.of({
      all: Effect.fn("Credential.all")(function* () {
        const principal = yield* currentPrincipal()
        const rows = yield* db
          .select()
          .from(CredentialTable)
          .where(ownership(principal))
          .orderBy(asc(CredentialTable.time_created))
          .all()
          .pipe(Effect.orDie)
        return compact(yield* Effect.forEach(rows, (row) => stored(principal, row), { concurrency: 1 }))
      }),
      list: Effect.fn("Credential.list")(function* (integrationID) {
        const principal = yield* currentPrincipal()
        const rows = yield* db
          .select()
          .from(CredentialTable)
          .where(and(ownership(principal), eq(CredentialTable.integration_id, integrationID)))
          .orderBy(asc(CredentialTable.time_created))
          .all()
          .pipe(Effect.orDie)
        return compact(yield* Effect.forEach(rows, (row) => stored(principal, row), { concurrency: 1 }))
      }),
      get: Effect.fn("Credential.get")(function* (id) {
        const principal = yield* currentPrincipal()
        const row = yield* db
          .select()
          .from(CredentialTable)
          .where(and(ownership(principal), eq(CredentialTable.id, id)))
          .get()
          .pipe(Effect.orDie)
        return row ? yield* stored(principal, row) : undefined
      }),
      create: Effect.fn("Credential.create")(function* (input) {
        const principal = yield* currentPrincipal()
        const id = ID.create()
        const sealed = yield* seal(principal, id, input.value)
        const credential = new Info({
          id,
          integrationID: input.integrationID,
          label: input.label ?? "default",
          version: sealed.fingerprint,
          value: input.value,
        })
        yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              yield* tx
                .delete(CredentialTable)
                .where(and(ownership(principal), eq(CredentialTable.integration_id, credential.integrationID)))
                .run()
              yield* tx
                .insert(CredentialTable)
                .values({
                  id: credential.id,
                  tenant_id: principal.tenantID,
                  owner_user_id: principal.userID,
                  integration_id: credential.integrationID,
                  label: credential.label,
                  value: redactedStoredValue,
                  encrypted_value: sealed.ciphertext,
                  value_key_version: sealed.keyVersion,
                  value_fingerprint: sealed.fingerprint,
                })
                .run()
            }),
          )
          .pipe(Effect.orDie)
        return credential
      }),
      update: Effect.fn("Credential.update")(function* (id, updates, options) {
        if (updates.label === undefined && updates.value === undefined) return
        const principal = yield* currentPrincipal()
        const sealed = updates.value === undefined ? undefined : yield* seal(principal, id, updates.value)
        const changed = yield* db
          .update(CredentialTable)
          .set({
            ...(updates.label === undefined ? {} : { label: updates.label }),
            ...(sealed === undefined
              ? {}
              : {
                  value: redactedStoredValue,
                  encrypted_value: sealed.ciphertext,
                  value_key_version: sealed.keyVersion,
                  value_fingerprint: sealed.fingerprint,
                }),
          })
          .where(
            and(
              ownership(principal),
              eq(CredentialTable.id, id),
              options === undefined ? undefined : eq(CredentialTable.value_fingerprint, options.expectedVersion),
            ),
          )
          .returning({ id: CredentialTable.id })
          .all()
          .pipe(Effect.orDie)
        if (options !== undefined && changed.length !== 1)
          return yield* Effect.die(new Error("Credential changed or was removed during update"))
      }),
      remove: Effect.fn("Credential.remove")(function* (id) {
        const principal = yield* currentPrincipal()
        yield* db
          .delete(CredentialTable)
          .where(and(ownership(principal), eq(CredentialTable.id, id)))
          .run()
          .pipe(Effect.orDie)
      }),
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node, TenantPlatform.node] })
