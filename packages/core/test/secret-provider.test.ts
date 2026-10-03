import { describe, expect, test } from "bun:test"
import { randomBytes } from "node:crypto"
import { Effect, Exit } from "effect"
import { SecretProvider } from "@arforge-ai/core/secret-provider"

describe("SecretProvider", () => {
  test("AES-256-GCM protects and restores credential bytes", async () => {
    const provider = SecretProvider.makeAes256Gcm(randomBytes(32))
    const plaintext = Buffer.from('{"apiKey":"sk-private-value"}', "utf8")
    const ciphertext = await Effect.runPromise(provider.protect(plaintext))

    expect(ciphertext).not.toContain("sk-private-value")
    const restored = await Effect.runPromise(provider.unprotect(ciphertext))
    expect(Buffer.from(restored).toString("utf8")).toBe(plaintext.toString("utf8"))
  })

  test("AES-256-GCM fails closed when ciphertext is modified", async () => {
    const provider = SecretProvider.makeAes256Gcm(randomBytes(32))
    const ciphertext = await Effect.runPromise(provider.protect(Buffer.from("secret")))
    const bytes = Buffer.from(ciphertext, "base64")
    bytes[bytes.length - 1] ^= 1

    const exit = await Effect.runPromiseExit(provider.unprotect(bytes.toString("base64")))
    expect(Exit.isFailure(exit)).toBe(true)
    expect(String(exit)).toContain("SecretProvider.Error")
  })
})
