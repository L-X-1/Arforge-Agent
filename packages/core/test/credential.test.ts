import { describe, expect } from "bun:test"
import { and, eq } from "drizzle-orm"
import { Effect, Exit } from "effect"
import { Credential } from "@arforge-ai/core/credential"
import { CredentialTable } from "@arforge-ai/core/credential/sql"
import { Database } from "@arforge-ai/core/database/database"
import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { IdentityTenantMemberTable, IdentityUserTable } from "@arforge-ai/core/identity/sql"
import { Integration } from "@arforge-ai/core/integration"
import { testEffect } from "./lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([Credential.node, Database.node])))

describe("Credential", () => {
  it.effect("stores, updates, lists, and removes credentials", () =>
    Effect.gen(function* () {
      const credentials = yield* Credential.Service
      const database = yield* Database.Service
      const integrationID = Integration.ID.make("openai")
      const created = yield* credentials.create({
        integrationID,
        label: "Work",
        value: Credential.Key.make({ type: "key", key: "secret" }),
      })

      const encrypted = yield* database.db
        .select({
          value: CredentialTable.value,
          ciphertext: CredentialTable.encrypted_value,
          keyVersion: CredentialTable.value_key_version,
          fingerprint: CredentialTable.value_fingerprint,
          tenantID: CredentialTable.tenant_id,
          ownerUserID: CredentialTable.owner_user_id,
        })
        .from(CredentialTable)
        .where(eq(CredentialTable.id, created.id))
        .get()
      expect(JSON.stringify(encrypted?.value)).not.toContain("secret")
      expect(encrypted?.ciphertext).toMatch(/^v1\./)
      expect(encrypted?.ciphertext).not.toContain("secret")
      expect(encrypted?.fingerprint).toMatch(/^[a-f0-9]{64}$/)
      expect(encrypted).toMatchObject({ keyVersion: 1, tenantID: "ten_local", ownerUserID: "usr_local" })

      expect(yield* credentials.list(integrationID)).toEqual([created])
      expect(encrypted?.fingerprint).toBe(created.version)
      yield* credentials.update(created.id, { label: "Personal" })
      expect((yield* credentials.list(integrationID))[0]?.label).toBe("Personal")
      expect((yield* credentials.get(created.id))?.version).toBe(created.version)
      yield* credentials.update(created.id, { value: Credential.Key.make({ type: "key", key: "rotated-secret" }) })
      const rotated = yield* credentials.get(created.id)
      expect(rotated?.version).toMatch(/^[a-f0-9]{64}$/)
      expect(rotated?.version).not.toBe(created.version)
      expect(rotated?.value).toEqual({ type: "key", key: "rotated-secret" })
      expect((yield* credentials.get(created.id))?.version).toBe(rotated?.version)

      const replacement = yield* credentials.create({
        integrationID,
        label: "Replacement",
        value: Credential.Key.make({ type: "key", key: "replacement" }),
      })
      expect(yield* credentials.list(integrationID)).toEqual([replacement])

      yield* credentials.remove(replacement.id)
      expect(yield* credentials.list(integrationID)).toEqual([])
    }),
  )

  it.effect("migrates legacy plaintext rows into tenant-key envelopes on first read", () =>
    Effect.gen(function* () {
      const credentials = yield* Credential.Service
      const database = yield* Database.Service
      const id = Credential.ID.make("cred_legacy_plaintext")
      const integrationID = Integration.ID.make("legacy-provider")
      yield* database.db
        .insert(CredentialTable)
        .values({
          tenant_id: "ten_local",
          owner_user_id: "usr_local",
          id,
          integration_id: integrationID,
          label: "Legacy",
          value: Credential.Key.make({ type: "key", key: "legacy-secret" }),
        })
        .run()
      const obsoleteID = Credential.ID.make("cred_obsolete_plaintext")
      yield* database.db
        .insert(CredentialTable)
        .values({
          tenant_id: "ten_local",
          owner_user_id: "usr_local",
          id: obsoleteID,
          integration_id: null,
          label: "Obsolete",
          value: Credential.Key.make({ type: "key", key: "obsolete-secret" }),
        })
        .run()

      const firstRead = yield* credentials.get(id)
      expect(firstRead?.value).toEqual({ type: "key", key: "legacy-secret" })
      expect((yield* credentials.get(id))?.version).toBe(firstRead?.version)
      yield* credentials.all()
      const migrated = yield* database.db
        .select({
          value: CredentialTable.value,
          ciphertext: CredentialTable.encrypted_value,
          keyVersion: CredentialTable.value_key_version,
          fingerprint: CredentialTable.value_fingerprint,
        })
        .from(CredentialTable)
        .where(eq(CredentialTable.id, id))
        .get()
      expect(JSON.stringify(migrated?.value)).not.toContain("legacy-secret")
      expect(migrated?.ciphertext).toMatch(/^v1\./)
      expect(migrated?.keyVersion).toBe(1)
      expect(migrated?.fingerprint).toMatch(/^[a-f0-9]{64}$/)
      const obsolete = yield* database.db
        .select({ value: CredentialTable.value, ciphertext: CredentialTable.encrypted_value })
        .from(CredentialTable)
        .where(eq(CredentialTable.id, obsoleteID))
        .get()
      expect(JSON.stringify(obsolete?.value)).not.toContain("obsolete-secret")
      expect(obsolete?.ciphertext).toMatch(/^v1\./)
    }),
  )

  it.effect("isolates same-tenant credentials by user and authenticates their row identity", () =>
    Effect.gen(function* () {
      const credentials = yield* Credential.Service
      const database = yield* Database.Service
      const integrationID = Integration.ID.make("shared-provider")
      const local = yield* credentials.create({
        integrationID,
        label: "Owner credential",
        value: Credential.Key.make({ type: "key", key: "owner-secret" }),
      })

      const memberID = "usr_credential_member"
      const now = Date.now()
      yield* database.db
        .insert(IdentityUserTable)
        .values({
          id: memberID,
          email: "credential-member@arforge.invalid",
          normalized_email: "credential-member@arforge.invalid",
          display_name: "Credential member",
          password_hash: "!",
          status: "active",
          email_verified_at: now,
          session_epoch: 0,
          time_created: now,
          time_updated: now,
        })
        .run()
      yield* database.db
        .insert(IdentityTenantMemberTable)
        .values({
          tenant_id: "ten_local",
          user_id: memberID,
          role: "member",
          status: "active",
          time_created: now,
          time_updated: now,
        })
        .run()

      const member = yield* database.runAsPrincipal(
        { tenantID: "ten_local", userID: memberID },
        credentials.create({
          integrationID,
          label: "Member credential",
          value: Credential.Key.make({ type: "key", key: "member-secret" }),
        }),
      )
      expect((yield* credentials.list(integrationID)).map((item) => item.id)).toEqual([local.id])
      expect(
        yield* database.runAsPrincipal(
          { tenantID: "ten_local", userID: memberID },
          credentials.list(integrationID).pipe(Effect.map((items) => items.map((item) => item.id))),
        ),
      ).toEqual([member.id])
      expect(yield* credentials.get(member.id)).toBeUndefined()

      const rows = yield* database.db
        .select()
        .from(CredentialTable)
        .where(and(eq(CredentialTable.tenant_id, "ten_local"), eq(CredentialTable.integration_id, integrationID)))
        .all()
      expect(rows).toHaveLength(2)
      const ownerRow = rows.find((row) => row.id === local.id)
      const memberRow = rows.find((row) => row.id === member.id)
      expect(ownerRow?.encrypted_value).toBeTruthy()
      expect(memberRow?.encrypted_value).toBeTruthy()
      if (!ownerRow || !memberRow) throw new Error("expected both credential envelopes")

      yield* database.db
        .update(CredentialTable)
        .set({
          encrypted_value: ownerRow.encrypted_value,
          value_key_version: ownerRow.value_key_version,
          value_fingerprint: ownerRow.value_fingerprint,
        })
        .where(eq(CredentialTable.id, member.id))
        .run()
      const swapped = yield* database
        .runAsPrincipal({ tenantID: "ten_local", userID: memberID }, credentials.get(member.id))
        .pipe(Effect.exit)
      expect(Exit.isFailure(swapped)).toBe(true)
    }),
  )
})
