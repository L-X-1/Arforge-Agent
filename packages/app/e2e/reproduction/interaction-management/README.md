# Isolated management interaction regression

This fixture renders production management components with memory-only SDK responses. It never connects to Desktop CDP 9222, backend servers or user data. Playwright launches installed Chrome with a fresh temporary profile, one worker, external requests blocked and no business HTTP allowed. Only its own Vite server uses loopback port 4479; Playwright owns its lifetime.

From `packages/app`, use Bun and the installed workspace dependencies.

```powershell
$env:MANAGEMENT_AUDIT_RUN='review'
bun run test:e2e --config e2e/reproduction/interaction-management/playwright.config.ts --global-timeout=300000
bun run tsgo -p e2e/reproduction/interaction-management/tsconfig.json
```

Reports and traces go to `docs/ui-redesign/interaction-audit-v3-20261029/management-browser-<run>`. No dependency install or product build is required.

Cases cover Memory pagination/detail/edit/read failures/source guards/cancel, schedule editor version conflicts, tenant error read retry, unsupported shell recovery, real approval context and execution receipt separation, stale-directory startup and route registration reads, and settings navigation focus. Navigation cases mock child business panels only; they cannot establish child-panel feature correctness. All other component handlers under test are production handlers. Deletion is cancelled; the only approved decision is an in-memory fixture reply. DTO, error classification, source/version assertions are retained in the tests.

The per-page and per-state inventory in `management-report.json` records remaining unknowns. These targeted regressions do not constitute all-page acceptance, Electron/native acceptance, a production benchmark, or the separate 30x stress project.
