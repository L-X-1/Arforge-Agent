import { expect, test } from "bun:test"
import { setTimeout as sleep } from "node:timers/promises"
import { AppNodeBuilder } from "@arforge-ai/core/effect/app-node-builder"
import { FSUtil } from "@arforge-ai/core/fs-util"
import { ProtectedJson } from "@arforge-ai/core/protected-json"
import { SecretProvider } from "@arforge-ai/core/secret-provider"
import { Context, Deferred, Effect, Fiber, Layer } from "effect"
import { McpAuth } from "../../src/mcp/auth"
import { McpAuthReadCache } from "../../src/mcp/auth-read-cache"

function fixture() {
  const crypto = SecretProvider.makeAes256Gcm(new Uint8Array(32).fill(7), "mcp-cache-owned-test")
  let raw: unknown = {}
  let reads = 0
  let decrypts = 0
  let readFailure: "missing" | "read" | undefined
  let decryptFailure = false
  const secrets = SecretProvider.Service.of({
    ...crypto,
    unprotect: (ciphertext) => Effect.suspend(() => {
      decrypts++
      if (decryptFailure) return Effect.fail(new SecretProvider.Error({
        operation: "unprotect", provider: crypto.id, message: "owned decrypt failure",
      }))
      return crypto.unprotect(ciphertext)
    }),
  })
  const fsLayer = Layer.effect(FSUtil.Service, Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    return FSUtil.Service.of({
      ...fs,
      readJson: (file) => file.endsWith("mcp-auth.json") ? Effect.suspend(() => {
        reads++
        if (readFailure === "missing") return fs.readJson(file + ".owned-cache-missing")
        if (readFailure === "read") return Effect.fail(new FSUtil.FileSystemError({
          method: "readJson", cause: new Error("owned read failure"),
        }))
        return Effect.succeed(structuredClone(raw))
      }) : fs.readJson(file),
      writeJson: (file, value, mode) => file.endsWith("mcp-auth.json")
        ? Effect.sync(() => { raw = structuredClone(value) }) : fs.writeJson(file, value, mode),
    })
  })).pipe(Layer.provide(AppNodeBuilder.build(FSUtil.node)))
  const layer = AppNodeBuilder.build(McpAuth.node, [
    [FSUtil.node, fsLayer],
    [SecretProvider.node, Layer.succeed(SecretProvider.Service, secrets)],
  ])
  const open = Effect.gen(function* () {
    const services = yield* Layer.build(layer)
    return Context.get(services, McpAuth.Service)
  })
  const replace = (value: unknown) => Effect.gen(function* () {
    raw = ProtectedJson.Envelope.make({
      schema_version: 1,
      kind: "arforge-protected-json",
      provider: secrets.id,
      ciphertext: yield* crypto.protect(Buffer.from(JSON.stringify(value))),
    })
  })
  return {
    open, replace, secrets,
    raw: () => structuredClone(raw),
    setRaw: (value: unknown) => { raw = structuredClone(value) },
    failRead: (value: typeof readFailure) => { readFailure = value },
    failDecrypt: (value: boolean) => { decryptFailure = value },
    counts: () => ({ reads, decrypts }),
  }
}

test("seven serialized MCP credential reads read disk seven times but decrypt exact ciphertext once", async () => {
  const file = fixture()
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const auth = yield* file.open
    yield* file.replace({ owned: { tokens: { accessToken: "owned-cache-token" }, serverUrl: "http://127.0.0.1/mcp" } })
    for (let index = 0; index < 7; index++) {
      expect((yield* auth.getForUrl("owned", "http://127.0.0.1/mcp"))?.tokens?.accessToken).toBe("owned-cache-token")
    }
    expect(file.counts()).toEqual({ reads: 7, decrypts: 1 })
  })))
})

test("external ciphertext replacement is read immediately and returned Entries cannot poison the cache", async () => {
  const file = fixture()
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const auth = yield* file.open
    yield* file.replace({ owned: { tokens: { accessToken: "first-owned" } } })
    const first = yield* auth.get("owned")
    expect(first?.tokens?.accessToken).toBe("first-owned")
    if (first?.tokens) first.tokens.accessToken = "caller-mutation"
    expect((yield* auth.get("owned"))?.tokens?.accessToken).toBe("first-owned")
    yield* file.replace({ owned: { tokens: { accessToken: "replacement-owned" } } })
    expect((yield* auth.get("owned"))?.tokens?.accessToken).toBe("replacement-owned")
    expect(file.counts()).toEqual({ reads: 3, decrypts: 2 })
  })))
})

test("external NotFound clears the cache even if the same encrypted bytes reappear", async () => {
  const file = fixture()
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const auth = yield* file.open
    yield* file.replace({ owned: { tokens: { accessToken: "owned" } } })
    yield* auth.get("owned")
    file.failRead("missing")
    expect(yield* auth.get("owned")).toBeUndefined()
    file.failRead(undefined)
    expect((yield* auth.get("owned"))?.tokens?.accessToken).toBe("owned")
    expect(file.counts()).toEqual({ reads: 3, decrypts: 2 })
  })))
})

test("read failure and wrong-provider envelope reject without a cached fallback", async () => {
  const file = fixture()
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const auth = yield* file.open
    yield* file.replace({ owned: { tokens: { accessToken: "owned" } } })
    const original = file.raw()
    yield* auth.get("owned")
    file.failRead("read")
    expect((yield* Effect.exit(auth.get("owned")))._tag).toBe("Failure")
    file.failRead(undefined)
    yield* auth.get("owned")
    expect(file.counts().decrypts).toBe(2)
    expect(typeof original).toBe("object")
    file.setRaw({ ...(original as ProtectedJson.Envelope), provider: "wrong-owned-provider" })
    expect((yield* Effect.exit(auth.get("owned")))._tag).toBe("Failure")
    file.setRaw(original)
    yield* auth.get("owned")
    expect(file.counts().decrypts).toBe(3)
  })))
})

