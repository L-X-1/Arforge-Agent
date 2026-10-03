import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AgentV2 } from "@arforge-ai/core/agent"
import { AppNodeBuilder } from "@arforge-ai/core/effect/app-node-builder"
import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { AbsolutePath } from "@arforge-ai/core/schema"
import { SkillV2 } from "@arforge-ai/core/skill"
import { SkillDiscovery } from "@arforge-ai/core/skill/discovery"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const urls = new Map<string, AbsolutePath[]>()
let pulls = 0
const discovery = Layer.succeed(
  SkillDiscovery.Service,
  SkillDiscovery.Service.of({
    pull: (url) => {
      pulls++
      return Effect.succeed(urls.get(url) ?? [])
    },
  }),
)
const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([SkillV2.node, AgentV2.node]), [[SkillDiscovery.node, discovery]]),
)

function write(directory: string, name: string, description: string) {
  return fs.writeFile(
    path.join(directory, name, "SKILL.md"),
    `---
name: ${name}
description: ${description}
---
# ${name}`,
  )
}

describe("SkillV2", () => {
  it.effect("resolves later sources once and freezes the visible projection", () =>
    Effect.sync(() => {
      const first = SkillV2.Info.make({
        name: "same",
        description: "first",
        location: AbsolutePath.make(path.resolve("/skills/first/SKILL.md")),
        content: "first",
      })
      const second = SkillV2.Info.make({
        name: "same",
        description: "second",
        location: AbsolutePath.make(path.resolve("/skills/second/SKILL.md")),
        content: "second",
      })
      const visible = SkillV2.resolveVisible([[first], [second]])
      expect(visible).toHaveLength(1)
      expect(visible[0]).toMatchObject({ description: "second", content: "second" })
      expect(Object.isFrozen(visible[0])).toBe(true)
    }),
  )

  it.live("registers sources and resolves later source precedence", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const first = path.join(tmp.path, "first")
          const second = path.join(tmp.path, "second")
          yield* Effect.promise(async () => {
            await fs.mkdir(path.join(first, "review"), { recursive: true })
            await fs.mkdir(path.join(second, "review"), { recursive: true })
            await write(first, "review", "First")
            await write(second, "review", "Second")
            await fs.writeFile(path.join(first, "foo.md"), "---\nslash: true\n---\n# foo")
          })

          const skill = yield* SkillV2.Service
          yield* skill.transform((editor) => {
            editor.source({ type: "directory", path: AbsolutePath.make(first) })
            editor.source({ type: "directory", path: AbsolutePath.make(first) })
            editor.source({ type: "directory", path: AbsolutePath.make(second) })
            expect(editor.list()).toEqual([
              { type: "directory", path: AbsolutePath.make(first) },
              { type: "directory", path: AbsolutePath.make(second) },
            ])
          })

          expect(yield* skill.sources()).toEqual([
            { type: "directory", path: AbsolutePath.make(first) },
            { type: "directory", path: AbsolutePath.make(second) },
          ])
          expect(yield* skill.list()).toEqual([
            SkillV2.Info.make({
              name: "foo",
              slash: true,
              location: AbsolutePath.make(path.join(first, "foo.md")),
              content: "# foo",
            }),
            {
              name: "review",
              description: "Second",
              location: AbsolutePath.make(path.join(second, "review", "SKILL.md")),
              content: "# review",
            },
          ])
        }),
      ),
    ),
  )

  it.live("reloads directory content and keeps the previous turn snapshot immutable", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const directory = path.join(tmp.path, "mutable")
          yield* Effect.promise(() => fs.mkdir(path.join(directory, "skill"), { recursive: true }))
          yield* Effect.promise(() => write(directory, "skill", "Before reload"))

          const skill = yield* SkillV2.Service
          yield* skill.transform((draft) =>
            draft.source(
              SkillV2.DirectorySource.make({
                type: "directory",
                path: AbsolutePath.make(directory),
              }),
            ),
          )

          const before = yield* skill.snapshot()
          expect(before.skills.find((item) => item.name === "skill")?.description).toBe("Before reload")
          expect(Object.isFrozen(before)).toBe(true)
          expect(Object.isFrozen(before.skills)).toBe(true)
          expect(Object.isFrozen(before.skills[0])).toBe(true)

          yield* Effect.promise(() => write(directory, "skill", "After reload"))
          expect((yield* skill.list()).find((item) => item.name === "skill")?.description).toBe("Before reload")

          yield* skill.reload()
          const after = yield* skill.snapshot()
          expect(after.skills.find((item) => item.name === "skill")?.description).toBe("After reload")
          expect(after.revision).toBeGreaterThan(before.revision)
          expect(after.digest).not.toBe(before.digest)
          expect(before.skills.find((item) => item.name === "skill")?.description).toBe("Before reload")
        }),
      ),
    ),
  )

  it.live("refreshes URL sources on reload without exposing URL credentials", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const remote = path.join(tmp.path, "remote")
          yield* Effect.promise(() => fs.mkdir(path.join(remote, "deploy"), { recursive: true }))
          yield* Effect.promise(() => write(remote, "deploy", "Remote before"))
          const url = "https://example.test/skills/?token=secret"
          pulls = 0
          urls.set(url, [AbsolutePath.make(remote)])

          const skill = yield* SkillV2.Service
          yield* skill.transform((draft) => draft.source(SkillV2.UrlSource.make({ type: "url", url })))
          expect((yield* skill.list()).find((item) => item.name === "deploy")?.description).toBe("Remote before")
          const before = yield* skill.snapshot()

          yield* Effect.promise(() => write(remote, "deploy", "Remote after"))
          yield* skill.reload()
          const after = yield* skill.snapshot()
          expect((yield* skill.list()).find((item) => item.name === "deploy")?.description).toBe("Remote after")
          expect(pulls).toBe(2)
          expect(after.sources).toEqual([{ type: "url", locator: "https://example.test/skills/" }])
          expect(JSON.stringify(after.sources)).not.toContain("secret")
          expect(after.digest).not.toBe(before.digest)
        }),
      ),
    ),
  )

  it.live("loads URL sources and filters skills for agents", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(async () => {
            await fs.mkdir(path.join(tmp.path, "deploy"), { recursive: true })
            await write(tmp.path, "deploy", "Deploy production")
          })
          pulls = 0
          urls.set("https://example.test/skills/", [AbsolutePath.make(tmp.path)])

          const agents = yield* AgentV2.Service
          yield* agents.transform((editor) =>
            editor.update(AgentV2.ID.make("reviewer"), (agent) => {
              agent.permissions.push({ action: "skill", resource: "deploy", effect: "deny" })
            }),
          )

          const skill = yield* SkillV2.Service
          yield* skill.transform((editor) => editor.source({ type: "url", url: "https://example.test/skills/" }))

          expect((yield* skill.list()).map((item) => item.name)).toEqual(["deploy"])
          expect((yield* skill.list()).map((item) => item.name)).toEqual(["deploy"])
          expect(pulls).toBe(1)
          expect(SkillV2.available(yield* skill.list(), (yield* agents.get(AgentV2.ID.make("reviewer")))!)).toEqual([])
        }),
      ),
    ),
  )
})
