export * as TriggerV2 from "./trigger"

import { Trigger } from "@arforge-ai/schema/trigger"
import { Context, Effect, Layer, Schema } from "effect"
import { makeGlobalNode } from "./effect/app-node"
import { ScheduledPromptV2 } from "./scheduled-prompt"
import { ScheduledPromptTriggerAccess } from "./scheduled-prompt/trigger-access"
import { SessionV2 } from "./session"

export const ProfileName = Trigger.ProfileName
export type ProfileName = Trigger.ProfileName
export const Action = Trigger.Action
export type Action = Trigger.Action
export const Profile = Trigger.Profile
export type Profile = Trigger.Profile
export const Profiles = Trigger.Profiles
export type Profiles = Trigger.Profiles
export const Result = Trigger.Result
export type Result = Trigger.Result
export const JsonValue = Trigger.JsonValue
export type JsonValue = Trigger.JsonValue

export const MAX_TRIGGER_BODY_BYTES = 256 * 1024
export const MAX_TRIGGER_RESPONSE_BYTES = 100_000
export const MAX_TRIGGER_PROFILES = 16
export const MAX_TRIGGER_ID_CHARS = 128

const ProfilePattern = /^[a-z][a-z0-9_-]{0,31}$/
const TriggerIDPattern = /^[A-Za-z0-9_-]{1,128}$/
const EnvironmentNamePattern = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/
const HeaderNamePattern = /^[A-Za-z][A-Za-z0-9-]{0,63}$/

export class RuntimeError extends Schema.TaggedErrorClass<RuntimeError>()("Trigger.RuntimeError", {
  code: Schema.String,
  message: Schema.String,
}) {}

type Environment = Readonly<Record<string, string | undefined>>
type BearerAuth = { readonly type: "bearer_environment"; readonly environmentVariable: string }
type OAuthAuth = {
  readonly type: "oauth_client_credentials"
  readonly tokenUrl: string
  readonly clientIdEnvironment: string
  readonly clientSecretEnvironment: string
  readonly scopes: ReadonlyArray<string>
  readonly audience: string
}
type HttpProfile = {
  readonly name: ProfileName
  readonly kind: "http"
  readonly baseUrl: string
  readonly auth: BearerAuth | OAuthAuth
  readonly headers: Readonly<Record<string, string>>
  readonly timeout: number
}
type LocalProfile = {
  readonly name: ProfileName
  readonly kind: "local"
  readonly baseUrl: ""
  readonly headers: Readonly<Record<string, never>>
  readonly timeout: number
}
type ProfileConfig = LocalProfile | HttpProfile

export interface ExecuteInput {
  readonly action: Action
  readonly profile?: ProfileName
  readonly sessionID: SessionV2.ID
  readonly triggerID?: string
  readonly body?: Readonly<Record<string, unknown>>
}

export interface Interface {
  readonly profiles: () => Profiles
  readonly execute: (input: ExecuteInput) => Effect.Effect<Result, RuntimeError>
}

export class Service extends Context.Service<Service, Interface>()("@arforge/v2/Trigger") {}

export interface LayerOptions {
  readonly environment?: Environment
  readonly profilesJson?: string
  readonly fetch?: typeof globalThis.fetch
}

