import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { MessageID, PartID, SessionID } from "@/session/schema"
import {
  CaptureError,
  type Reader,
  type RepositoryObservation,
  type SessionObservation,
  make,
} from "@/session/revert-readonly-inspector"
import {
  MAX_FILE_CONTENT_BYTES,
  MAX_OBSERVATION_CONTENT_BYTES,
  READ_ONLY_GIT_SUBCOMMANDS,
  checkContentBudget,
  permitsGitSubcommand,
} from "@/session/revert-readonly-local"
import { SessionRevertSnapshot } from "@/session/revert-snapshot"

const commit = (digit: string) => digit.repeat(40)
const digest = (digit: string) => digit.repeat(64)
const sessionID = SessionID.descending("ses_readonly_revert_inspector")
const messageID = MessageID.make("msg_readonly_boundary")
const partID = PartID.make("prt_readonly_boundary")
const targetRevision = { kind: "snapshot" as const, id: commit("3") }

const root = {
  path: "C:\\Repo",
  realPath: "C:\\Repo",
  device: "1",
  inode: "10",
  type: "directory" as const,
}
const location = {
  path: "C:\\Repo\\src",
  realPath: "C:\\Repo\\src",
  device: "1",
  inode: "11",
  type: "directory" as const,
}

function session(overrides: Partial<SessionObservation> = {}): SessionObservation {
  return {
    kind: "revert",
    sessionID,
    projectID: "project-123",
    projectRoot: root.path,
    location: location.path,
    snapshotGitDir: "C:\\Arforge\\snapshot\\project-123\\store",
    target: { messageID, messageSequence: 7, partID, partIndex: 2 },
    sessionRevision: digest("1"),
    eventHighWaterMark: 42,
    targetRevisions: [targetRevision],
    files: [
      {
        gitPath: "src/file.txt",
        relativePath: "src/file.txt",
        path: "C:\\Repo\\src\\file.txt",
        targetRevision,
      },
    ],
    ...overrides,
  }
}

function repository(overrides: Partial<RepositoryObservation> = {}): RepositoryObservation {
  return {
    projectRootAnchor: root,
    locationAnchor: location,
    sourceRevision: { kind: "commit", id: commit("2") },
    headCommit: commit("2"),
    indexFingerprint: digest("4"),
    dirtyFingerprint: SessionRevertSnapshot.CLEAN_DIRTY_FINGERPRINT,
    files: [
      {
        relativePath: "src/file.txt",
        path: "C:\\Repo\\src\\file.txt",
        parentChain: [root, location],
        leaf: {
          path: "C:\\Repo\\src\\file.txt",
          realPath: "C:\\Repo\\src\\file.txt",
          device: "1",
          inode: "12",
          type: "file",
        },
        preimage: { kind: "file", object: "blob", mode: "100644", hash: digest("5"), bytes: 4 },
        current: { kind: "file", object: "blob", mode: "100644", hash: digest("5"), bytes: 4 },
        target: { kind: "file", object: "blob", mode: "100755", hash: digest("6"), bytes: 8 },
        targetRevision,
      },
    ],
    ...overrides,
  }
}

function request() {
  return {
    requestID: "cpr_readonly_revert_0001",
    kind: "revert" as const,
    sessionID,
    messageID,
    partID,
  }
}

