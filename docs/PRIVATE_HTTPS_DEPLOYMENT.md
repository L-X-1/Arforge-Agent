# Private HTTPS deployment

Arforge can terminate TLS itself or run behind a private reverse proxy. In both
cases configure `ARFORGE_SERVER_PASSWORD`; HTTPS without application
authentication is not a private deployment.

## Option 1 — native HTTPS (direct and self-contained)

Create a development/private certificate:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/create_private_https_certificate.ps1 `
  -Hostname localhost
```

Start the server:

```powershell
$env:ARFORGE_SERVER_USERNAME = "arforge"
$env:ARFORGE_SERVER_PASSWORD = "<a unique high-entropy password>"
$env:ARFORGE_HTTPS_CERT = "E:\secure\arforge-private.crt"
$env:ARFORGE_HTTPS_KEY = "E:\secure\arforge-private.key"
bun packages/arforge/src/index.ts serve --hostname 127.0.0.1 --port 4096
```

The equivalent CLI flags are `--https-cert` and `--https-key`. Arforge refuses
to start when only one TLS file is supplied. The native listener enforces TLS
1.2 or newer and reports an `https://` listener URL.

A self-signed certificate must be trusted explicitly on every client. For a
stable private DNS name, use a certificate issued by the organization/private
CA instead.

## Option 2 — reverse-proxy TLS (recommended for a stable server)

Bind Arforge to loopback and let the proxy own certificate renewal:

```powershell
$env:ARFORGE_SERVER_PASSWORD = "<a unique high-entropy password>"
bun packages/arforge/src/index.ts serve --hostname 127.0.0.1 --port 4096
```

The proxy must:

- expose only HTTPS;
- preserve `Host` and `Origin`;
- support WebSocket upgrades and streaming responses;
- forward to `127.0.0.1:4096`, never a public clear-text listener;
- apply a request-size limit and rate limiting in addition to Arforge's login
  throttling.

Ready-to-use Caddy configurations and a validation command are provided in
`deploy/private-https`. Start the backend through the canonical launcher:

```powershell
.\scripts\run_cli.ps1 serve --hostname 127.0.0.1 --port 4096
.\deploy\private-https\validate-private-https.ps1 -Mode Internal -Domain arforge.localhost
```

The application session is an eight-hour signed `HttpOnly`,
`SameSite=Strict` cookie. Non-loopback hosts receive the `Secure` attribute.
Cookie-authenticated mutations also require an `Origin` whose host exactly
matches the request `Host`, which blocks cross-site form requests.

## Option 3 — private overlay network

Expose native HTTPS only on a private VPN/overlay address. This removes public
internet reachability but does not replace TLS or the Arforge login. Keep all
three controls: private network, HTTPS and application authentication.

## Acceptance check

1. An unauthenticated `/doc` request returns `401`.
2. `/auth/login` returns an `arforge_session` cookie with `HttpOnly`,
   `SameSite=Strict` and, for non-loopback hosts, `Secure`.
3. The cookie opens `/doc`; a copied or modified cookie is rejected.
4. A state-changing cookie request without a matching `Origin` is rejected.
5. Logout sets `Max-Age=0` and revokes the token until its original expiry.
6. `openssl s_client` or a browser reports TLS 1.2 or TLS 1.3 and the expected
   certificate identity.