export const layerWith = (options: LayerOptions = {}) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const schedules = yield* ScheduledPromptTriggerAccess.Service
      const environment = options.environment ?? process.env
      const configured = yield* attempt(() =>
        parseProfiles(options.profilesJson ?? environment["ARFORGE_TRIGGER_PROFILES"], environment),
      )
      const byName = new Map(configured.map((profile) => [profile.name, profile]))
      const request = options.fetch ?? globalThis.fetch
      const tokenCache = new Map<string, { readonly token: string; readonly expires: number }>()

      const profiles = (): Profiles => {
        const items = configured
          .map((profile) => publicProfile(profile, environment))
          .toSorted((left, right) => left.name.localeCompare(right.name))
        return { items, count: items.length }
      }

      const execute = Effect.fn("Trigger.execute")(function* (input: ExecuteInput) {
        const triggerID = (input.triggerID ?? "").trim()
        if (["get", "update", "run"].includes(input.action) && !TriggerIDPattern.test(triggerID))
          return yield* runtime("INVALID_TRIGGER_ID", "trigger_id is invalid")
        if (input.action === "create" || input.action === "update") {
          if (!input.body || Object.keys(input.body).length === 0)
            return yield* runtime("INVALID_BODY", `${input.action} requires a non-empty body`)
          yield* attempt(() => validateJson(input.body))
          const encoded = new TextEncoder().encode(JSON.stringify(input.body))
          if (encoded.byteLength > MAX_TRIGGER_BODY_BYTES)
            return yield* runtime("BODY_TOO_LARGE", "trigger body exceeds the size limit")
        } else if (input.body && Object.keys(input.body).length > 0) {
          return yield* runtime("INVALID_BODY", `${input.action} does not accept a body`)
        }

        const profileName = input.profile ?? ProfileName.make("local")
        const profile = byName.get(profileName)
        if (!profile) return yield* runtime("PROFILE_NOT_FOUND", "trigger profile not found")
        if (profile.kind === "http")
          return yield* Effect.tryPromise({
            try: () =>
              executeHttp({
                request,
                profile,
                action: input.action,
                triggerID,
                body: input.body,
                environment,
                tokenCache,
              }),
            catch: (cause) =>
              cause instanceof RuntimeError
                ? cause
                : new RuntimeError({ code: "NETWORK_ERROR", message: "trigger request failed" }),
          })

        return yield* executeLocal(schedules, {
          action: input.action,
          sessionID: input.sessionID,
          triggerID,
          body: input.body,
        }).pipe(
          Effect.map((data) => ({
            profile: profile.name,
            kind: "local" as const,
            action: input.action,
            status: 200,
            ok: true,
            data: encodeLocalData(input.action, data),
          })),
          Effect.catch((error) =>
            error instanceof RuntimeError
              ? Effect.fail(error)
              : runtime(scheduleErrorCode(error), scheduleErrorMessage(error)),
          ),
        )
      })

      return Service.of({ profiles, execute })
    }),
  )