function recordingReader(input?: {
  readonly sessions?: ReadonlyArray<SessionObservation>
  readonly repositories?: ReadonlyArray<RepositoryObservation>
}) {
  const calls: string[] = []
  const writes: string[] = []
  let sessionIndex = 0
  let repositoryIndex = 0
  const sessions = input?.sessions ?? [session(), session(), session()]
  const repositories = input?.repositories ?? [repository(), repository()]
  const reader: Reader & {
    readonly legacySnapshot: {
      readonly track: () => void
      readonly restore: () => void
      readonly revert: () => void
    }
    readonly gitWrite: () => void
    readonly fsWrite: () => void
  } = {
    readSession: () => {
      calls.push("db:transaction:select-session-event-projection")
      return Effect.succeed(structuredClone(sessions[sessionIndex++]!))
    },
    readRepository: () => {
      calls.push("git:rev-parse")
      calls.push("git:ls-files")
      calls.push("git:status")
      calls.push("git:ls-tree")
      calls.push("git:cat-file")
      calls.push("fs:lstat-realpath-open-read-fstat")
      return Effect.succeed(structuredClone(repositories[repositoryIndex++]!))
    },
    legacySnapshot: {
      track: () => writes.push("Snapshot.track"),
      restore: () => writes.push("Snapshot.restore"),
      revert: () => writes.push("Snapshot.revert"),
    },
    gitWrite: () => writes.push("git:write"),
    fsWrite: () => writes.push("fs:write"),
  }
  return { reader, calls, writes }
}

async function failure(service: ReturnType<typeof make>, input: unknown) {
  try {
    await Effect.runPromise(service.capture(input))
  } catch (cause) {
    expect(cause).toBeInstanceOf(CaptureError)
    return cause as CaptureError
  }
  throw new globalThis.Error("capture unexpectedly succeeded")
}

