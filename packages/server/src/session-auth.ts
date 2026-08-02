export * as SessionAuth from "./session-auth"

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import { Option, Schema } from "effect"
import { ServerAuth } from "./auth"

export const COOKIE_NAME = "arforge_session"
export const SESSION_TTL_SECONDS = 8 * 60 * 60

const Payload = Schema.Struct({
  version: Schema.Literal(1),
  issuedAt: Schema.Number,
  expiresAt: Schema.Number,
  nonce: Schema.String,
})
const decodeJson = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)
const decodePayload = Schema.decodeUnknownOption(Payload)
const revoked = new Map<string, number>()

export function issue(config: ServerAuth.Info, input?: { now?: number; secure?: boolean }) {
  if (!ServerAuth.required(config)) return

  const now = Math.floor((input?.now ?? Date.now()) / 1000)
  const payload = Buffer.from(
    JSON.stringify({
      version: 1,
      issuedAt: now,
      expiresAt: now + SESSION_TTL_SECONDS,
      nonce: randomBytes(16).toString("base64url"),
    }),
  ).toString("base64url")
  const token = `${payload}.${signature(payload, config)}`

  return {
    token,
    expiresAt: (now + SESSION_TTL_SECONDS) * 1000,
    cookie: [
      `${COOKIE_NAME}=${token}`,
      "Path=/",
      "HttpOnly",
      "SameSite=Strict",
      `Max-Age=${SESSION_TTL_SECONDS}`,
      input?.secure ? "Secure" : undefined,
    ]
      .filter((part): part is string => !!part)
      .join("; "),
  }
}

export function clearCookie(secure: boolean) {
  return [
    `${COOKIE_NAME}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    "Max-Age=0",
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
    secure ? "Secure" : undefined,
  ]
    .filter((part): part is string => !!part)
    .join("; ")
}

export function fromCookie(cookieHeader: string | undefined, config: ServerAuth.Info, now = Date.now()) {
  if (!ServerAuth.required(config)) return Option.none()

  const token = readToken(cookieHeader)
  if (!token) return Option.none()
  const current = Math.floor(now / 1000)
  cleanupRevocations(current)
  if ((revoked.get(tokenDigest(token)) ?? 0) > current) return Option.none()

  const parts = token.split(".")
  if (parts.length !== 2) return Option.none()
  const expected = Buffer.from(signature(parts[0], config))
  const actual = Buffer.from(parts[1])
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return Option.none()

  const json = decodeJson(Buffer.from(parts[0], "base64url").toString("utf8"))
  if (Option.isNone(json)) return Option.none()
  const payload = decodePayload(json.value)
  if (Option.isNone(payload)) return Option.none()

  if (payload.value.issuedAt > current + 60) return Option.none()
  if (payload.value.expiresAt <= current) return Option.none()
  if (payload.value.expiresAt - payload.value.issuedAt !== SESSION_TTL_SECONDS) return Option.none()
  return payload
}

export function revoke(cookieHeader: string | undefined, config: ServerAuth.Info, now = Date.now()) {
  const token = readToken(cookieHeader)
  if (!token) return false
  const session = fromCookie(cookieHeader, config, now)
  if (Option.isNone(session)) return false
  revoked.set(tokenDigest(token), session.value.expiresAt)
  return true
}

export function secureForHost(host: string | undefined) {
  if (!host) return true

  const normalized = host.trim().toLowerCase()
  const hostname = normalized.startsWith("[")
    ? normalized.slice(1, normalized.indexOf("]"))
    : normalized.split(":")[0]
  if (hostname === "localhost" || hostname === "::1") return false
  if (/^127(?:\.\d{1,3}){3}$/.test(hostname)) return false
  return true
}

export function requestAuthorized(
  request: {
    cookie?: string
    host?: string
    method: string
    now?: number
    origin?: string
  },
  config: ServerAuth.Info,
) {
  if (Option.isNone(fromCookie(request.cookie, config, request.now))) return false
  if (request.method === "GET" || request.method === "HEAD" || request.method === "OPTIONS") return true
  if (!request.origin || !request.host || !URL.canParse(request.origin)) return false
  return new URL(request.origin).host.toLowerCase() === request.host.toLowerCase()
}

function signature(payload: string, config: ServerAuth.Info) {
  const password = Option.getOrElse(config.password, () => "")
  return createHmac("sha256", `${config.username}\0${password}`).update(payload).digest("base64url")
}

function readToken(cookieHeader: string | undefined) {
  return cookieHeader
    ?.split(";")
    .map((part) => part.trim().split("=", 2))
    .find(([name]) => name === COOKIE_NAME)?.[1]
}

function tokenDigest(token: string) {
  return createHash("sha256").update(token).digest("base64url")
}

function cleanupRevocations(now: number) {
  for (const [token, expiresAt] of revoked) {
    if (expiresAt <= now) revoked.delete(token)
  }
}