const executeLocal = (
  schedules: ScheduledPromptTriggerAccess.Interface,
  input: {
    readonly action: Action
    readonly sessionID: SessionV2.ID
    readonly triggerID: string
    readonly body?: Readonly<Record<string, unknown>>
  },
) =>
  Effect.gen(function* () {
    if (input.action === "list") {
      const items = yield* schedules.list(input.sessionID)
      return { items, count: items.length }
    }
    if (input.action === "get") {
      const scheduleID = yield* attempt(() => ScheduledPromptV2.ID.make(input.triggerID))
      return yield* schedules.get({
        sessionID: input.sessionID,
        scheduleID,
      })
    }
    if (input.action === "create") {
      const body = input.body!
      const allowed = new Set(["name", "cron", "cron_expression", "prompt", "recurring", "durable", "enabled"])
      const unexpected = Object.keys(body)
        .filter((key) => !allowed.has(key))
        .toSorted()
      if (unexpected.length)
        return yield* runtime("INVALID_BODY", `unsupported local trigger fields: ${unexpected.join(", ")}`)
      if (body.cron !== undefined && body.cron_expression !== undefined)
        return yield* runtime("INVALID_BODY", "provide only one of cron or cron_expression")
      const cron = body.cron_expression ?? body.cron
      if (typeof cron !== "string" || typeof body.prompt !== "string")
        return yield* runtime("INVALID_BODY", "local trigger create requires cron_expression and prompt")
      const prepared = yield* attempt(() => {
        const name =
          body.name === undefined || body.name === ""
            ? `Scheduled trigger ${crypto.randomUUID().slice(0, 12)}`
            : requireString(body.name, "name")
        return {
          name: ScheduledPromptV2.Name.make(name),
          cron: ScheduledPromptV2.Cron.make(cron),
          prompt: ScheduledPromptV2.Prompt.make(body.prompt as string),
          recurring: requireOptionalBoolean(body.recurring, "recurring") ?? true,
          durable: requireOptionalBoolean(body.durable, "durable") ?? true,
          enabled: requireOptionalBoolean(body.enabled, "enabled") ?? true,
        }
      })
      const created = yield* schedules.create({
        sessionID: input.sessionID,
        name: prepared.name,
        cron: prepared.cron,
        prompt: prepared.prompt,
        recurring: prepared.recurring,
        durable: prepared.durable,
        enabled: prepared.enabled,
      })
      return created
    }

    const scheduleID = yield* attempt(() => ScheduledPromptV2.ID.make(input.triggerID))
    const current = yield* schedules.get({ sessionID: input.sessionID, scheduleID })
    if (input.action === "run")
      return yield* schedules.runRequested({
        sessionID: input.sessionID,
        scheduleID,
      })

    const body = input.body!
    const allowed = new Set(["name", "cron", "cron_expression", "prompt", "recurring", "enabled"])
    const unexpected = Object.keys(body)
      .filter((key) => !allowed.has(key))
      .toSorted()
    if (unexpected.length)
      return yield* runtime("INVALID_BODY", `unsupported local trigger fields: ${unexpected.join(", ")}`)
    if (body.cron !== undefined && body.cron_expression !== undefined)
      return yield* runtime("INVALID_BODY", "provide only one of cron or cron_expression")
    const cron = body.cron_expression ?? body.cron
    const changes = yield* attempt(() => ({
      name: body.name === undefined ? undefined : ScheduledPromptV2.Name.make(requireString(body.name, "name")),
      cron: cron === undefined ? undefined : ScheduledPromptV2.Cron.make(requireString(cron, "cron")),
      prompt:
        body.prompt === undefined ? undefined : ScheduledPromptV2.Prompt.make(requireString(body.prompt, "prompt")),
      recurring: requireOptionalBoolean(body.recurring, "recurring"),
      enabled: requireOptionalBoolean(body.enabled, "enabled"),
    }))
    return yield* schedules.update({
      sessionID: input.sessionID,
      scheduleID,
      ...changes,
    })
  })

const encodeScheduledPrompt = Schema.encodeUnknownSync(ScheduledPromptV2.Info)

function encodeLocalData(action: Action, value: unknown): JsonValue {
  if (action === "list") {
    const list = value as { readonly items: ReadonlyArray<ScheduledPromptV2.Info>; readonly count: number }
    return {
      items: list.items.map((item) => encodeScheduledPrompt(item)),
      count: list.count,
    }
  }
  return encodeScheduledPrompt(value)
}

async function executeHttp(input: {
  readonly request: typeof globalThis.fetch
  readonly profile: HttpProfile
  readonly action: Action
  readonly triggerID: string
  readonly body?: Readonly<Record<string, unknown>>
  readonly environment: Environment
  readonly tokenCache: Map<string, { readonly token: string; readonly expires: number }>
}): Promise<Result> {
  const token = await tokenFor(input)
  const suffix =
    input.action === "get" || input.action === "update"
      ? `/${encodeURIComponent(input.triggerID)}`
      : input.action === "run"
        ? `/${encodeURIComponent(input.triggerID)}/run`
        : ""
  const method = input.action === "list" || input.action === "get" ? "GET" : "POST"
  const body =
    input.action === "create" || input.action === "update"
      ? JSON.stringify(input.body)
      : input.action === "run"
        ? "{}"
        : undefined
  let response: Response
  try {
    response = await input.request(input.profile.baseUrl + suffix, {
      method,
      redirect: "manual",
      signal: AbortSignal.timeout(input.profile.timeout * 1_000),
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "User-Agent": "Arforge/trigger-runtime",
        ...input.profile.headers,
      },
      body,
    })
  } catch {
    throw new RuntimeError({ code: "NETWORK_ERROR", message: "trigger request failed" })
  }
  const data = await boundedJson(response, "trigger response")
  validateJson(data, 0, "INVALID_RESPONSE", "trigger response")
  return {
    profile: input.profile.name,
    kind: "http",
    action: input.action,
    status: response.status,
    ok: response.status >= 200 && response.status < 300,
    data: data as JsonValue,
  }
}

