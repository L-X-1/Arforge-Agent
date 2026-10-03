import { describe, expect } from "bun:test"
import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { Effect } from "effect"
import path from "node:path"
import { writeFile } from "node:fs/promises"
import { Auth } from "../../src/auth"
import { testEffect } from "../lib/effect"
import { Global } from "@arforge-ai/core/global"

const it = testEffect(LayerNode.compile(Auth.node))

describe("Auth", () => {
  it.instance("set normalizes trailing slashes in keys", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* auth.set("https://example.com/", {
        type: "wellknown",
        key: "TOKEN",
        token: "abc",
      })
      const data = yield* auth.all()
      expect(data["https://example.com"]).toBeDefined()
      expect(data["https://example.com/"]).toBeUndefined()
    }),
  )

  it.instance("set cleans up pre-existing trailing-slash entry", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* auth.set("https://example.com/", {
        type: "wellknown",
        key: "TOKEN",
        token: "old",
      })
      yield* auth.set("https://example.com", {
        type: "wellknown",
        key: "TOKEN",
        token: "new",
      })
      const data = yield* auth.all()
      const keys = Object.keys(data).filter((key) => key.includes("example.com"))
      expect(keys).toEqual(["https://example.com"])
      const entry = data["https://example.com"]!
      expect(entry.type).toBe("wellknown")
      if (entry.type === "wellknown") expect(entry.token).toBe("new")
    }),
  )

  it.instance("remove deletes both trailing-slash and normalized keys", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* auth.set("https://example.com", {
        type: "wellknown",
        key: "TOKEN",
        token: "abc",
      })
      yield* auth.remove("https://example.com/")
      const data = yield* auth.all()
      expect(data["https://example.com"]).toBeUndefined()
      expect(data["https://example.com/"]).toBeUndefined()
    }),
  )

  it.instance("set and remove are no-ops on keys without trailing slashes", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* auth.set("anthropic", {
        type: "api",
        key: "sk-test",
      })
      const data = yield* auth.all()
      expect(data["anthropic"]).toBeDefined()
      yield* auth.remove("anthropic")
      const after = yield* auth.all()
      expect(after["anthropic"]).toBeUndefined()
    }),
  )

  it.instance("stores provider credentials in a protected envelope instead of plaintext JSON", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* auth.set("protected-provider", { type: "api", key: "sk-never-write-this-plaintext" })

      const raw = yield* Effect.promise(() => Bun.file(path.join(Global.Path.data, "auth.json")).text())
      const envelope = JSON.parse(raw) as Record<string, unknown>
      expect(raw).not.toContain("sk-never-write-this-plaintext")
      expect(envelope.kind).toBe("arforge-protected-json")
      expect(envelope.schema_version).toBe(1)
      expect(String(envelope.provider)).toMatch(/windows-dpapi-current-user|aes-256-gcm|test-ephemeral/)
    }),
  )

  it.instance("migrates a legacy plaintext auth file after a successful read", () =>
    Effect.gen(function* () {
      const target = path.join(Global.Path.data, "auth.json")
      yield* Effect.promise(() =>
        writeFile(target, JSON.stringify({ legacy: { type: "api", key: "legacy-plaintext-secret" } }), "utf8"),
      )
      const auth = yield* Auth.Service
      const entry = yield* auth.get("legacy")
      expect(entry).toMatchObject({ type: "api", key: "legacy-plaintext-secret" })

      const migrated = yield* Effect.promise(() => Bun.file(target).text())
      expect(migrated).not.toContain("legacy-plaintext-secret")
      expect(JSON.parse(migrated)).toMatchObject({ kind: "arforge-protected-json", schema_version: 1 })
    }),
  )
})
