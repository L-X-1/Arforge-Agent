import { expect, test } from "bun:test"
import { $ } from "bun"
import { AppNodeBuilder } from "@arforge-ai/core/effect/app-node-builder"
import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@arforge-ai/core/cross-spawn-spawner"
import { Database } from "@arforge-ai/core/database/database"
import { EventSequenceTable } from "@arforge-ai/core/event/sql"
import { Global } from "@arforge-ai/core/global"
import { ProjectV2 } from "@arforge-ai/core/project"
import { ProjectTable } from "@arforge-ai/core/project/sql"
import { AbsolutePath } from "@arforge-ai/core/schema"
import { MessageTable, PartTable, SessionTable } from "@arforge-ai/core/session/sql"
import { Hash } from "@arforge-ai/core/util/hash"
import { SessionV1 } from "@arforge-ai/core/v1/session"
import { eq } from "drizzle-orm"
import { Effect, Layer, Schema } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { createHash } from "node:crypto"
import * as fs from "node:fs/promises"
import path from "node:path"
import { InstanceRef } from "@/effect/instance-ref"
import type { InstanceContext } from "@/project/instance-context"
import { Session } from "@/session/session"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { READ_ONLY_GIT_SUBCOMMANDS, Service, node } from "@/session/revert-readonly-local"
import { SessionRevertSnapshot } from "@/session/revert-snapshot"
import { tmpdir } from "../fixture/fixture"

function sha256(input: Buffer | string) {
  return createHash("sha256").update(input).digest("hex")
}

async function treeFingerprint(root: string) {
  const rows: string[] = []
  async function visit(directory: string) {
    const entries = await fs.readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      const file = path.join(directory, entry.name)
      const relative = path.relative(root, file).split(path.sep).join("/")
      const stat = await fs.lstat(file)
      if (entry.isDirectory()) {
        rows.push(`d\0${relative}\0${stat.mode}\0${stat.mtimeMs}`)
        await visit(file)
        continue
      }
      rows.push(`f\0${relative}\0${stat.mode}\0${stat.size}\0${stat.mtimeMs}\0${sha256(await fs.readFile(file))}`)
    }
  }
  await visit(root)
  return sha256(rows.join("\0"))
}

function omitMessageIdentity(input: SessionV1.Info) {
  const { id: _id, sessionID: _sessionID, ...data } = input
  return data
}

function omitPartIdentity(input: SessionV1.Part) {
  const { id: _id, sessionID: _sessionID, messageID: _messageID, ...data } = input
  return data
}