async function tokenFor(input: {
  readonly request: typeof globalThis.fetch
  readonly profile: HttpProfile
  readonly environment: Environment
  readonly tokenCache: Map<string, { readonly token: string; readonly expires: number }>
}) {
  const auth = input.profile.auth
  if (auth.type === "bearer_environment") {
    const token = input.environment[auth.environmentVariable]
    if (!token) throw new RuntimeError({ code: "AUTH_FAILED", message: "trigger authentication is not configured" })
    return token
  }
  const cached = input.tokenCache.get(input.profile.name)
  if (cached && cached.expires > performance.now()) return cached.token
  const clientID = input.environment[auth.clientIdEnvironment]
  const clientSecret = input.environment[auth.clientSecretEnvironment]
  if (!clientID || !clientSecret)
    throw new RuntimeError({ code: "AUTH_FAILED", message: "trigger authentication is not configured" })
  const form = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientID,
    client_secret: clientSecret,
  })
  if (auth.scopes.length) form.set("scope", auth.scopes.join(" "))
  if (auth.audience) form.set("audience", auth.audience)
  let response: Response
  try {
    response = await input.request(auth.tokenUrl, {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(input.profile.timeout * 1_000),
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    })
  } catch {
    throw new RuntimeError({ code: "AUTH_FAILED", message: "trigger authentication failed" })
  }
  if (!response.ok) throw new RuntimeError({ code: "AUTH_FAILED", message: "trigger authentication failed" })
  const payload = await boundedJson(response, "authentication response")
  if (!isObject(payload) || typeof payload.access_token !== "string" || !payload.access_token)
    throw new RuntimeError({ code: "AUTH_FAILED", message: "trigger authentication failed" })
  const expiresIn =
    typeof payload.expires_in === "number" && Number.isFinite(payload.expires_in) ? payload.expires_in : 300
  input.tokenCache.set(input.profile.name, {
    token: payload.access_token,
    expires: performance.now() + Math.max(0, expiresIn - 30) * 1_000,
  })
  return payload.access_token
}

async function boundedJson(response: Response, subject: string) {
  const length = Number(response.headers.get("content-length"))
  if (Number.isFinite(length) && length > MAX_TRIGGER_RESPONSE_BYTES)
    throw new RuntimeError({ code: "RESPONSE_TOO_LARGE", message: `${subject} exceeds the size limit` })
  if (!response.body) return {}
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_TRIGGER_RESPONSE_BYTES) {
      await reader.cancel()
      throw new RuntimeError({ code: "RESPONSE_TOO_LARGE", message: `${subject} exceeds the size limit` })
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  if (bytes.byteLength === 0) return {}
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown
  } catch {
    throw new RuntimeError({ code: "INVALID_RESPONSE", message: `${subject} is not valid JSON` })
  }
}

export function parseProfiles(raw: string | undefined, environment: Environment = process.env): ProfileConfig[] {
  const result: ProfileConfig[] = [
    { name: ProfileName.make("local"), kind: "local", baseUrl: "", headers: {}, timeout: 20 },
  ]
  if (!raw?.trim()) return result
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new RuntimeError({ code: "INVALID_PROFILE", message: "ARFORGE_TRIGGER_PROFILES is invalid JSON" })
  }
  const items = isObject(parsed) ? parsed.profiles : parsed
  if (!Array.isArray(items))
    throw new RuntimeError({
      code: "INVALID_PROFILE",
      message: "ARFORGE_TRIGGER_PROFILES must contain a profile array",
    })
  for (const item of items) result.push(parseProfile(item, environment))
  if (result.length > MAX_TRIGGER_PROFILES)
    throw new RuntimeError({
      code: "INVALID_PROFILE",
      message: `trigger profiles must contain 1 to ${MAX_TRIGGER_PROFILES} items`,
    })
  if (new Set(result.map((profile) => profile.name)).size !== result.length)
    throw new RuntimeError({ code: "INVALID_PROFILE", message: "trigger profile names must be unique" })
  return result
}

