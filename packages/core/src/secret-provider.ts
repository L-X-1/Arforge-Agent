export * as SecretProvider from "./secret-provider"

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"
import { spawn } from "node:child_process"
import { Context, Effect, Layer, Schema } from "effect"
import { makeGlobalNode } from "./effect/app-node"
import { sanitizeChildEnvironment } from "./secret-environment"

const MAX_SECRET_BYTES = 16 * 1024 * 1024
const DPAPI_ENTROPY = "Arforge-Agent/secret-provider/v1"
const TEST_EPHEMERAL_KEY = randomBytes(32)

export class Error extends Schema.TaggedErrorClass<Error>()("SecretProvider.Error", {
  operation: Schema.Literals(["protect", "unprotect", "resolve", "initialize"]),
  provider: Schema.String,
  message: Schema.String,
}) {}

export interface Interface {
  readonly id: string
  readonly protect: (plaintext: Uint8Array) => Effect.Effect<string, Error>
  readonly unprotect: (ciphertext: string) => Effect.Effect<Uint8Array, Error>
  /** Reads a named runtime secret only at the innermost executor boundary. */
  readonly resolve: (name: string) => Effect.Effect<string | undefined, Error>
}

export class Service extends Context.Service<Service, Interface>()("@arforge/SecretProvider") {}

const failure = (operation: Error["operation"], provider: string, cause: unknown) =>
  new Error({
    operation,
    provider,
    message: cause instanceof globalThis.Error ? cause.message : String(cause),
  })

function ensureBounded(input: Uint8Array, operation: Error["operation"], provider: string) {
  if (input.byteLength > MAX_SECRET_BYTES)
    throw failure(operation, provider, `secret payload exceeds ${MAX_SECRET_BYTES} bytes`)
}

const resolveEnvironment = (provider: string, name: string) =>
  Effect.try({
    try: () => {
      if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(name)) throw new globalThis.Error("invalid environment secret name")
      return process.env[name]
    },
    catch: (cause) => failure("resolve", provider, cause),
  })

export function makeAes256Gcm(key: Uint8Array, id = "aes-256-gcm-env"): Interface {
  if (key.byteLength !== 32) throw failure("initialize", id, "AES-256-GCM key must contain exactly 32 bytes")
  const secretKey = Buffer.from(key)
  return Service.of({
    id,
    protect: (plaintext) =>
      Effect.try({
        try: () => {
          ensureBounded(plaintext, "protect", id)
          const iv = randomBytes(12)
          const cipher = createCipheriv("aes-256-gcm", secretKey, iv)
          const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()])
          return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64")
        },
        catch: (cause) => failure("protect", id, cause),
      }),
    unprotect: (ciphertext) =>
      Effect.try({
        try: () => {
          const value = Buffer.from(ciphertext, "base64")
          ensureBounded(value, "unprotect", id)
          if (value.byteLength < 28) throw new globalThis.Error("encrypted secret envelope is truncated")
          const decipher = createDecipheriv("aes-256-gcm", secretKey, value.subarray(0, 12))
          decipher.setAuthTag(value.subarray(12, 28))
          return new Uint8Array(Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]))
        },
        catch: (cause) => failure("unprotect", id, cause),
      }),
    resolve: (name) => resolveEnvironment(id, name),
  })
}

const powershell = (operation: "protect" | "unprotect", input: Uint8Array) => {
  const method = operation === "protect" ? "Protect" : "Unprotect"
  const script = [
    "$ErrorActionPreference='Stop'",
    "Add-Type -AssemblyName System.Security",
    "$raw=[Console]::In.ReadToEnd()",
    "$bytes=[Convert]::FromBase64String($raw)",
    `$entropy=[Text.Encoding]::UTF8.GetBytes('${DPAPI_ENTROPY}')`,
    `$result=[Security.Cryptography.ProtectedData]::${method}($bytes,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)`,
    "[Console]::Out.Write([Convert]::ToBase64String($result))",
  ].join(";")
  return new Promise<Uint8Array>((resolve, reject) => {
    ensureBounded(input, operation, "windows-dpapi-current-user")
    const child = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
      windowsHide: true,
      env: sanitizeChildEnvironment(process.env),
      stdio: ["pipe", "pipe", "pipe"],
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let outputBytes = 0
    const timeout = setTimeout(() => {
      child.kill()
      reject(new globalThis.Error("Windows DPAPI operation timed out"))
    }, 30_000)
    child.stdout.on("data", (chunk: Buffer) => {
      outputBytes += chunk.byteLength
      if (outputBytes <= MAX_SECRET_BYTES * 2) stdout.push(chunk)
    })
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.reduce((sum, item) => sum + item.byteLength, 0) < 8_192) stderr.push(chunk)
    })
    child.once("error", (cause) => {
      clearTimeout(timeout)
      reject(cause)
    })
    child.once("close", (code) => {
      clearTimeout(timeout)
      if (code !== 0) {
        reject(
          new globalThis.Error(
            `Windows DPAPI failed with exit code ${code}: ${Buffer.concat(stderr).toString("utf8").slice(0, 2_000)}`,
          ),
        )
        return
      }
      try {
        resolve(new Uint8Array(Buffer.from(Buffer.concat(stdout).toString("utf8").trim(), "base64")))
      } catch (cause) {
        reject(cause)
      }
    })
    child.stdin.end(Buffer.from(input).toString("base64"))
  })
}

export function makeWindowsDpapi(): Interface {
  const id = "windows-dpapi-current-user"
  return Service.of({
    id,
    protect: (plaintext) =>
      Effect.tryPromise({
        try: () => powershell("protect", plaintext).then((value) => Buffer.from(value).toString("base64")),
        catch: (cause) => failure("protect", id, cause),
      }),
    unprotect: (ciphertext) =>
      Effect.tryPromise({
        try: () => powershell("unprotect", new Uint8Array(Buffer.from(ciphertext, "base64"))),
        catch: (cause) => failure("unprotect", id, cause),
      }),
    resolve: (name) => resolveEnvironment(id, name),
  })
}

function environmentKey(): Uint8Array | undefined {
  const value = process.env.ARFORGE_SECRET_MASTER_KEY?.trim()
  if (!value) return
  const decoded = /^[a-f\d]{64}$/i.test(value) ? Buffer.from(value, "hex") : Buffer.from(value, "base64")
  if (decoded.byteLength !== 32)
    throw failure("initialize", "aes-256-gcm-env", "ARFORGE_SECRET_MASTER_KEY must be 32-byte hex or base64")
  return new Uint8Array(decoded)
}

function productionProvider(): Interface {
  const key = environmentKey()
  if (key) return makeAes256Gcm(key)
  if (process.env.NODE_ENV === "test" || process.env.BUN_ENV === "test")
    return makeAes256Gcm(TEST_EPHEMERAL_KEY, "test-ephemeral-aes-256-gcm")
  if (process.platform === "win32") return makeWindowsDpapi()
  throw failure(
    "initialize",
    "unavailable",
    "set ARFORGE_SECRET_MASTER_KEY on non-Windows deployments before storing credentials",
  )
}

const layer = Layer.sync(Service, productionProvider)

export const node = makeGlobalNode({ service: Service, layer, deps: [] })
