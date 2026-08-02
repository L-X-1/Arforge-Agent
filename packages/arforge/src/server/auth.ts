export * as ServerAuth from "./auth"

import { ConfigService } from "@/effect/config-service"
import { Flag } from "@arforge-ai/core/flag/flag"
import { createHash, timingSafeEqual } from "node:crypto"
import { Config as EffectConfig, Context, Option, Redacted } from "effect"

export type Credentials = {
  password?: string
  username?: string
}

export type DecodedCredentials = {
  readonly username: string
  readonly password: Redacted.Redacted
}

export class Config extends ConfigService.Service<Config>()("@arforge/ServerAuthConfig", {
  password: EffectConfig.string("ARFORGE_SERVER_PASSWORD").pipe(EffectConfig.option),
  username: EffectConfig.string("ARFORGE_SERVER_USERNAME").pipe(EffectConfig.withDefault("arforge")),
}) {}

export type Info = Context.Service.Shape<typeof Config>

export function required(config: Info) {
  return Option.isSome(config.password) && config.password.value !== ""
}

export function authorized(credentials: DecodedCredentials, config: Info) {
  return (
    Option.isSome(config.password) &&
    secureEqual(credentials.username, config.username) &&
    secureEqual(Redacted.value(credentials.password), config.password.value)
  )
}

function secureEqual(left: string, right: string) {
  return timingSafeEqual(createHash("sha256").update(left).digest(), createHash("sha256").update(right).digest())
}

export function header(credentials?: Credentials) {
  const password = credentials?.password ?? Flag.ARFORGE_SERVER_PASSWORD
  if (!password) return undefined

  const username = credentials?.username ?? Flag.ARFORGE_SERVER_USERNAME ?? "arforge"
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`
}

export function headers(credentials?: Credentials) {
  const authorization = header(credentials)
  if (!authorization) return undefined
  return { Authorization: authorization }
}
