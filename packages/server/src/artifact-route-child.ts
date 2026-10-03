import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { AgentRuntime as AgentRuntimeSchema } from "@arforge-ai/schema/agent-runtime"

const [databasePath, home, workspace] = Bun.argv.slice(2)
if (!databasePath || !home || !workspace) throw new Error("artifact route child requires database, home, and workspace")

const { DateTime, Effect, Schema } = await import("effect")
const { HttpRouter } = await import("effect/unstable/http")
const { createEmbeddedRoutes } = await import("./routes")
const { AgentRuntime } = await import("@arforge-ai/schema/agent-runtime")
const { OpaqueArtifact } = await import("@arforge-ai/core/runtime/artifact-ref")

const web = HttpRouter.toWebHandler(createEmbeddedRoutes() as never, { disableLogger: true }) as unknown as {
  readonly handler: (request: Request) => Promise<Response>
  readonly dispose: () => Promise<void>
}

const sessionResponse = await web.handler(
  new Request("http://localhost/api/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ location: { directory: workspace } }),
  }),
)
if (sessionResponse.status !== 200) throw new Error(`session create returned ${sessionResponse.status}`)
const sessionBody = (await sessionResponse.json()) as { data?: { id?: string } }
const sessionID = sessionBody.data?.id
if (!sessionID) throw new Error("session create did not return an ID")

const ownerContextResponse = await web.handler(new Request("http://localhost/api/artifacts/owner-context"))
if (ownerContextResponse.status !== 200)
  throw new Error(`artifact owner context returned ${ownerContextResponse.status}: ${await ownerContextResponse.text()}`)
const ownerContext = (await ownerContextResponse.json()) as {
  readonly profile?: { readonly scope?: string; readonly id?: string }
  readonly tenant?: { readonly scope?: string; readonly id?: string }
  readonly tenantReadable?: boolean
}
if (
  ownerContext.profile?.scope !== "profile" ||
  ownerContext.profile.id !== "usr_local" ||
  ownerContext.tenant?.scope !== "tenant" ||
  ownerContext.tenant.id !== "ten_local" ||
  ownerContext.tenantReadable !== true
)
  throw new Error("artifact owner context did not expose the authenticated owner scopes")
if (JSON.stringify(ownerContext).includes("path") || JSON.stringify(ownerContext).includes("secret"))
  throw new Error("artifact owner context exposed a path or secret")

const content = Buffer.from("artifact route proof\n", "utf8")
const digest = createHash("sha256").update(content).digest("hex")
const handle = "tool_route_proof"
const reference = OpaqueArtifact.make({
  version: 1,
  kind: "tool_output",
  digest,
  mime: "text/plain",
  sizeBytes: content.byteLength,
  owner: { scope: "session", id: sessionID },
  retention: { mode: "session", expiresAt: DateTime.makeUnsafe(Date.now() + 60_000) },
  retrievalHint: { kind: "managed", handle },
  createdAt: DateTime.makeUnsafe(Date.now()),
})
const outputDirectory = join(home, "tool-output")
const indexDirectory = join(outputDirectory, "index")
mkdirSync(indexDirectory, { recursive: true })
writeFileSync(join(outputDirectory, handle), content, { flag: "wx" })
writeFileSync(
  join(indexDirectory, `${handle}.json`),
  JSON.stringify(Schema.encodeSync(AgentRuntime.OpaqueArtifactRef)(reference)),
  "utf8",
)

const readResponse = await web.handler(
  new Request(`http://localhost/api/session/${sessionID}/artifacts/read`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reference: Schema.encodeSync(AgentRuntime.OpaqueArtifactRef)(reference) }),
  }),
)
if (readResponse.status !== 200)
  throw new Error(`artifact read returned ${readResponse.status}: ${await readResponse.text()}`)
if ((await readResponse.text()) !== content.toString("utf8")) throw new Error("artifact bytes changed")
if (readResponse.headers.get("x-arforge-artifact-id") !== reference.artifactID)
  throw new Error("artifact identity header missing")
if (readResponse.headers.get("cache-control") !== "private, no-store") throw new Error("cache policy missing")

