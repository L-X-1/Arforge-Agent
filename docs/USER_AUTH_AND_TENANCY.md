# User authentication and tenant isolation

Arforge has two mutually exclusive server authentication modes:

- `private` (default) keeps the single-server username/password behavior.
- `users` enables registered users, verified email addresses, persistent database sessions, and tenant-scoped data.

The `users` mode is designed for PostgreSQL behind HTTPS. It intentionally refuses to start with an insecure public URL, a short auth secret, or SQLite in a production configuration.

## Production configuration

Apply all PostgreSQL migrations before starting the upgraded application, then configure:

```dotenv
ARFORGE_DATABASE_MODE=server
ARFORGE_DB_URL=postgresql://arforge_app:...@db.example.com:5432/arforge
ARFORGE_AUTH_MODE=users
ARFORGE_AUTH_SECRET=<at least 32 cryptographically random bytes>
ARFORGE_PUBLIC_URL=https://arforge.example.com
ARFORGE_AUTH_EMAIL_WEBHOOK_URL=https://mailer.example.com/arforge-auth
ARFORGE_AUTH_EMAIL_WEBHOOK_TOKEN=<independent webhook bearer token>
```

Generate the auth secret with a cryptographically secure generator. For example, PowerShell can produce a Base64 value without writing it to the repository:

```powershell
$bytes = [byte[]]::new(48)
[Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
[Convert]::ToBase64String($bytes)
```

Set `ARFORGE_TRUST_PROXY=true` only when Arforge is behind a trusted proxy that overwrites `X-Forwarded-For`. Otherwise the application deliberately ignores that header for login rate limiting.

Never enable `ARFORGE_AUTH_EXPOSE_TOKENS` on a deployed host. The application validates this at runtime and rejects it when `ARFORGE_PUBLIC_URL` is not loopback.

## Email delivery contract

The configured webhook receives an authenticated `POST` request with JSON:

```json
{
  "template": "verify-email",
  "to": "user@example.com",
  "actionUrl": "https://arforge.example.com/?verify_token=<single-use-token>",
  "expiresAt": "2026-08-03T00:00:00.000Z"
}
```

`template` is either `verify-email` or `reset-password`. The webhook must return a 2xx response only after accepting the message. Verification links expire after 24 hours; password-reset links expire after one hour. Tokens are random, single-use, and only their keyed digest is stored.

For loopback development only, set all of the following to exercise the flow without a mail provider:

```dotenv
ARFORGE_DATABASE_MODE=local
ARFORGE_AUTH_MODE=users
ARFORGE_AUTH_SECRET=<at least 32 random characters>
ARFORGE_PUBLIC_URL=http://localhost:4096
ARFORGE_AUTH_EXPOSE_TOKENS=true
```

The browser completes verification/reset directly in this explicitly insecure development mode. Do not copy that setting to staging or production.

## Security behavior

- Passwords use Argon2id with 19 MiB memory, two iterations, and parallelism one. Password length is 12–256 characters.
- Login failures are persisted in PostgreSQL and limited independently by normalized account and client address. Successful login clears the account bucket.
- Sessions use opaque 256-bit random tokens. Only a keyed digest is stored. Cookies are `HttpOnly`, `SameSite=Strict`, and `Secure` outside loopback.
- Sessions have a 30-day absolute lifetime and a 7-day idle lifetime. Password reset and “sign out all devices” increment the account session epoch and revoke every active session.
- Registration and password-reset responses do not disclose whether an email address already exists.
- State-changing authenticated API requests require a same-origin `Origin` header.

## Tenant and database enforcement

Every core business table has non-null `tenant_id` and `owner_user_id` columns with foreign keys. The PostgreSQL migration enables and forces row-level security on all of those tables.

For every authenticated request, Arforge opens a transaction and sets request-local `arforge.tenant_id` and `arforge.user_id` values. RLS then requires:

1. the row tenant to match the request tenant;
2. an active membership for the current user in that tenant; and
3. writes to carry the current user as owner.

The settings are transaction-local, so a pooled database connection cannot leak one request's identity into the next request. The application database role must not be a superuser and must not have `BYPASSRLS`. The migration uses `FORCE ROW LEVEL SECURITY` so table ownership alone does not bypass the policy.

## Deployment verification

After migration and startup:

1. Confirm `GET /auth/config` reports `{"mode":"users"}`.
2. Register and verify two different accounts.
3. Run the reusable live-database penetration test with an application URL and an administrative fixture URL configured:

   ```powershell
   bun --cwd packages/core run db:test:postgres-rls
   ```

   The script attacks RLS as `arforge_app`; the administrator connection is used only to create and clean uniquely named temporary fixtures.

4. Create data with account A, then confirm account B receives no row through the API.
5. In PostgreSQL, confirm every business table reports both `relrowsecurity` and `relforcerowsecurity` as true.
6. Open two browsers for one account, use “Sign out all devices” in one, and confirm the other session is rejected.
7. Submit repeated invalid logins and confirm HTTP 429 plus `Retry-After`, including after an application restart.

Keep a database backup from immediately before the migration. Rollback requires restoring that backup because removing ownership and identity state would otherwise destroy security-relevant data.
