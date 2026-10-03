# Tenant Platform V1

## Goal

Close the early multi-tenant platform boundary without introducing a second
execution or event truth source. Tenant membership, project membership,
per-tenant policy, encrypted secret envelopes, settled usage, data requests,
backup manifests, and audit export artifacts/receipts are durable projections
owned by the TypeScript Core database.

## Non-goals

- No hosted KMS, object store, billing provider, or email provider is assumed.
- No physical tenant deletion is performed by a request endpoint. A deletion
  request is durable, admin-authorized, replayable, and must be executed by a
  later maintenance run with a verified backup.
- Billing does not reserve or execute model calls. It only consumes usage that
  the runtime has already settled.
- SQLite remains the embedded single-owner backend. PostgreSQL is the
  multi-tenant backend with database-enforced RLS.
- Audit JSON is returned to an authorized client for local download. Hosted
  object storage and long-term export delivery are not assumed.

## Boundary decisions

1. The authenticated principal supplies tenant/user identity. Request payloads
   cannot select a different tenant.
2. Tenant membership controls tenant visibility; project membership narrows
   access to project-scoped rows.
3. Admin operations require an owner/admin membership role. App/member reads
   are limited to safe projections and settled usage.
4. Tenant keys are wrapped by the existing `SecretProvider`; secret rows store
   ciphertext and a ciphertext fingerprint, never plaintext. New envelopes
   bind tenant, owner, purpose, and key version as authenticated data so rows
   cannot be swapped between users or credential identities.
5. Data export, deletion, backup, and restore produce durable manifests or
   request rows and audit entries. Approval and rejection both retain the
   administrator decision actor. Unknown external artifact state is not
   treated as success.
6. Provider credentials are user-owned rows. Their values are encrypted with
   the tenant key ring, while PostgreSQL RLS limits ordinary users to their own
   credential metadata. Legacy plaintext rows are re-enveloped on first read.
7. Tenant key versions are monotonic. A policy may retain or advance the
   current version but cannot silently roll back to an older key.
8. A backup manifest is bound to the tenant policy region, schema revision,
   and artifact digest. Reusing an artifact digest with different metadata is
   a conflict, not an idempotent replay.
9. Audit export returns a downloadable canonical JSON artifact and a durable
   receipt. The digest is SHA-256 over the exact JSON bytes; secret ciphertext,
   plaintext, and raw data-request reasons are excluded from the artifact.

## Failure and rollback

- A failed migration is transactional and leaves the migration ledger
  unchanged.
- A duplicate settlement/request/manifest is idempotent only when its digest
  and tenant binding match; divergent payloads fail closed.
- Credential envelopes fail closed when their fingerprint, owner, purpose, or
  key version does not match the stored row.
- Deletion remains recoverable until a separately verified maintenance run
  completes it.
- Backup restoration is accepted only from a verified digest-bound manifest.
- An audit receipt is committed only after its safe JSON artifact and digest
  have been deterministically assembled.

## Verification

The work package must pass schema/core/protocol/server typechecks, targeted
tenant isolation and noisy-neighbor tests, migration freshness checks, and a
safe projection audit whose downloadable bytes match the receipt digest and
contain no secret ciphertext, plaintext, or raw data-request reason values.
