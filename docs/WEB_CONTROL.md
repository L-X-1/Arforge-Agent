# Local Web control center

The Web control center is an optional browser client over Arforge's canonical
session runtime and Bridge contract. It does not use the raw-provider proxy and
does not create a second Agent implementation.

Start it from a trusted workspace:

```powershell
arforge web
```

The default listener is `127.0.0.1:8810`. The launcher creates an ephemeral
high-entropy token, opens a URL whose fragment contains that token, and the
page moves it into browser session storage. URL fragments are not sent in HTTP
request URLs. Every `/api/*` request and the fetch-based SSE stream require the
token as a Bearer credential.

Useful options:

```text
arforge web --port 8811
arforge web --no-open
arforge web --host 127.0.0.1 --port 8810
```

Set `ARFORGE_WEB_TOKEN` to a value of at least 32 characters for a stable token.
Binding to a non-loopback address additionally requires
`ARFORGE_ALLOW_REMOTE_WEB=1`; a generated token is never accepted for remote
binding. Use a trusted TLS reverse proxy and network access controls for any
remote deployment.

The browser UI supports durable session creation/history, context-capacity
status, normal Agent turns, bounded SSE event replay, queued prompts, steering,
cooperative cancellation and permission-mode selection. The authenticated
`POST /api/bridge` endpoint exposes the same validated protocol 1.2 methods as
the desktop sidecar, including structured questions, approvals, context
compaction and run reports.

Only one profile writer should run at once. The launcher therefore uses the same
profile lock as the desktop sidecar; stop the desktop client before starting
the Web control center against the same `ARFORGE_HOME`.
