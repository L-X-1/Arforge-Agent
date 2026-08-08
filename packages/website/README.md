# Arforge Website

Static bilingual marketing and account-entry site for `arforgeagent.com`.

## Local commands

Run from the repository root:

```powershell
npx --yes bun@1.3.14 --cwd packages/website dev
npx --yes bun@1.3.14 --cwd packages/website check
npx --yes bun@1.3.14 --cwd packages/website test
npx --yes bun@1.3.14 --cwd packages/website build
```

The package uses Astro for static HTML and keeps the existing SolidJS product app separate at `/app/`.

## Authentication

The account pages call the existing same-origin endpoints:

- `/auth/login`
- `/auth/register`
- `/auth/verify-email`
- `/auth/forgot-password`
- `/auth/reset-password`

They use `credentials: include`; no access token is stored in website JavaScript or browser storage. A login return path must pass `safeReturnPath` and otherwise falls back to `/app/`.

## Windows release gate

`public/releases/windows.json` is the only website input for the Windows download. A public button is rendered only when all of the following are true:

- `available` is true;
- `signed` is true;
- `acceptancePassed` is true;
- the size and all required metadata are present;
- SHA-256 is exactly 64 hexadecimal characters;
- the HTTPS download host is `arforgeagent.com` or one of its subdomains.

The checked-in manifest is intentionally unavailable. The signed release workflow must replace it only after release acceptance.

## Deployment routing

The production edge must keep these paths on the same origin:

- public static output: `/`, `/zh-CN/*`, `/en/*`, legal and account pages;
- SolidJS Web app: `/app/*`;
- Arforge Server: `/auth/*`, `/api/*`, event stream and WebSocket paths;
- immutable OSS downloads: `/downloads/*` or the approved download subdomain.

Dynamic account, device and API responses must use `Cache-Control: no-store`. Apply the headers in `public/_headers` at the edge; the file itself is also suitable for static hosts that support `_headers` syntax.