test("local inspector captures a real clean repository and does not write DB, Git, snapshot, or filesystem state", async () => {
  await using project = await tmpdir({ git: true })
  await using snapshotWorktree = await tmpdir()
  const projectID = ProjectV2.ID.make(`project_readonly_${Math.random().toString(36).slice(2)}`)
  const sessionID = SessionID.descending("ses_readonly_local_integration")
  const boundaryMessageID = MessageID.make("msg_readonly_local_boundary")
  const patchMessageID = MessageID.make("msg_readonly_local_patch")
  const textPartID = PartID.make("prt_readonly_local_text")
  const patchPartID = PartID.make("prt_readonly_local_patch")
  const unmanagedFile = path.join(project.path, ".arforge", "plugins", "local-only", "plugin.json")
  const file = path.join(project.path, "src", "file.txt")
  const snapshotGitDir = path.join(Global.Path.data, "snapshot", projectID, Hash.fast(project.path))
  const snapshotProjectDir = path.dirname(snapshotGitDir)

  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, "old\n")
  await $`git add -- src/file.txt`.cwd(project.path).quiet()
  await $`git commit -m source`.cwd(project.path).quiet()

  await fs.mkdir(path.dirname(snapshotGitDir), { recursive: true })
  await $`git init --separate-git-dir ${snapshotGitDir} ${snapshotWorktree.path}`.quiet()
  await fs.mkdir(path.join(snapshotWorktree.path, "src"), { recursive: true })
  await fs.writeFile(path.join(snapshotWorktree.path, "src", "file.txt"), "target\n")
  await $`git add -- src/file.txt`.cwd(snapshotWorktree.path).quiet()
  const targetTree = (await $`git write-tree`.cwd(snapshotWorktree.path).quiet()).text().trim()

  const commands: ReadonlyArray<string>[] = []
  const recordingSpawner = Layer.effect(
    ChildProcessSpawner.ChildProcessSpawner,
    Effect.gen(function* () {
      const real = yield* ChildProcessSpawner.ChildProcessSpawner
      return ChildProcessSpawner.make(
        Effect.fnUntraced(function* (command) {
          if (ChildProcess.isStandardCommand(command) && command.command === "git") commands.push([...command.args])
          return yield* real.spawn(command)
        }),
      )
    }),
  ).pipe(Layer.provide(AppNodeBuilder.build(CrossSpawnSpawner.node)))
  const database = Database.layerFromPath(":memory:")
  const runtime = LayerNode.compile(LayerNode.group([node, Database.node]), [
    [Database.node, database],
    [CrossSpawnSpawner.node, recordingSpawner],
  ])

  const now = Date.now()
  const context: InstanceContext = {
    directory: project.path,
    worktree: project.path,
    project: {
      id: projectID,
      worktree: project.path,
      vcs: "git",
      time: { created: now, updated: now },
      sandboxes: [],
    },
  }
  const user = structuredClone(
    Schema.decodeUnknownSync(SessionV1.Info)({
      id: boundaryMessageID,
      sessionID,
      role: "user" as const,
      time: { created: now + 1 },
      agent: "build",
      model: { providerID: "test", modelID: "test" },
    }),
  ) as SessionV1.User
  const later = structuredClone(
    Schema.decodeUnknownSync(SessionV1.Info)({
      ...user,
      id: patchMessageID,
      time: { created: now + 2 },
    }),
  ) as SessionV1.User
  const textPart = structuredClone(
    Schema.decodeUnknownSync(SessionV1.Part)({
      id: textPartID,
      sessionID,
      messageID: boundaryMessageID,
      type: "text" as const,
      text: "boundary",
    }),
  ) as SessionV1.TextPart
  const patchPart = structuredClone(
    Schema.decodeUnknownSync(SessionV1.Part)({
      id: patchPartID,
      sessionID,
      messageID: patchMessageID,
      type: "patch" as const,
      hash: targetTree,
      files: [file.replaceAll("\\", "/")],
    }),
  ) as SessionV1.PatchPart

  try {
    const captured = await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        const projectRow: typeof ProjectTable.$inferInsert = {
          id: projectID,
          worktree: AbsolutePath.make(project.path),
          vcs: "git",
          sandboxes: [],
          time_created: now,
          time_updated: now,
        }
        yield* db.insert(ProjectTable).values(projectRow).run()
        const info: Session.Info = {
          id: sessionID,
          slug: "readonly-local",
          projectID,
          directory: project.path,
          title: "read-only local inspector",
          version: "test",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: now, updated: now },
        }
        yield* db.insert(SessionTable).values(Session.toRow(info)).run()
        yield* db
          .insert(MessageTable)
          .values([
            {
              id: user.id,
              session_id: sessionID,
              time_created: user.time.created,
              time_updated: user.time.created,
              data: omitMessageIdentity(user),
            },
            {
              id: later.id,
              session_id: sessionID,
              time_created: later.time.created,
              time_updated: later.time.created,
              data: omitMessageIdentity(later),
            },
          ])
          .run()
        yield* db
          .insert(PartTable)
          .values([
            {
              id: textPart.id,
              session_id: sessionID,
              message_id: textPart.messageID,
              time_created: now + 1,
              time_updated: now + 1,
              data: omitPartIdentity(textPart),
            },
            {
              id: patchPart.id,
              session_id: sessionID,
              message_id: patchPart.messageID,
              time_created: now + 2,
              time_updated: now + 2,
              data: omitPartIdentity(patchPart),
            },
          ])
          .run()
        yield* db.insert(EventSequenceTable).values({ aggregate_id: sessionID, seq: 8 }).run()

        const indexBefore = yield* Effect.promise(() => fs.readFile(path.join(project.path, ".git", "index")))
        const worktreeBefore = yield* Effect.promise(() => treeFingerprint(project.path))
        const snapshotBefore = yield* Effect.promise(() => treeFingerprint(snapshotGitDir))
        const eventBefore = yield* db
          .select({ seq: EventSequenceTable.seq })
          .from(EventSequenceTable)
          .where(eq(EventSequenceTable.aggregate_id, sessionID))
          .get()

        const inspector = yield* Service
        const result = yield* inspector.capture({
          requestID: "cpr_readonly_local_0001",
          kind: "revert",
          sessionID,
          messageID: boundaryMessageID,
        })

        const eventAfter = yield* db
          .select({ seq: EventSequenceTable.seq })
          .from(EventSequenceTable)
          .where(eq(EventSequenceTable.aggregate_id, sessionID))
          .get()
        expect(yield* Effect.promise(() => fs.readFile(path.join(project.path, ".git", "index")))).toEqual(indexBefore)
        expect(yield* Effect.promise(() => treeFingerprint(project.path))).toBe(worktreeBefore)
        expect(yield* Effect.promise(() => treeFingerprint(snapshotGitDir))).toBe(snapshotBefore)
        expect(eventAfter).toEqual(eventBefore)
        yield* Effect.promise(() => fs.mkdir(path.dirname(unmanagedFile), { recursive: true }))
        yield* Effect.promise(() => fs.writeFile(unmanagedFile, "{}\n"))
        const historyOnly = yield* inspector.capture({
          requestID: "cpr_readonly_local_0002",
          kind: "revert",
          sessionID,
          messageID: patchMessageID,
        })
        return { snapshot: result, historyOnly }
      }).pipe(Effect.provideService(InstanceRef, context), Effect.provide(runtime), Effect.scoped),
    )

    const snapshot = captured.snapshot
    expect(snapshot.sourceRevision).toEqual({ kind: "commit", id: snapshot.headCommit })
    expect(snapshot.eventHighWaterMark).toBe(8)
    expect(snapshot.files).toHaveLength(1)
    expect(snapshot.files[0]).toMatchObject({
      relativePath: "src/file.txt",
      preimage: { kind: "file", object: "blob", mode: "100644", hash: sha256("old\n"), bytes: 4 },
      current: { kind: "file", object: "blob", mode: "100644", hash: sha256("old\n"), bytes: 4 },
      target: { kind: "file", object: "blob", mode: "100644", hash: sha256("target\n"), bytes: 7 },
    })
    expect(commands.length).toBeGreaterThan(0)
    for (const args of commands) {
      const subcommand = args.find((arg) => (READ_ONLY_GIT_SUBCOMMANDS as readonly string[]).includes(arg))
      expect(subcommand).toBeDefined()
      expect(args).not.toContain("add")
      expect(args).not.toContain("checkout")
      expect(args).not.toContain("read-tree")
      expect(args).not.toContain("write-tree")
    }
    expect(commands.every((args) => args.includes("--no-optional-locks"))).toBe(true)
    expect(captured.historyOnly.files).toEqual([])
    expect(captured.historyOnly.targetRevisions).toEqual([])
    expect(captured.historyOnly.sourceRevision).toEqual({ kind: "commit", id: captured.historyOnly.headCommit })
    expect(captured.historyOnly.dirtyFingerprint).not.toBe(SessionRevertSnapshot.CLEAN_DIRTY_FINGERPRINT)
  } finally {
    await fs.rm(snapshotProjectDir, { recursive: true, force: true }).catch(() => undefined)
  }
})