function parseProfile(value: unknown, _environment: Environment): HttpProfile {
  if (!isObject(value))
    throw new RuntimeError({ code: "INVALID_PROFILE", message: "trigger profile must be an object" })
  if (typeof value.name !== "string" || !ProfilePattern.test(value.name) || value.name === "local")
    throw new RuntimeError({ code: "INVALID_PROFILE", message: "trigger profile name is invalid or reserved" })
  if (value.kind !== undefined && value.kind !== "http")
    throw new RuntimeError({ code: "INVALID_PROFILE", message: "configured trigger profile kind must be http" })
  const baseUrl = validateRemoteUrl(value.base_url, "base_url").replace(/\/+$/, "")
  const timeout =
    typeof value.timeout === "number" && Number.isFinite(value.timeout)
      ? Math.min(60, Math.max(0.1, value.timeout))
      : 20
  if (!isObject(value.auth))
    throw new RuntimeError({ code: "INVALID_PROFILE", message: "HTTP trigger profile auth must be an object" })
  let auth: BearerAuth | OAuthAuth
  if (value.auth.type === "bearer_environment") {
    auth = {
      type: "bearer_environment",
      environmentVariable: requireEnvironmentName(value.auth.environment_variable),
    }
  } else if (value.auth.type === "oauth_client_credentials") {
    if (
      value.auth.scopes !== undefined &&
      (!Array.isArray(value.auth.scopes) || !value.auth.scopes.every((scope) => typeof scope === "string"))
    )
      throw new RuntimeError({ code: "INVALID_PROFILE", message: "OAuth scopes must be an array of strings" })
    auth = {
      type: "oauth_client_credentials",
      tokenUrl: validateRemoteUrl(value.auth.token_url, "token_url"),
      clientIdEnvironment: requireEnvironmentName(value.auth.client_id_environment),
      clientSecretEnvironment: requireEnvironmentName(value.auth.client_secret_environment),
      scopes: (value.auth.scopes as string[] | undefined) ?? [],
      audience: typeof value.auth.audience === "string" ? value.auth.audience : "",
    }
  } else {
    throw new RuntimeError({ code: "INVALID_PROFILE", message: "unsupported trigger authentication type" })
  }
  const headers = cleanHeaders(value.headers)
  return {
    name: ProfileName.make(value.name),
    kind: "http",
    baseUrl,
    auth,
    headers,
    timeout,
  }
}

function publicProfile(profile: ProfileConfig, environment: Environment): Profile {
  if (profile.kind === "local")
    return { name: profile.name, kind: "local", baseUrl: "", timeout: profile.timeout, headerNames: [] }
  const auth =
    profile.auth.type === "bearer_environment"
      ? {
          type: profile.auth.type,
          environmentVariable: profile.auth.environmentVariable,
          configured: Boolean(environment[profile.auth.environmentVariable]),
        }
      : {
          type: profile.auth.type,
          tokenUrl: profile.auth.tokenUrl,
          clientIdEnvironment: profile.auth.clientIdEnvironment,
          clientSecretEnvironment: profile.auth.clientSecretEnvironment,
          scopes: [...profile.auth.scopes],
          audience: profile.auth.audience,
          configured: Boolean(
            environment[profile.auth.clientIdEnvironment] && environment[profile.auth.clientSecretEnvironment],
          ),
        }
  return {
    name: profile.name,
    kind: "http",
    baseUrl: profile.baseUrl,
    timeout: profile.timeout,
    headerNames: Object.keys(profile.headers).toSorted(),
    auth,
  }
}

function validateRemoteUrl(value: unknown, field: string) {
  if (typeof value !== "string") throw new RuntimeError({ code: "INVALID_PROFILE", message: `${field} is invalid` })
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new RuntimeError({ code: "INVALID_PROFILE", message: `${field} is invalid` })
  }
  if (parsed.username || parsed.password)
    throw new RuntimeError({ code: "INVALID_PROFILE", message: `${field} must not contain credentials` })
  if (parsed.search || parsed.hash)
    throw new RuntimeError({ code: "INVALID_PROFILE", message: `${field} must not contain a query or fragment` })
  const loopback =
    parsed.hostname === "localhost" ||
    parsed.hostname === "::1" ||
    parsed.hostname === "[::1]" ||
    /^127(?:\.\d{1,3}){3}$/.test(parsed.hostname)
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback))
    throw new RuntimeError({ code: "INVALID_PROFILE", message: `${field} must use HTTPS or loopback HTTP` })
  return parsed.toString().replace(/\/$/, "")
}

