# Isolated local HTML preview resources

## Scope

This increment adds opt-in CSS and raster-image loading to the existing static HTML preview. It does not enable document scripts, SVG, fonts, navigation, forms, element picking, source rewriting, Office integration, or an embedded browser. Safe preview remains available without resource authorization.

## Boundaries

- The authenticated application API opens and revokes grants through `POST /api/fs/preview/open` and `POST /api/fs/preview/close`, with the existing location query and identity middleware.
- Core owns filesystem reads. A grant is scoped to the current HTML document's directory and descendants, not the entire project. Missing files, external paths, symbolic links/junctions, dot-prefixed segments, and `node_modules` are rejected.
- Only CSS, PNG, JPEG, GIF, and WebP are served. CSS must be UTF-8 without NUL bytes; raster signatures must match their extension. Signature validation is not a complete image decoder.
- CSS is limited to 1 MB and other assets to 5 MB. Filesystem boundaries and sizes are checked before and after reads where applicable. These checks are defense in depth, not a claim of an OS-level filesystem sandbox against hostile concurrent directory replacement.
- The resource listener is created lazily on `127.0.0.2` with an OS-assigned port. It exposes no application API, writes, proxying, directory listing, or executable documents. The distinct loopback hostname separates ordinary main-server host cookies as well as origins.
- Resource URLs carry random 32-byte capabilities. Grants expire after five minutes, are tied to the API principal and location, and are held only in frontend memory. Do not paste these URLs into logs, chat messages, or persistent state.
- Limits are 32 grants, four active reads per grant, 16 global active reads, and 256 requests per grant. Expiry/revocation is rechecked after asynchronous reads. Closing the host clears grants and closes its listener.
- The iframe retains an empty sandbox and restrictive CSP. Opt-in adds only the validated grant URL prefix to image/style sources and a trusted base URL for relative CSS imports and images. Original HTML still passes through sanitization.
- Resource requests do not receive application API authorization headers. Explicit HTML image/stylesheet fetches use anonymous mode. Resource responses disable caching and MIME sniffing, expose no application cookies, and carry a restrictive document CSP.
- Desktop Node integration, context isolation, preload permissions, and sandbox settings are unchanged. Existing desktop window diagnostic logs redact these capability URLs.

## User flow

1. Open a local HTML file and select Preview or Split. Static safe preview does not request local resources.
2. Select Load local resources to authorize the document directory temporarily. Relative stylesheets, nested CSS imports, and supported raster images may then load.
3. Disable local resources, leave the preview, or switch document/server/location to release the current grant. Expiry also returns the preview to safe mode.
4. If opening fails, safe preview remains usable and the error is visible. If a revocation request fails, the UI reports that immediate revocation could not be confirmed; automatic server expiry remains the fallback.

This first transport is available only for local HTTP application servers. Remote or HTTPS servers need a separate deployment/transport design and do not silently fetch the client machine's loopback resources.

## Validation targets

- Core tests exercise real temporary files, directory scope, unsupported formats, malformed/oversized content, and junction/symlink refusal.
- Server tests exercise a real independent loopback listener, HTTP methods and Host validation, token boundaries, owner checks, expiry, in-flight revocation, capacity, and cleanup.
- App tests cover contract URL rules, authenticated API scoping, local-only availability, malformed grants, and private-error-body suppression.
- Desktop tests cover capability redaction without modifying unrelated diagnostics.
- Browser tests use the production app build and a real resource host, with mocked main grant API responses. They cover opt-in, relative CSS imports and images, cookie/header isolation, sandboxing, disable/unmount revocation, and safe fallback on failure.

The browser fixture is not an assertion that the production authenticated grant routes or a packaged Electron build have been end-to-end validated. Run affected package typechecks and existing preview/editor/history regression tests separately. Validation results are reported by the executing task rather than predeclared here.