describe("read-only Session revert evidence inspector", () => {
  test("double-reads independent live evidence, seals it, and invokes zero legacy or write operations", async () => {
    const recorded = recordingReader()
    const snapshot = await Effect.runPromise(make(recorded.reader).capture(request()))

    expect(snapshot.sessionRevision).toBe(digest("1"))
    expect(snapshot.eventHighWaterMark).toBe(42)
    expect(snapshot.headCommit).toBe(commit("2"))
    expect(snapshot.files[0]).toMatchObject({
      relativePath: "src/file.txt",
      preimage: { object: "blob", mode: "100644", hash: digest("5") },
      target: { object: "blob", mode: "100755", hash: digest("6") },
    })
    expect(recorded.calls.filter((call) => call.startsWith("db:"))).toHaveLength(3)
    expect(recorded.calls.filter((call) => call === "git:rev-parse")).toHaveLength(2)
    expect(recorded.calls.filter((call) => call.startsWith("fs:"))).toHaveLength(2)
    expect(recorded.writes).toEqual([])
  })

  test("has a closed Git allowlist containing no mutation command", () => {
    expect(READ_ONLY_GIT_SUBCOMMANDS).toEqual(["cat-file", "ls-files", "ls-tree", "rev-parse", "status"])
    for (const command of [
      "add",
      "apply",
      "checkout",
      "clean",
      "commit",
      "hash-object",
      "read-tree",
      "reset",
      "restore",
      "rm",
      "update-index",
      "write-tree",
    ]) {
      expect(permitsGitSubcommand(command)).toBe(false)
    }
  })

  test("fails content budgets closed before unbounded file or aggregate reads", () => {
    const oversized = checkContentBudget(0, MAX_FILE_CONTENT_BYTES + 1, "source")
    expect(oversized).toBeInstanceOf(CaptureError)
    expect((oversized as CaptureError).reason).toBe("resource_limit")

    const aggregate = checkContentBudget(
      MAX_OBSERVATION_CONTENT_BYTES - MAX_FILE_CONTENT_BYTES + 1,
      MAX_FILE_CONTENT_BYTES,
      "target",
    )
    expect(aggregate).toBeInstanceOf(CaptureError)
    expect((aggregate as CaptureError).reason).toBe("resource_limit")
    expect(checkContentBudget(0, MAX_FILE_CONTENT_BYTES, "current")).toBe(MAX_FILE_CONTENT_BYTES)
  })

  test("does not accept a sealed payload as projected live evidence", async () => {
    const first = recordingReader()
    const snapshot = await Effect.runPromise(make(first.reader).capture(request()))
    const neverRead = recordingReader()
    const error = await failure(make(neverRead.reader), snapshot)

    expect(error.reason).toBe("invalid_request")
    expect(neverRead.calls).toEqual([])
    expect(neverRead.writes).toEqual([])
  })

  test("rejects Reader observations for another Session or request target before sealing", async () => {
    const wrongSession = recordingReader({
      sessions: [session({ sessionID: SessionID.descending("ses_wrong") })],
    })
    expect((await failure(make(wrongSession.reader), request())).reason).toBe("evidence_invalid")
    expect(wrongSession.calls.filter((call) => call.startsWith("git:"))).toEqual([])

    const wrongMessage = recordingReader({
      sessions: [
        session({
          target: { ...session().target, messageID: MessageID.make("msg_wrong") },
        }),
      ],
    })
    expect((await failure(make(wrongMessage.reader), request())).reason).toBe("evidence_invalid")

    const wrongPart = recordingReader({
      sessions: [
        session({
          target: { ...session().target, partID: PartID.make("prt_wrong") },
        }),
      ],
    })
    expect((await failure(make(wrongPart.reader), request())).reason).toBe("evidence_invalid")
  })

  test("rejects unrevert target fields before any live read", async () => {
    const recorded = recordingReader()
    const error = await failure(make(recorded.reader), {
      ...request(),
      kind: "unrevert",
    })
    expect(error.reason).toBe("invalid_request")
    expect(recorded.calls).toEqual([])
  })

  test("fails closed with typed reasons for Event and Session drift", async () => {
    const event = recordingReader({
      sessions: [session(), session({ eventHighWaterMark: 43 }), session({ eventHighWaterMark: 43 })],
    })
    expect((await failure(make(event.reader), request())).reason).toBe("event_drift")

    const projection = recordingReader({
      sessions: [session(), session({ sessionRevision: digest("9") }), session({ sessionRevision: digest("9") })],
    })
    expect((await failure(make(projection.reader), request())).reason).toBe("session_drift")
  })

  test("uses a final Session/Event fence after the second repository read", async () => {
    const event = recordingReader({
      sessions: [session(), session(), session({ eventHighWaterMark: 43 })],
    })
    expect((await failure(make(event.reader), request())).reason).toBe("event_drift")

    const projection = recordingReader({
      sessions: [session(), session(), session({ sessionRevision: digest("9") })],
    })
    expect((await failure(make(projection.reader), request())).reason).toBe("session_drift")
  })

  test("fails closed with git_drift for HEAD, index, or dirty evidence changes", async () => {
    for (const changed of [
      repository({ headCommit: commit("8"), sourceRevision: { kind: "commit", id: commit("8") } }),
      repository({ indexFingerprint: digest("8") }),
      repository({ dirtyFingerprint: digest("8") }),
    ]) {
      const recorded = recordingReader({ repositories: [repository(), changed] })
      expect((await failure(make(recorded.reader), request())).reason).toBe("git_drift")
      expect(recorded.writes).toEqual([])
    }
  })

  test("fails closed with path_drift for parent, leaf, or current-content changes", async () => {
    const parent = repository({
      projectRootAnchor: { ...root, inode: "99" },
      files: repository().files.map((file) => ({
        ...file,
        parentChain: [{ ...root, inode: "99" }, location],
      })),
    })
    const leaf = repository({
      files: repository().files.map((file) => ({
        ...file,
        leaf: file.leaf ? { ...file.leaf, inode: "99" } : null,
      })),
    })
    const content = repository({
      files: repository().files.map((file) => ({
        ...file,
        current: { kind: "file", object: "blob", mode: "100644", hash: digest("8"), bytes: 4 },
      })),
    })

    for (const changed of [parent, leaf, content]) {
      const recorded = recordingReader({ repositories: [repository(), changed] })
      expect((await failure(make(recorded.reader), request())).reason).toBe("path_drift")
      expect(recorded.writes).toEqual([])
    }
  })
})