function cleanHeaders(value: unknown): Readonly<Record<string, string>> {
  if (value === undefined) return {}
  if (!isObject(value))
    throw new RuntimeError({ code: "INVALID_PROFILE", message: "trigger headers must be a string mapping" })
  const result: Record<string, string> = {}
  for (const [name, item] of Object.entries(value)) {
    if (
      !HeaderNamePattern.test(name) ||
      ["authorization", "cookie", "host", "proxy-authorization"].includes(name.toLowerCase())
    )
      throw new RuntimeError({ code: "INVALID_PROFILE", message: `trigger header is invalid or host-managed: ${name}` })
    if (typeof item !== "string" || item.length > 2_048 || /[\r\n\u0000]/.test(item))
      throw new RuntimeError({ code: "INVALID_PROFILE", message: `trigger header value is invalid: ${name}` })
    result[name] = item
  }
  return result
}

function validateJson(value: unknown, depth = 0, code = "INVALID_BODY", subject = "trigger body"): void {
  if (depth > 12) throw new RuntimeError({ code, message: `${subject} exceeds maximum nesting depth` })
  if (Array.isArray(value)) {
    value.forEach((item) => validateJson(item, depth + 1, code, subject))
    return
  }
  if (isObject(value)) {
    Object.values(value).forEach((item) => validateJson(item, depth + 1, code, subject))
    return
  }
  if (
    value !== null &&
    typeof value !== "string" &&
    typeof value !== "boolean" &&
    !(typeof value === "number" && Number.isFinite(value))
  )
    throw new RuntimeError({ code, message: `${subject} contains an unsupported JSON value` })
}

function requireString(value: unknown, field: string) {
  if (typeof value !== "string") throw new RuntimeError({ code: "INVALID_BODY", message: `${field} must be a string` })
  return value
}

function requireOptionalBoolean(value: unknown, field: string) {
  if (value === undefined) return
  if (typeof value !== "boolean")
    throw new RuntimeError({ code: "INVALID_BODY", message: `${field} must be a boolean` })
  return value
}

function requireEnvironmentName(value: unknown) {
  if (typeof value !== "string" || !EnvironmentNamePattern.test(value))
    throw new RuntimeError({ code: "INVALID_PROFILE", message: "environment variable name is invalid" })
  return value
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

const runtime = (code: string, message: string) => Effect.fail(new RuntimeError({ code, message }))
const attempt = <A>(evaluate: () => A) =>
  Effect.try({
    try: evaluate,
    catch: (cause) =>
      cause instanceof RuntimeError
        ? cause
        : new RuntimeError({ code: "INVALID_BODY", message: "trigger input is invalid" }),
  })

function scheduleErrorCode(error: unknown) {
  if (error instanceof ScheduledPromptTriggerAccess.AccessError) return error.code
  if (error instanceof ScheduledPromptV2.NotFoundError) return "TRIGGER_NOT_FOUND"
  if (error instanceof SessionV2.BusyError || error instanceof SessionV2.PromptConflictError) return "SESSION_BUSY"
  return "INVALID_BODY"
}

function scheduleErrorMessage(error: unknown) {
  if (error instanceof ScheduledPromptTriggerAccess.AccessError) return error.message
  if (error instanceof ScheduledPromptV2.NotFoundError) return "scheduled prompt not found"
  if (error instanceof SessionV2.BusyError || error instanceof SessionV2.PromptConflictError)
    return "session is already busy"
  if (error instanceof ScheduledPromptV2.InvalidCronError) return error.message
  return "local trigger operation is invalid"
}

export const node = makeGlobalNode({
  service: Service,
  layer: layerWith().pipe(Layer.orDie),
  deps: [ScheduledPromptTriggerAccess.node],
})
