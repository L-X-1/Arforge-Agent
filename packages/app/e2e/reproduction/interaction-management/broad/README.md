# Reviewed management reproduction suites

This host builds only the ten existing, reviewed reproduction fixtures into `docs/ui-redesign/interaction-audit-v3-20261029/management-broad-production`. Their SDK responses are in-memory. It does not start a backend, execute the full App build/prebuild, install anything, run Git or connect to Desktop CDP.

The multi-page HTML transform only corrects each fixture's `/main.tsx` entry for the shared build root. The context transform supplies `DialogProvider` to older fixture roots that omitted it. Production components and original test assertions are preserved. `prepare.cjs` records SHA-256 hashes and copies the original assertions, redirecting only the Playwright test import to the automatic network fence.

From `packages/app`, use Node, Bun, the installed workspace dependencies and Chrome.

```powershell
node e2e/reproduction/interaction-management/broad/prepare.cjs
bun run vite build --config e2e/reproduction/interaction-management/broad/vite.config.ts
$env:MANAGEMENT_BROAD_RUN='review'
bun run test:e2e --config e2e/reproduction/interaction-management/broad/playwright.config.ts
```

Playwright starts its own static host on `127.0.0.1:4481`, uses one worker and a fresh Chrome profile, and closes its own host. The case's reviewed suite identity selects its index HTML. Only static loopback GET/HEAD requests are allowed; other HTTP and all WebSockets fail assertions. The global browser budget is eight minutes; existing per-case timeouts remain.

Coverage is limited to what the existing cases assert: workspace/session response isolation; Personal Workspace receipts at 375/1280px; tenant role/error recovery in three locales; runtime evidence, role boundaries, cancellation and MCP reconciliation; and runtime rendering in 18 locales. Provider OAuth, plugin install/update/uninstall and complete skill/experience deployment lifecycles are not established by their list-scope cases. See `management-report.json` for individual cases and remaining plan states.
