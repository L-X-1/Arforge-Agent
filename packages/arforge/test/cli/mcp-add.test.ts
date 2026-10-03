import { describe, expect } from "bun:test"
import { Effect } from "effect"
import path from "path"
import fs from "node:fs/promises"
import { parse, modify, applyEdits } from "jsonc-parser"
import { cliIt } from "../lib/cli-process"
import { Config } from "@arforge-ai/core/config"

const profileConfig = (home: string) => path.join(home, "config", "arforge.jsonc")

describe("arforge mcp add (non-interactive subprocess)", () => {
  cliIt.concurrent(
    "replacing a server endpoint does not retain the previous endpoint credentials",
    ({ home, arforge }) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => fs.mkdir(path.join(home, "config"), { recursive: true }))
        yield* Effect.promise(() =>
          Bun.write(
            profileConfig(home),
            JSON.stringify({
              mcp: {
                servers: {
                  original: {
                    type: "remote",
                    url: "https://old.invalid/mcp",
                    headers: { Authorization: "fixture-old-header" },
                    oauth: { client_secret: "fixture-old-secret" },
                  },
                },
              },
            }),
          ),
        )
        const result = yield* arforge.spawn(["mcp", "add", "original", "--url", "https://new.invalid/mcp"])
        arforge.expectExit(result, 0)
        expect(yield* Effect.promise(() => Bun.file(profileConfig(home)).json())).toMatchObject({
          mcp: { servers: { original: { type: "remote", url: "https://new.invalid/mcp" } } },
        })
        const text = yield* Effect.promise(() => Bun.file(profileConfig(home)).text())
        expect(text).not.toContain("fixture-old-header")
        expect(text).not.toContain("fixture-old-secret")
      }),
    60_000,
  )

  cliIt.concurrent(
    "preserves the higher-priority JSONC document and the original supervisor reads the saved server",
    ({ home, arforge }) =>
      Effect.gen(function* () {
        const directory = path.join(home, "config")
        yield* Effect.promise(() => fs.mkdir(directory, { recursive: true }))
        const lower = path.join(directory, "arforge.json")
        const lowerText = '{"username":"lower-priority"}'
        yield* Effect.promise(() => Bun.write(lower, lowerText))
        yield* Effect.promise(() =>
          Bun.write(
            profileConfig(home),
            '// keep this comment\n{"username":"preserved","mcp":{"servers":{"disabled-fixture":{"disabled":true}}}}',
          ),
        )
        const added = yield* arforge.spawn(["mcp", "add", "disabled-fixture", "--url", "https://fixture.invalid/mcp"])
        arforge.expectExit(added, 0)
        const text = yield* Effect.promise(() => Bun.file(profileConfig(home)).text())
        expect(text).toContain("// keep this comment")
        expect(parse(text)).toMatchObject({
          username: "preserved",
          mcp: {
            servers: { "disabled-fixture": { type: "remote", url: "https://fixture.invalid/mcp" } },
          },
        })
        expect(yield* Effect.promise(() => Bun.file(lower).text())).toBe(lowerText)
        // Exercise real supervisor loading without contacting a remote host.
        // This fixture-only edit disables the server just created by the CLI.
        yield* Effect.promise(() =>
          Bun.write(
            profileConfig(home),
            applyEdits(text, modify(text, ["mcp", "servers", "disabled-fixture", "disabled"], true, {})),
          ),
        )
        const listed = yield* arforge.spawn(["mcp", "list"])
        arforge.expectExit(listed, 0)
        expect(listed.stdout + listed.stderr).toContain("disabled-fixture")
        expect(listed.stdout + listed.stderr).toContain("disabled")
      }),
    60_000,
  )

  cliIt.concurrent(
    "saves to ARFORGE_CONFIG_DIR and retains both concurrent CLI additions",
    ({ home, arforge }) =>
      Effect.gen(function* () {
        const directory = path.join(home, "chosen-profile")
        const results = yield* Effect.all(
          ["first", "second"].map((name) =>
            arforge.spawn(["mcp", "add", name, "--url", `https://${name}.invalid/mcp`], {
              env: { ARFORGE_CONFIG_DIR: directory },
            }),
          ),
          { concurrency: "unbounded" },
        )
        for (const result of results) arforge.expectExit(result, 0)
        const file = path.join(directory, "arforge.jsonc")
        expect(yield* Effect.promise(() => Bun.file(file).json())).toMatchObject({
          mcp: {
            servers: {
              first: { type: "remote", url: "https://first.invalid/mcp" },
              second: { type: "remote", url: "https://second.invalid/mcp" },
            },
          },
        })
        expect(yield* Effect.promise(() => Bun.file(profileConfig(home)).exists())).toBe(false)
      }),
    60_000,
  )

  cliIt.concurrent(
    "rejects malformed saved configuration without changing or echoing its contents",
    ({ home, arforge }) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => fs.mkdir(path.join(home, "config"), { recursive: true }))
        const contents = '{ "private": "fixture-do-not-echo" '
        yield* Effect.promise(() => Bun.write(profileConfig(home), contents))
        const result = yield* arforge.spawn(["mcp", "add", "new", "--url", "https://fixture.invalid/mcp"])
        expect(result.exitCode).not.toBe(0)
        expect(yield* Effect.promise(() => Bun.file(profileConfig(home)).text())).toBe(contents)
        expect(result.stdout + result.stderr).not.toContain("fixture-do-not-echo")
      }),
    60_000,
  )

  cliIt.concurrent(
    "invalid non-interactive inputs do not disclose supplied values or create configuration",
    ({ home, arforge }) =>
      Effect.gen(function* () {
        for (const args of [
          ["mcp", "add", "new", "--url", "file:///fixture-do-not-echo"],
          ["mcp", "add", "new", "--url", "https://fixture.invalid", "--header", "fixture-do-not-echo"],
          ["mcp", "add", "new", "--url", "https://fixture.invalid", "--read-only-path", "fixture-do-not-echo"],
          ["mcp", "add", "new", "--read-only-path", "", "--", "fixture-command"],
          ["mcp", "add", "new", "--startup-timeout", "0", "--", "fixture-command"],
          ["mcp", "add", "new", "--request-timeout", "fixture-do-not-echo", "--", "fixture-command"],
        ]) {
          const result = yield* arforge.spawn(args)
          expect(result.exitCode).not.toBe(0)
          expect(result.stdout + result.stderr).not.toContain("fixture-do-not-echo")
          expect(yield* Effect.promise(() => Bun.file(profileConfig(home)).exists())).toBe(false)
        }
      }),
    60_000,
  )
  cliIt.concurrent(
    "adds a remote server with HTTP headers",
    ({ home, arforge }) =>
      Effect.gen(function* () {
        const result = yield* arforge.spawn([
          "mcp",
          "add",
          "github",
          "--url",
          "https://example.com/mcp",
          "--startup-timeout",
          "12000",
          "--request-timeout",
          "2500",
          "--header",
          "Authorization=Bearer {env:GITHUB_TOKEN}",
          "--header",
          "X-Option=one=two",
        ])
        arforge.expectExit(result, 0)

        const config = yield* Effect.promise(() => Bun.file(profileConfig(home)).json())
        expect(config.mcp.servers.github).toEqual({
          type: "remote",
          url: "https://example.com/mcp",
          timeout: { startup: 12000, request: 2500 },
          headers: {
            Authorization: "Bearer {env:GITHUB_TOKEN}",
            "X-Option": "one=two",
          },
        })
        const documents = Config.decodeDocument(JSON.stringify(config))
        expect(documents.at(-1)?.info.mcp?.servers?.github).toMatchObject({
          type: "remote",
          url: "https://example.com/mcp",
        })
      }),
    60_000,
  )

  cliIt.concurrent(
    "adds a local server while preserving argv and environment values",
    ({ home, arforge }) =>
      Effect.gen(function* () {
        const result = yield* arforge.spawn([
          "mcp",
          "add",
          "local",
          "--env",
          "API_KEY=secret",
          "--env",
          "VALUE=one=two",
          "--read-only-path",
          "../dependency 两个词",
          "--read-only-path",
          "./vendor",
          "--startup-timeout",
          "9000",
          "--request-timeout",
          "1500",
          "--",
          "npx",
          "-y",
          "@example/server",
          "--label",
          "two words",
        ])
        arforge.expectExit(result, 0)

        const config = yield* Effect.promise(() => Bun.file(profileConfig(home)).json())
        expect(config.mcp.servers.local).toEqual({
          type: "local",
          command: ["npx", "-y", "@example/server", "--label", "two words"],
          environment: {
            API_KEY: "secret",
            VALUE: "one=two",
          },
          read_only_paths: ["../dependency 两个词", "./vendor"],
          timeout: { startup: 9000, request: 1500 },
        })
      }),
    60_000,
  )
})