test("failed decrypt and invalid decrypted JSON clear prior successful bytes", async () => {
  const file = fixture()
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const auth = yield* file.open
    yield* file.replace({ owned: { tokens: { accessToken: "owned" } } })
    const original = file.raw() as ProtectedJson.Envelope
    yield* auth.get("owned")
    yield* file.replace({ owned: { tokens: { accessToken: "different-owned" } } })
    file.failDecrypt(true)
    expect((yield* Effect.exit(auth.get("owned")))._tag).toBe("Failure")
    file.failDecrypt(false)
    file.setRaw(original)
    yield* auth.get("owned")
    expect(file.counts().decrypts).toBe(3)
    file.setRaw({ ...original, ciphertext: yield* file.secrets.protect(Buffer.from("not-json")) })
    expect((yield* Effect.exit(auth.get("owned")))._tag).toBe("Failure")
    file.setRaw(original)
    yield* auth.get("owned")
    expect(file.counts().decrypts).toBe(5)
  })))
})

test("revoke and external same-byte restoration do not reuse pre-revoke decrypted bytes", async () => {
  const file = fixture()
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const auth = yield* file.open
    yield* file.replace({ owned: { tokens: { accessToken: "owned" } } })
    const original = file.raw()
    yield* auth.get("owned")
    yield* auth.remove("owned")
    expect(yield* auth.get("owned")).toBeUndefined()
    file.setRaw(original)
    expect((yield* auth.get("owned"))?.tokens?.accessToken).toBe("owned")
    expect(file.counts().decrypts).toBe(3)
  })))
})

test("separate McpAuth layers keep separate decrypt caches and writes never seed them", async () => {
  const file = fixture()
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const first = yield* file.open
    const second = yield* file.open
    yield* first.set("owned", { tokens: { accessToken: "owned" } })
    expect(file.counts().decrypts).toBe(0)
    yield* first.get("owned")
    yield* first.get("owned")
    yield* second.get("owned")
    expect(file.counts().decrypts).toBe(2)
  })))
})

function byteProvider() {
  let calls = 0
  const bytes = new Uint8Array([10, 20, 30])
  const base = SecretProvider.makeAes256Gcm(new Uint8Array(32).fill(9))
  return { bytes, calls: () => calls, provider: SecretProvider.Service.of({
    ...base,
    unprotect: () => Effect.sync(() => { calls++; return bytes }),
  }) }
}

test("miss and hit return copies distinct from both the provider buffer and private cached bytes", async () => {
  const source = byteProvider()
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const cache = yield* McpAuthReadCache.make(source.provider)
    const first = yield* cache.provider.unprotect("owned-ciphertext")
    first.fill(0)
    source.bytes.fill(99)
    const hit = yield* cache.provider.unprotect("owned-ciphertext")
    expect([...hit]).toEqual([10, 20, 30])
    hit.fill(1)
    expect([...(yield* cache.provider.unprotect("owned-ciphertext"))]).toEqual([10, 20, 30])
    expect(source.calls()).toBe(1)
    yield* cache.provider.unprotect("different-ciphertext")
    expect(source.calls()).toBe(2)
  })))
})

test("cache expiry is short and does not slide on a hit", async () => {
  const source = byteProvider()
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const cache = yield* McpAuthReadCache.make(source.provider, 100)
    yield* cache.provider.unprotect("owned")
    yield* Effect.promise(() => sleep(60))
    yield* cache.provider.unprotect("owned")
    expect(source.calls()).toBe(1)
    yield* Effect.promise(() => sleep(60))
    yield* cache.provider.unprotect("owned")
    expect(source.calls()).toBe(2)
  })))
})

test("scope termination clears cached bytes and never retains subsequent out-of-scope reads", async () => {
  const source = byteProvider()
  const cache = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const cache = yield* McpAuthReadCache.make(source.provider)
    yield* cache.provider.unprotect("owned")
    yield* cache.provider.unprotect("owned")
    return cache
  })))
  expect(source.calls()).toBe(1)
  await Effect.runPromise(cache.provider.unprotect("owned"))
  await Effect.runPromise(cache.provider.unprotect("owned"))
  expect(source.calls()).toBe(3)
})

test("interrupted native decrypt cannot publish a late successful Promise result", async () => {
  const source = byteProvider()
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const started = yield* Deferred.make<void>()
    let release: ((bytes: Uint8Array) => void) | undefined
    let calls = 0
    const provider = SecretProvider.Service.of({
      ...source.provider,
      unprotect: () => Effect.suspend(() => {
        calls++
        return calls === 1 ? Deferred.succeed(started, undefined).pipe(Effect.andThen(
          Effect.promise(() => new Promise<Uint8Array>((resolve) => { release = resolve })),
        )) : Effect.succeed(new Uint8Array([40, 50]))
      }),
    })
    const cache = yield* McpAuthReadCache.make(provider)
    const pending = yield* cache.provider.unprotect("owned").pipe(Effect.forkChild)
    yield* Deferred.await(started)
    yield* Fiber.interrupt(pending)
    release?.(new Uint8Array([10, 20]))
    yield* Effect.promise(() => Promise.resolve())
    expect([...(yield* cache.provider.unprotect("owned"))]).toEqual([40, 50])
    expect(calls).toBe(2)
  })))
})