const rangeResponse = await web.handler(
  new Request(`http://localhost/api/session/${sessionID}/artifacts/read-range`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      reference: Schema.encodeSync(AgentRuntime.OpaqueArtifactRef)(reference),
      offset: 0,
      length: 8,
      ifMatch: `"${reference.digest}"`,
    }),
  }),
)
if (rangeResponse.status !== 206 || (await rangeResponse.text()) !== "artifact")
  throw new Error(`artifact range returned ${rangeResponse.status}`)
if (rangeResponse.headers.get("content-range") !== `bytes 0-7/${content.byteLength}`)
  throw new Error("artifact content range header missing")
if (rangeResponse.headers.get("accept-ranges") !== "bytes") throw new Error("artifact range capability missing")

const sessionCatalogResponse = await web.handler(
  new Request(`http://localhost/api/session/${sessionID}/artifacts/catalog`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ limit: 10 }),
  }),
)
if (sessionCatalogResponse.status !== 200)
  throw new Error(`session artifact catalog returned ${sessionCatalogResponse.status}: ${await sessionCatalogResponse.text()}`)
const sessionCatalog = (await sessionCatalogResponse.json()) as {
  readonly entries?: ReadonlyArray<{ readonly reference?: { readonly artifactID?: string }; readonly readCount?: number }>
  readonly headSequence?: number
}
if (sessionCatalog.entries?.length !== 1 || sessionCatalog.entries[0]?.reference?.artifactID !== reference.artifactID)
  throw new Error("session artifact catalog did not return the authorized receipt")
if (sessionCatalog.entries[0]?.readCount !== 2 || sessionCatalog.headSequence !== 2)
  throw new Error("session artifact catalog read counters are incomplete")
if (JSON.stringify(sessionCatalog).includes("path") || JSON.stringify(sessionCatalog).includes(outputDirectory))
  throw new Error("artifact catalog exposed a local path")

const sessionAuditResponse = await web.handler(
  new Request(`http://localhost/api/session/${sessionID}/artifacts/audit`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ limit: 10 }),
  }),
)
if (sessionAuditResponse.status !== 200) throw new Error(`session artifact audit returned ${sessionAuditResponse.status}`)
const sessionAudit = (await sessionAuditResponse.json()) as ReadonlyArray<{ action?: string; sequence?: number }>
if (sessionAudit.length !== 2 || sessionAudit[0]?.action !== "range" || sessionAudit[1]?.action !== "read")
  throw new Error("session artifact audit did not preserve the newest hash-chain actions")
if (JSON.stringify(sessionAudit).includes("path") || JSON.stringify(sessionAudit).includes(outputDirectory))
  throw new Error("artifact audit exposed a local path")

const staleRangeResponse = await web.handler(
  new Request(`http://localhost/api/session/${sessionID}/artifacts/read-range`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      reference: Schema.encodeSync(AgentRuntime.OpaqueArtifactRef)(reference),
      offset: 0,
      length: 8,
      ifMatch: '"stale"',
    }),
  }),
)
if (staleRangeResponse.status !== 400) throw new Error(`stale artifact range returned ${staleRangeResponse.status}`)

const writeReference = (reference: AgentRuntimeSchema.OpaqueArtifactRef, content: Buffer) => {
  const handle = reference.retrievalHint.handle
  writeFileSync(join(outputDirectory, handle), content, { flag: "wx" })
  writeFileSync(
    join(indexDirectory, `${handle}.json`),
    JSON.stringify(Schema.encodeSync(AgentRuntime.OpaqueArtifactRef)(reference)),
    "utf8",
  )
}

const profileContent = Buffer.from("profile artifact proof\n", "utf8")
const profileReference = OpaqueArtifact.make({
  version: 1,
  kind: "tool_output",
  digest: createHash("sha256").update(profileContent).digest("hex"),
  mime: "text/plain",
  sizeBytes: profileContent.byteLength,
  owner: { scope: "profile", id: "usr_local" },
  retention: { mode: "durable" },
  retrievalHint: { kind: "managed", handle: "tool_profile_route_proof" },
  createdAt: DateTime.makeUnsafe(Date.now()),
})
writeReference(profileReference, profileContent)
const profileReadResponse = await web.handler(
  new Request("http://localhost/api/artifacts/read", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reference: Schema.encodeSync(AgentRuntime.OpaqueArtifactRef)(profileReference) }),
  }),
)
if (profileReadResponse.status !== 200 || (await profileReadResponse.text()) !== profileContent.toString("utf8"))
  throw new Error(`profile artifact read returned ${profileReadResponse.status}`)

