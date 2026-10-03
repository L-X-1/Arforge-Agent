export * as SkillV2 from "./skill"

import { makeLocationNode } from "./effect/app-node"
import path from "path"
import { Context, Effect, Layer, Schema, Types } from "effect"
import { Skill } from "@arforge-ai/schema/skill"
import { AgentV2 } from "./agent"
import { ConfigMarkdown } from "./config/markdown"
import { FSUtil } from "./fs-util"
import { PermissionV2 } from "./permission"
import { AbsolutePath } from "./schema"
import { SkillDiscovery } from "./skill/discovery"
import { State } from "./state"
import { canonicalHash } from "./util/canonical-hash"

export const DirectorySource = Skill.DirectorySource
export type DirectorySource = Skill.DirectorySource

export const UrlSource = Skill.UrlSource
export type UrlSource = Skill.UrlSource

export const EmbeddedSource = Skill.EmbeddedSource
export type EmbeddedSource = Skill.EmbeddedSource

export const Source = Skill.Source
export type Source = typeof Source.Type

export const Info = Skill.Info
export type Info = Skill.Info

/** The materialized skill view used by one turn. */
export interface SnapshotSource {
  readonly type: Source["type"]
  readonly locator: string
}

export interface Snapshot {
  readonly revision: number
  readonly digest: string
  readonly sources: ReadonlyArray<SnapshotSource>
  readonly skills: ReadonlyArray<Info>
}

export const available = (skills: ReadonlyArray<Info>, agent: AgentV2.Info) =>
  skills.filter((skill) => PermissionV2.evaluate("skill", skill.name, agent.permissions).effect !== "deny")

const Frontmatter = Schema.Struct({
  name: Schema.String.pipe(Schema.optional),
  description: Schema.String.pipe(Schema.optional),
  slash: Schema.Boolean.pipe(Schema.optional),
})
const decodeFrontmatter = Schema.decodeUnknownOption(Frontmatter)

const freezeInfo = (info: Info): Info => Object.freeze({ ...info })

const sourceLocator = (source: Source): SnapshotSource => {
  if (source.type === "embedded") return Object.freeze({ type: source.type, locator: `embedded:${source.skill.name}` })
  if (source.type === "directory") return Object.freeze({ type: source.type, locator: String(source.path) })
  try {
    const url = new URL(source.url)
    // A URL may contain credentials or query parameters used for
    // authentication. They must not be exposed in provenance/snapshots.
    return Object.freeze({ type: source.type, locator: `${url.origin}${url.pathname}` })
  } catch {
    return Object.freeze({ type: source.type, locator: "invalid-url" })
  }
}

const sourceIdentity = (source: Source) =>
  source.type === "embedded"
    ? { type: source.type, name: source.skill.name, content: source.skill.content }
    : source.type === "directory"
      ? { type: source.type, path: String(source.path) }
      : { type: source.type, url: source.url }

/**
 * Resolve source precedence in one place. Sources are applied in registration
 * order and later sources replace an earlier same-named skill while retaining
 * the first insertion position for deterministic prompt ordering.
 */
export const resolveVisible = (entries: ReadonlyArray<ReadonlyArray<Info>>): Info[] => {
  const visible = new Map<string, Info>()
  for (const skills of entries) {
    for (const skill of skills) visible.set(skill.name, freezeInfo(skill))
  }
  return [...visible.values()]
}

export type Data = {
  sources: Types.DeepMutable<Source>[]
}

export type Draft = {
  source: (source: Source) => void
  list: () => readonly Source[]
}

export interface Interface extends State.Transformable<Draft> {
  readonly sources: () => Effect.Effect<Source[]>
  readonly list: () => Effect.Effect<Info[]>
  readonly snapshot: () => Effect.Effect<Snapshot>
}

