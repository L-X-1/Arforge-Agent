# Step 6.5 MCP Runtime sealing evidence

- Date: 2026-08-12
- Plan: `Arforge-最终详细实施计划-V2-2026-08-11.md`, Step 6.5
- Branch: `codex/phase-0-checkpoint`
- Scope: local stdio, Streamable HTTP/SSE, OAuth, resources/prompts, tool calls,
  configuration, cancellation, reload/recovery, and remote-content trust

## Sealed boundaries

Local stdio startup now remains behind a frozen intent and fresh L3 human
approval. The executable identity, canonical working directory, argv digest,
environment-key scope, and protected configuration digest are bound before the
attempt is durable. The executable identity is rechecked immediately before
spawn, and the child receives only the allowlisted environment. Cancellation,
reload, disconnect, replacement, and crash paths retain or settle a durable
tombstone before a replacement can start.

Remote MCP calls continue through the MCP Gateway adapter. The local manifest,
server declaration, and local policy jointly determine the effect scope; the
adapter opens a fresh L3 human decision for unknown/non-idempotent effects and
fails closed when scope or canonical arguments are unavailable. OAuth state,
PKCE, redirect/loopback callback identity, project/server generation, and
configured scopes remain bound to the protected credential record. Tokens never
enter ordinary config or model-visible output.

The MCP node now consumes the application-wide `LocationServiceMap`, and the
application root provides that map once. This keeps MCP's ActionGateway and the
UI/API approval surface on the same location-scoped Authorizer instance. The
approval request action is also bound to the same frozen action name as the
durable MCP connect action, preventing a mismatched request from being shown or
replied into a different durable identity.

MCP instructions, resource text, and tool-result text are model-facing
untrusted content. They are wrapped by `ContextFirewall.untrusted` with
`instruction_allowed="false"`; the raw durable protocol result remains
available to the runtime but is not promoted to trusted instructions.

## Verification

```powershell
bun test --cwd packages/arforge test/mcp/local-approval.test.ts
bun test --cwd packages/arforge test/mcp/lifecycle.test.ts
bun test --cwd packages/arforge test/mcp/auth.test.ts test/mcp/cancellation.test.ts test/mcp/catalog.test.ts test/mcp/gateway-adapter.test.ts test/mcp/headers.test.ts test/mcp/oauth-auto-connect.test.ts test/mcp/oauth-browser.test.ts test/mcp/oauth-callback.test.ts test/mcp/oauth-provider.test.ts test/mcp/session-recovery.test.ts
bun test --cwd packages/arforge test/session/system.test.ts
bun run --cwd packages/arforge typecheck
bun run --cwd packages/core typecheck
git diff --check
```

Results: local approval `22 pass`, `0 fail`, `154 expect()`; lifecycle
`21 pass`, `0 fail`, `49 expect()`; MCP auth/transport/OAuth/Gateway group
`61 pass`, `0 fail`, `212 expect()`; system trust-boundary tests `5 pass`,
`0 fail`, `19 expect()`; both package typechecks and whitespace validation
passed. The two long lifecycle/OAuth tests also pass independently with a
15-second test timeout. A later one-worker aggregate run reached the end of
the lifecycle group but Bun 1.3.14 crashed in its own test runner during the
OAuth group; isolated group runs above are the authoritative application
verification.