const profileRangeResponse = await web.handler(
  new Request("http://localhost/api/artifacts/read-range", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      reference: Schema.encodeSync(AgentRuntime.OpaqueArtifactRef)(profileReference),
      offset: 0,
      length: 7,
      ifMatch: profileReference.digest,
    }),
  }),
)
if (profileRangeResponse.status !== 206 || (await profileRangeResponse.text()) !== "profile")
  throw new Error(`profile artifact range returned ${profileRangeResponse.status}`)

const profileCatalogResponse = await web.handler(
  new Request("http://localhost/api/artifacts/catalog", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ owner: { scope: "profile", id: "usr_local" }, limit: 10 }),
  }),
)
if (profileCatalogResponse.status !== 200) throw new Error(`profile artifact catalog returned ${profileCatalogResponse.status}`)
const profileCatalog = (await profileCatalogResponse.json()) as {
  readonly entries?: ReadonlyArray<{ readonly reference?: { readonly artifactID?: string }; readonly readCount?: number }>
}
if (profileCatalog.entries?.length !== 1 || profileCatalog.entries[0]?.reference?.artifactID !== profileReference.artifactID)
  throw new Error("profile artifact catalog did not return the authorized receipt")
if (profileCatalog.entries[0]?.readCount !== 2) throw new Error("profile artifact catalog read counters are incomplete")

const profileAuditResponse = await web.handler(
  new Request("http://localhost/api/artifacts/audit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ owner: { scope: "profile", id: "usr_local" }, limit: 10 }),
  }),
)
if (profileAuditResponse.status !== 200) throw new Error(`profile artifact audit returned ${profileAuditResponse.status}`)
const profileAudit = (await profileAuditResponse.json()) as ReadonlyArray<{ action?: string }>
if (profileAudit.length !== 2 || profileAudit.some((record) => record.action !== "read" && record.action !== "range"))
  throw new Error("profile artifact audit actions are incomplete")

const tenantContent = Buffer.from("tenant artifact proof\n", "utf8")
const tenantReference = OpaqueArtifact.make({
  version: 1,
  kind: "tool_output",
  digest: createHash("sha256").update(tenantContent).digest("hex"),
  mime: "text/plain",
  sizeBytes: tenantContent.byteLength,
  owner: { scope: "tenant", id: "ten_local" },
  retention: { mode: "durable" },
  retrievalHint: { kind: "managed", handle: "tool_tenant_route_proof" },
  createdAt: DateTime.makeUnsafe(Date.now()),
})
writeReference(tenantReference, tenantContent)
const tenantReadResponse = await web.handler(
  new Request("http://localhost/api/artifacts/read", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reference: Schema.encodeSync(AgentRuntime.OpaqueArtifactRef)(tenantReference) }),
  }),
)
if (tenantReadResponse.status !== 200 || (await tenantReadResponse.text()) !== tenantContent.toString("utf8"))
  throw new Error(`tenant artifact read returned ${tenantReadResponse.status}`)

const tenantCatalogResponse = await web.handler(
  new Request("http://localhost/api/artifacts/catalog", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ owner: { scope: "tenant", id: "ten_local" }, limit: 10 }),
  }),
)
if (tenantCatalogResponse.status !== 200) throw new Error(`tenant artifact catalog returned ${tenantCatalogResponse.status}`)
const tenantCatalog = (await tenantCatalogResponse.json()) as {
  readonly entries?: ReadonlyArray<{ readonly reference?: { readonly artifactID?: string }; readonly readCount?: number }>
}
if (tenantCatalog.entries?.length !== 1 || tenantCatalog.entries[0]?.reference?.artifactID !== tenantReference.artifactID)
  throw new Error("tenant artifact catalog did not return the authorized receipt")
if (tenantCatalog.entries[0]?.readCount !== 1) throw new Error("tenant artifact catalog read counters are incomplete")