export class Service extends Context.Service<Service, Interface>()("@arforge/v2/Skill") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const discovery = yield* SkillDiscovery.Service
    const fs = yield* FSUtil.Service

    const state = State.create<Data, Draft>({
      initial: () => ({ sources: [] }),
      draft: (draft) => ({
        source: (source) => {
          if (draft.sources.some((item) => Source.equals(item, source))) return
          draft.sources.push(source as Types.DeepMutable<Source>)
        },
        list: () => draft.sources as Source[],
      }),
    })

    const load = Effect.fn("SkillV2.load")(function* (source: Source) {
      const skills: Info[] = []
      if (source.type === "embedded") return [source.skill]
      const directories = source.type === "directory" ? [source.path] : yield* discovery.pull(source.url)
      for (const directory of directories) {
        const files = yield* fs
          .glob("{*.md,**/SKILL.md}", { cwd: directory, absolute: true, include: "file", symlink: true, dot: true })
          .pipe(Effect.catch(() => Effect.succeed([] as string[])))
        for (const filepath of files.toSorted()) {
          const content = yield* fs.readFileStringSafe(filepath).pipe(Effect.catch(() => Effect.succeed(undefined)))
          if (!content) continue
          const markdown = ConfigMarkdown.parseOption(content)
          if (!markdown) continue
          const frontmatter = decodeFrontmatter(markdown.data).valueOrUndefined
          if (!frontmatter) continue
          const name =
            frontmatter.name !== undefined
              ? frontmatter.name
              : path.dirname(filepath) === directory
                ? path.basename(filepath, ".md")
                : undefined
          if (!name) continue
          skills.push({
            name,
            description: frontmatter.description,
            slash: frontmatter.slash,
            location: AbsolutePath.make(filepath),
            content: markdown.content,
          })
        }
      }
      return Object.freeze(skills.map(freezeInfo))
    })

    // A source cache is only valid for the materialized State revision. A
    // reload must clear it before the next turn can observe a skill; otherwise
    // edits to a directory or a refreshed URL remain invisible indefinitely.
    const cache = new Map<string, ReadonlyArray<Info>>()
    let revision = 0
    let sourceSignature: string | undefined
    const invalidate = Effect.sync(() => {
      cache.clear()
      sourceSignature = undefined
      revision += 1
    })
    const syncSourceSignature = () => {
      const signature = state
        .get()
        .sources.map((source) => Source.key(source))
        .join("\u0000")
      if (signature === sourceSignature) return
      cache.clear()
      sourceSignature = signature
      revision += 1
    }
    const list = Effect.fn("SkillV2.list")(function* () {
      syncSourceSignature()
      const loadedEntries: Array<ReadonlyArray<Info>> = []
      for (const source of state.get().sources) {
        const key = Source.key(source)
        const loaded = cache.get(key) ?? (yield* load(source))
        cache.set(key, loaded)
        loadedEntries.push(loaded)
      }
      return resolveVisible(loadedEntries)
    })

    const reload = Effect.fn("SkillV2.reload")(function* () {
      yield* state.reload()
      yield* invalidate
    })

    const transform = Effect.fn("SkillV2.transform")(function* (update: (draft: Draft) => Effect.Effect<void> | void) {
      const registration = yield* state.transform(update)
      yield* invalidate
      let active = true
      return {
        dispose: Effect.ensuring(
          registration.dispose,
          Effect.sync(() => {
            if (!active) return
            active = false
            cache.clear()
            sourceSignature = undefined
            revision += 1
          }),
        ),
      }
    })

    const snapshot = Effect.fn("SkillV2.snapshot")(function* () {
      const skills = Object.freeze([...(yield* list())].map(freezeInfo))
      const sources = Object.freeze(state.get().sources.map(sourceLocator))
      const identity = {
        sources: state.get().sources.map(sourceIdentity),
        skills: skills.map((skill) => ({
          name: skill.name,
          description: skill.description,
          slash: skill.slash,
          location: String(skill.location),
          content: skill.content,
        })),
      }
      const digest = canonicalHash(identity)
      if (!digest) return yield* Effect.die(new Error("skill snapshot is not canonicalizable"))
      return Object.freeze({ revision, digest, sources, skills })
    })

    return Service.of({
      transform,
      reload,
      sources: Effect.fn("SkillV2.sources")(function* () {
        return [...state.get().sources]
      }),
      list,
      snapshot,
    })
  }),
)

export const node = makeLocationNode({ service: Service, layer, deps: [SkillDiscovery.node, FSUtil.node] })
