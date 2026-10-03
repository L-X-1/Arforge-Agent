#!/usr/bin/env bun

import { and, eq } from "drizzle-orm"
import { Effect } from "effect"
import { Credential } from "../src/credential"
import { CredentialTable } from "../src/credential/sql"
import { loadProductEnv } from "../src/config/product-env"
import { Database } from "../src/database/database"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "../src/effect/layer-node"

loadProductEnv()

const layer = AppNodeBuilder.build(LayerNode.group([Database.node, Credential.node]))
const localScope = and(
  eq(CredentialTable.tenant_id, Database.DefaultLocalPrincipal.tenantID),
  eq(CredentialTable.owner_user_id, Database.DefaultLocalPrincipal.userID),
)

const program = Effect.gen(function* () {
  const database = yield* Database.Service
  const credentials = yield* Credential.Service
  const before = yield* database.db.select().from(CredentialTable).where(localScope).all().pipe(Effect.orDie)
  const resolved = yield* credentials.all()
  const after = yield* database.db.select().from(CredentialTable).where(localScope).all().pipe(Effect.orDie)
  const incomplete = after.filter((row) => {
    const fields = [row.encrypted_value, row.value_key_version, row.value_fingerprint]
    return !fields.every((value) => value !== null)
  })
  if (incomplete.length > 0)
    return yield* Effect.die(
      new Error(`${incomplete.length} local credential row(s) remain without a complete envelope`),
    )
  return {
    schemaVersion: 1,
    tenantID: Database.DefaultLocalPrincipal.tenantID,
    rowsInspected: after.length,
    rowsMigrated: before.filter((row) => row.encrypted_value === null).length,
    usableCredentialsResolved: resolved.length,
    completeEnvelopes: after.length,
    plaintextValuesPrinted: false,
  }
})

console.log(JSON.stringify(await Effect.runPromise(program.pipe(Effect.provide(layer), Effect.scoped)), null, 2))