const tenantAuditResponse = await web.handler(
  new Request("http://localhost/api/artifacts/audit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ owner: { scope: "tenant", id: "ten_local" }, limit: 10 }),
  }),
)
if (tenantAuditResponse.status !== 200) throw new Error(`tenant artifact audit returned ${tenantAuditResponse.status}`)
const tenantAudit = (await tenantAuditResponse.json()) as ReadonlyArray<{ action?: string }>
if (tenantAudit.length !== 1 || tenantAudit[0]?.action !== "read")
  throw new Error("tenant artifact audit actions are incomplete")

const sessionOnScopedRoute = await web.handler(
  new Request("http://localhost/api/artifacts/read", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reference: Schema.encodeSync(AgentRuntime.OpaqueArtifactRef)(reference) }),
  }),
)
if (sessionOnScopedRoute.status !== 403)
  throw new Error(`session artifact on scoped route returned ${sessionOnScopedRoute.status}`)

const wrongScope = { ...reference, owner: { scope: "session" as const, id: "ses_other" } }
const forbiddenResponse = await web.handler(
  new Request(`http://localhost/api/session/${sessionID}/artifacts/read`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reference: Schema.encodeSync(AgentRuntime.OpaqueArtifactRef)(wrongScope) }),
  }),
)
if (forbiddenResponse.status !== 403) throw new Error(`scope mismatch returned ${forbiddenResponse.status}`)

writeFileSync(join(outputDirectory, handle), "tampered\n", "utf8")
const tamperedResponse = await web.handler(
  new Request(`http://localhost/api/session/${sessionID}/artifacts/read`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reference: Schema.encodeSync(AgentRuntime.OpaqueArtifactRef)(reference) }),
  }),
)
if (tamperedResponse.status !== 400) throw new Error(`tampered artifact returned ${tamperedResponse.status}`)
const tamperedBody = (await tamperedResponse.json()) as { kind?: string; message?: string }
if (tamperedBody.kind !== "artifact-read-failed" || !tamperedBody.message?.includes("verified"))
  throw new Error("tampered artifact error was not normalized")

const insightResponse = await web.handler(
  new Request("http://localhost/api/runtime-insight/snapshot?limit=50"),
)
if (insightResponse.status !== 200) throw new Error(`runtime insight snapshot returned ${insightResponse.status}`)
const insightBody = (await insightResponse.json()) as {
  audit?: ReadonlyArray<{ action?: string; metadata?: Record<string, unknown> }>
}
const artifactAudits = insightBody.audit ?? []
if (!artifactAudits.some((entry) => entry.action === "artifact.read.success"))
  throw new Error("artifact success audit was not projected")
if (!artifactAudits.some((entry) => entry.action === "artifact.read.rejected"))
  throw new Error("artifact rejection audit was not projected")

const catalogPath = join(outputDirectory, "catalog", "state.json")
const catalog = JSON.parse(readFileSync(catalogPath, "utf8")) as {
  readonly nextSequence?: number
  readonly headHash?: string
  readonly entries?: Record<string, unknown>
  readonly audit?: ReadonlyArray<{
    readonly sequence?: number
    readonly action?: string
    readonly previousHash?: string
    readonly recordHash?: string
  }>
}
if (!catalog.entries || Object.keys(catalog.entries).length !== 3) throw new Error("artifact catalog entries are incomplete")
const catalogAudit = catalog.audit ?? []
if (catalogAudit.length < 6 || catalog.nextSequence !== catalogAudit.length + 1)
  throw new Error("artifact catalog sequence is incomplete")
for (let index = 1; index < catalogAudit.length; index++) {
  if (catalogAudit[index]?.sequence !== (catalogAudit[index - 1]?.sequence ?? 0) + 1)
    throw new Error("artifact catalog sequence is not monotonic")
  if (catalogAudit[index]?.previousHash !== catalogAudit[index - 1]?.recordHash)
    throw new Error("artifact catalog hash chain is broken")
}
if (catalog.headHash !== catalogAudit[catalogAudit.length - 1]?.recordHash)
  throw new Error("artifact catalog head hash is stale")
if (!catalogAudit.some((entry) => entry.action === "read") || !catalogAudit.some((entry) => entry.action === "range"))
  throw new Error("artifact catalog read actions are missing")

await web.dispose()
console.log("artifact-route-ok")
