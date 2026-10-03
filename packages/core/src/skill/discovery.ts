export * as SkillDiscovery from "./discovery"

import path from "path"
import { Context, Duration, Effect, Layer, Schedule, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { FSUtil } from "../fs-util"
import { Global } from "../global"
import { makeGlobalNode } from "../effect/app-node"
import { httpClient } from "../effect/app-node-platform"
import { AbsolutePath } from "../schema"
import { collectBoundedResponseBody } from "../tool/http-body"

const skillConcurrency = 4
const fileConcurrency = 8

/**
 * Remote skill indexes are untrusted input. These limits are intentionally
 * kept in the canonical Core owner so every product entry point gets the same
 * bounded behavior through the thin Arforge adapter.
 */
export const limits = {
  indexBytes: 1 * 1024 * 1024,
  maxSkills: 128,
  maxFilesPerSkill: 256,
  maxFileBytes: 4 * 1024 * 1024,
  maxTotalBytes: 32 * 1024 * 1024,
  pullTimeoutMs: 30_000,
} as const

function isSafeSegment(value: string) {
  return (
    value.length > 0 &&
    value !== "." &&
    value !== ".." &&
    !value.includes("/") &&
    !value.includes("\\") &&
    !value.includes("\0")
  )
}

function isSafeRelativePath(value: string) {
  const segments = value.split("/")
  return (
    value.length > 0 &&
    !value.includes("\\") &&
    !value.includes("\0") &&
    !value.includes("?") &&
    !value.includes("#") &&
    !URL.canParse(value) &&
    !path.posix.isAbsolute(value) &&
    !path.win32.isAbsolute(value) &&
    segments.every((segment) => {
      try {
        const decoded = decodeURIComponent(segment)
        return (
          decoded.length > 0 &&
          decoded !== "." &&
          decoded !== ".." &&
          !decoded.includes("/") &&
          !decoded.includes("\\") &&
          !decoded.includes("\0")
        )
      } catch {
        return false
      }
    })
  )
}

class IndexSkill extends Schema.Class<IndexSkill>("SkillDiscovery.IndexSkill")({
  name: Schema.String,
  version: Schema.optional(Schema.String),
  files: Schema.Array(Schema.String),
}) {}

class Index extends Schema.Class<Index>("SkillDiscovery.Index")({
  skills: Schema.Array(IndexSkill),
}) {}

export interface Interface {
  readonly pull: (url: string) => Effect.Effect<AbsolutePath[]>
}

export class Service extends Context.Service<Service, Interface>()("@arforge/v2/SkillDiscovery") {}

type FileSpec = Readonly<{
  url: string
  file: string
}>

type SkillPlan = Readonly<{
  skill: IndexSkill
  root: string
  versionFile: string
  files: ReadonlyArray<FileSpec>
}>

type PullUsage = {
  bytes: number
}

const hasRequiredSkillFile = (root: string, name: string, fs: FSUtil.Interface) =>
  Effect.gen(function* () {
    return (
      (yield* fs.exists(path.join(root, "SKILL.md")).pipe(Effect.orDie)) ||
      (yield* fs.exists(path.join(root, `${name}.md`)).pipe(Effect.orDie))
    )
  })

const hasCompleteSkill = (plan: SkillPlan, fs: FSUtil.Interface) =>
  Effect.gen(function* () {
    if (!(yield* hasRequiredSkillFile(plan.root, plan.skill.name, fs))) return false
    for (const file of plan.files) {
      if (!(yield* fs.exists(path.resolve(plan.root, file.file)).pipe(Effect.orDie))) return false
    }
    return true
  })

const parseIndex = (body: Buffer) =>
  Effect.try({
    try: () => Schema.decodeUnknownSync(Index)(JSON.parse(body.toString("utf8"))),
    catch: (cause) => cause,
  })

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    const http = (yield* HttpClient.HttpClient).pipe(
      HttpClient.retryTransient({
        retryOn: "errors-and-responses",
        times: 2,
        schedule: Schedule.exponential(200).pipe(Schedule.jittered),
      }),
      HttpClient.filterStatusOk,
    )

    const download = Effect.fn("SkillDiscovery.download")(function* (
      url: string,
      destination: string,
      usage: PullUsage,
    ) {
      return yield* HttpClientRequest.get(url).pipe(
        http.execute,
        Effect.flatMap((response) =>
          collectBoundedResponseBody(
            response,
            limits.maxFileBytes,
            () => new Error(`skill file exceeds ${limits.maxFileBytes} bytes`),
          ),
        ),
        Effect.flatMap((body) => {
          if (usage.bytes + body.byteLength > limits.maxTotalBytes) {
            return Effect.fail(new Error(`skill pull exceeds ${limits.maxTotalBytes} bytes`))
          }
          usage.bytes += body.byteLength
          return fs.writeWithDirs(destination, body)
        }),
        Effect.as(true),
        Effect.catch((error) =>
          Effect.logError("failed to download skill file", { url, error }).pipe(Effect.as(false)),
        ),
      )
    })

    const pull = Effect.fn("SkillDiscovery.pull")(function* (url: string) {
      const base = url.endsWith("/") ? url : `${url}/`
      const source = yield* Effect.try({
        try: () => new URL(base),
        catch: (cause) => cause,
      })
      const index = new URL("index.json", source).href
      const data = yield* HttpClientRequest.get(index).pipe(
        HttpClientRequest.acceptJson,
        http.execute,
        Effect.flatMap((response) =>
          collectBoundedResponseBody(
            response,
            limits.indexBytes,
            () => new Error(`skill index exceeds ${limits.indexBytes} bytes`),
          ),
        ),
        Effect.flatMap(parseIndex),
        Effect.catch((error) =>
          Effect.logError("failed to fetch skill index", { url: index, error }).pipe(Effect.as(undefined)),
        ),
      )
      if (!data || data.skills.length > limits.maxSkills) {
        if (data) yield* Effect.logError("skill index exceeds entry limit", { url: index, limit: limits.maxSkills })
        return []
      }

      const sourceRoot = path.resolve(global.cache, "skills", Bun.hash(base).toString(16))
      const plans: SkillPlan[] = []
      for (const skill of data.skills) {
        if (!isSafeSegment(skill.name)) continue
        if (skill.files.length === 0 || skill.files.length > limits.maxFilesPerSkill) continue
        if (!skill.files.includes("SKILL.md") && !skill.files.includes(`${skill.name}.md`)) continue

        const root = path.resolve(sourceRoot, skill.name)
        if (!FSUtil.contains(sourceRoot, root) || root === sourceRoot) continue

        const skillUrl = new URL(`${encodeURIComponent(skill.name)}/`, source)
        const files = skill.files.map((file): FileSpec | undefined => {
          if (!isSafeRelativePath(file) || file.length > 1024) return undefined
          let resource: URL
          try {
            resource = new URL(file, skillUrl)
          } catch {
            return undefined
          }
          if (resource.origin !== source.origin) return undefined
          const destination = path.resolve(root, file)
          if (!FSUtil.contains(root, destination) || destination === root) return undefined
          return { url: resource.href, file }
        })
        if (files.some((file) => file === undefined)) continue
        plans.push({ skill, root, versionFile: path.join(root, ".arforge-version"), files: files as FileSpec[] })
      }

      const usage: PullUsage = { bytes: 0 }
      return yield* Effect.forEach(
        plans,
        (plan) =>
          Effect.gen(function* () {
            const current = yield* fs
              .readFileStringSafe(plan.versionFile)
              .pipe(Effect.catch(() => Effect.succeed(undefined)))
            const cached = yield* hasCompleteSkill(plan, fs)
            const needsRefresh = !cached || plan.skill.version !== current
            if (needsRefresh) {
              const token = crypto.randomUUID()
              const staging = `${plan.root}.tmp-${token}`
              const backup = `${plan.root}.old-${token}`
              yield* Effect.gen(function* () {
                const downloaded = yield* Effect.forEach(
                  plan.files,
                  (file) => download(file.url, path.resolve(staging, file.file), usage),
                  { concurrency: fileConcurrency },
                )
                if (!downloaded.every(Boolean) || !(yield* hasCompleteSkill({ ...plan, root: staging }, fs))) return
                if (plan.skill.version !== undefined) {
                  yield* fs.writeFileString(path.join(staging, ".arforge-version"), plan.skill.version)
                }
                yield* Effect.uninterruptible(
                  Effect.gen(function* () {
                    const hadCached = yield* fs.exists(plan.root).pipe(Effect.orDie)
                    if (hadCached) yield* fs.rename(plan.root, backup)
                    yield* fs.rename(staging, plan.root).pipe(
                      Effect.catch((error) =>
                        Effect.gen(function* () {
                          if (hadCached) yield* fs.rename(backup, plan.root).pipe(Effect.ignore)
                          return yield* Effect.fail(error)
                        }),
                      ),
                    )
                    if (hadCached) yield* fs.remove(backup, { recursive: true, force: true }).pipe(Effect.ignore)
                  }),
                )
              }).pipe(
                Effect.catch((error) => Effect.logError("failed to refresh skill", { skill: plan.skill.name, error })),
                Effect.ensuring(fs.remove(staging, { recursive: true, force: true }).pipe(Effect.ignore)),
              )
            }
            // A failed refresh must keep an already published skill visible.
            // The old revision may not contain a newly advertised file, but
            // it is still a complete, previously validated revision and is
            // safer than returning a half-written staging tree.
            return (yield* hasRequiredSkillFile(plan.root, plan.skill.name, fs)) ? [AbsolutePath.make(plan.root)] : []
          }),
        { concurrency: skillConcurrency },
      ).pipe(Effect.map((directories) => directories.flat()))
    })

    return Service.of({
      pull: (url: string) =>
        pull(url).pipe(
          Effect.catch((error) =>
            Effect.logError("skill pull failed", { url, error }).pipe(Effect.as([] as AbsolutePath[])),
          ),
          Effect.timeoutOrElse({
            duration: Duration.millis(limits.pullTimeoutMs),
            orElse: () =>
              Effect.logError("skill pull timed out", { url, timeoutMs: limits.pullTimeoutMs }).pipe(
                Effect.as([] as AbsolutePath[]),
              ),
          }),
        ),
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [httpClient, FSUtil.node, Global.node] })
