import { describe, expect, test } from "bun:test"
import { canonicalHash } from "@arforge-ai/core/util/canonical-hash"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { SessionRevertSnapshot } from "@/session/revert-snapshot"

const commit = (digit: string) => digit.repeat(40)
const digest = (digit: string) => digit.repeat(64)

const directory = (value: string, device: string, inode: string) => ({
  path: value,
  realPath: value,
  device,
  inode,
  type: "directory" as const,
})

const root = directory("C:\\Repo", "1", "10")
const location = directory("C:\\Repo\\src", "1", "11")

function preflight(overrides: Partial<SessionRevertSnapshot.Preflight> = {}): SessionRevertSnapshot.Preflight {
  return {
    version: 1,
    kind: "revert",
    requestID: "cpr_session_revert_0001",
    sessionID: SessionID.descending("ses_revert_snapshot_test"),
    projectID: "project-123",
    projectRoot: root.path,
    location: location.path,
    projectRootAnchor: root,
    locationAnchor: location,
    target: {
      messageID: MessageID.make("msg_revert_boundary"),
      messageSequence: 17,
      partID: PartID.make("prt_revert_boundary"),
      partIndex: 2,
    },
    sessionRevision: digest("1"),
    eventHighWaterMark: 42,
    sourceRevision: { kind: "snapshot", id: commit("2") },
    targetRevisions: [
      { kind: "snapshot", id: commit("4") },
      { kind: "snapshot", id: commit("3") },
    ],
    headCommit: commit("5"),
    indexFingerprint: digest("6"),
    dirtyFingerprint: digest("7"),
    files: [
      {
        relativePath: "src/deleted.txt",
        path: "C:\\Repo\\src\\deleted.txt",
        parentChain: [root, location],
        leaf: {
          ...directory("C:\\Repo\\src\\deleted.txt", "1", "13"),
          type: "file",
        },
        preimage: { kind: "file", object: "blob", mode: "100644", hash: digest("8"), bytes: 12 },
        current: { kind: "file", object: "blob", mode: "100644", hash: digest("8"), bytes: 12 },
        target: { kind: "absent", hash: SessionRevertSnapshot.ABSENT_CONTENT_HASH },
        targetRevision: { kind: "snapshot", id: commit("4") },
      },
      {
        relativePath: "src/restored.txt",
        path: "C:\\Repo\\src\\restored.txt",
        parentChain: [root, location],
        leaf: null,
        preimage: { kind: "absent", hash: SessionRevertSnapshot.ABSENT_CONTENT_HASH },
        current: { kind: "absent", hash: SessionRevertSnapshot.ABSENT_CONTENT_HASH },
        target: { kind: "file", object: "blob", mode: "100755", hash: digest("9"), bytes: 21 },
        targetRevision: { kind: "snapshot", id: commit("3") },
      },
    ],
    ...overrides,
  }
}

describe("session revert sealed preflight snapshot", () => {
  test("round-trips canonical Windows scope and remains deeply immutable", () => {
    const snapshot = SessionRevertSnapshot.encode(preflight())
    const expected = SessionRevertSnapshot.claimMaterial(snapshot).input
    const decoded = SessionRevertSnapshot.decode(JSON.parse(JSON.stringify(snapshot)), expected).snapshot

    expect(decoded.projectRoot).toBe("c:\\repo")
    expect(decoded.location).toBe("c:\\repo\\src")
    expect(decoded.files.map((item) => item.path)).toEqual([
      "c:\\repo\\src\\deleted.txt",
      "c:\\repo\\src\\restored.txt",
    ])
    expect(decoded.targetRevisions.map((item) => item.id)).toEqual([commit("3"), commit("4")])
    expect(decoded.files[0]?.preimage).toMatchObject({ object: "blob", mode: "100644" })
    expect(decoded.files[1]?.target).toMatchObject({ object: "blob", mode: "100755" })
    expect(decoded.digest).toHaveLength(64)
    expect(Object.isFrozen(decoded)).toBe(true)
    expect(Object.isFrozen(decoded.files)).toBe(true)
    expect(Object.isFrozen(decoded.files[0]?.parentChain)).toBe(true)
  })

  test("separates request-bound payloads from request-independent claim and action material", () => {
    const first = SessionRevertSnapshot.encode(preflight())
    const second = SessionRevertSnapshot.encode(preflight({ requestID: "cpr_session_revert_0002" }))

    expect(first.digest).not.toBe(second.digest)
    expect(canonicalHash(SessionRevertSnapshot.executionInput(first))).toBe(first.digest)
    expect(SessionRevertSnapshot.claimMaterial(first)).toEqual(SessionRevertSnapshot.claimMaterial(second))
    expect(SessionRevertSnapshot.actionMaterial(first)).toEqual(SessionRevertSnapshot.actionMaterial(second))
  })

  test("derives only an L3 fresh-human action from a verified sealed payload", () => {
    const snapshot = SessionRevertSnapshot.encode(preflight({ kind: "unrevert" }))
    const material = SessionRevertSnapshot.actionMaterial(snapshot)
    const plan = SessionRevertSnapshot.authorizationPlan(snapshot)

    expect(material.name).toBe("session.unrevert")
    expect(material.semantics.riskTier).toBe("L3")
    expect(material.semantics.authority).toBe("human")
    expect(material.semantics.reversibility).toBe("compensatable")
    expect(material.requiresFreshHumanConfirmation).toBe(true)
    expect(material.resources).toContain("filesystem:c:\\repo\\src\\deleted.txt")
    expect(material.resources).toContain(`session-event:${snapshot.sessionID}@42`)
    expect(material.semantics.secretScope).toEqual([])
    expect(material.semantics.successCriteria).toContain("c:\\repo\\src\\deleted.txt is absent")
    expect(material.semantics.successCriteria).toContain(
      `c:\\repo\\src\\restored.txt is an ordinary Git blob with mode 100755, 21 bytes, and sha256 ${digest("9")}`,
    )
    expect(plan.metadata).toMatchObject({ fresh: true })

    expect(() => SessionRevertSnapshot.actionMaterial({ ...snapshot, digest: digest("0") })).toThrow("snapshot digest")
  })

  test("seals a preimage receipt before restore and binds retry aliases to the exact request", () => {
    const snapshot = SessionRevertSnapshot.encode(preflight())
    const receipt = SessionRevertSnapshot.preimageReceipt(snapshot)

    expect(receipt.snapshotDigest).toBe(snapshot.digest)
    expect(receipt.files[0]?.current).toEqual(snapshot.files[0]?.current)
    expect(SessionRevertSnapshot.decodePreimageReceipt(JSON.parse(JSON.stringify(receipt)))).toEqual(receipt)
    expect(
      SessionRevertSnapshot.matchesPresentedInput(receipt, {
        kind: "revert",
        requestID: snapshot.requestID,
        sessionID: snapshot.sessionID,
        messageID: snapshot.target.messageID,
        partID: snapshot.target.partID,
      }),
    ).toBe(false)
    expect(
      SessionRevertSnapshot.matchesPresentedInput(receipt, {
        kind: "revert",
        requestID: snapshot.requestID,
        sessionID: snapshot.sessionID,
      }),
    ).toBe(false)
    expect(() => SessionRevertSnapshot.decodePreimageReceipt({ ...receipt, digest: digest("f") })).toThrow()
    expect(() => SessionRevertSnapshot.decodePreimageReceipt({ ...receipt, snapshotDigest: digest("f") })).toThrow()
    expect(
      SessionRevertSnapshot.matchesPresentedInput(snapshot, {
        kind: "revert",
        requestID: snapshot.requestID,
        sessionID: snapshot.sessionID,
        messageID: snapshot.target.messageID,
        partID: snapshot.target.partID,
      }),
    ).toBe(true)
    expect(
      SessionRevertSnapshot.matchesPresentedInput(snapshot, {
        kind: "revert",
        requestID: snapshot.requestID,
        sessionID: snapshot.sessionID,
        messageID: MessageID.make("msg_other"),
      }),
    ).toBe(false)
  })

  test("rejects unknown fields, request-bound tampering, and independently observed drift", () => {
    const snapshot = SessionRevertSnapshot.encode(preflight())
    const expected = SessionRevertSnapshot.claimMaterial(snapshot).input

    expect(() => SessionRevertSnapshot.decode({ ...snapshot, token: "secret" }, expected)).toThrow(
      "snapshot schema is invalid",
    )
    expect(() =>
      SessionRevertSnapshot.decode(
        {
          ...snapshot,
          files: snapshot.files.map((item, index) =>
            index === 0
              ? { ...item, target: { kind: "file", object: "blob", mode: "100644", hash: digest("a"), bytes: 1 } }
              : item,
          ),
        },
        expected,
      ),
    ).toThrow("snapshot digest")
    expect(() =>
      SessionRevertSnapshot.decode(snapshot, {
        ...expected,
        sessionRevision: digest("a"),
      }),
    ).toThrow("evidence drifted")
    expect(() =>
      SessionRevertSnapshot.decode(snapshot, {
        ...expected,
        files: expected.files.map((item, index) =>
          index === 0
            ? {
                ...item,
                current: { kind: "file", object: "blob", mode: "100644", hash: digest("b"), bytes: 12 },
              }
            : item,
        ),
      }),
    ).toThrow("current content drifted")
  })

  test("rejects Windows device paths, junction drift, ADS, and paths outside location", () => {
    expect(() => SessionRevertSnapshot.encode(preflight({ projectRoot: "\\\\?\\C:\\Repo" }))).toThrow(
      "Windows device path",
    )
    expect(() =>
      SessionRevertSnapshot.encode(
        preflight({
          locationAnchor: { ...location, realPath: "C:\\Elsewhere" },
        }),
      ),
    ).toThrow("symlink or junction")
    expect(() =>
      SessionRevertSnapshot.encode(
        preflight({
          files: [
            {
              ...preflight().files[0]!,
              relativePath: "src/file.txt:stream",
              path: "C:\\Repo\\src\\file.txt:stream",
            },
          ],
          targetRevisions: [{ kind: "snapshot", id: commit("4") }],
        }),
      ),
    ).toThrow("unsafe Windows path segment")
    expect(() =>
      SessionRevertSnapshot.encode(
        preflight({
          files: [
            {
              ...preflight().files[0]!,
              relativePath: "outside.txt",
              path: "C:\\Repo\\outside.txt",
              parentChain: [root],
            },
          ],
          targetRevisions: [{ kind: "snapshot", id: commit("4") }],
        }),
      ),
    ).toThrow("outside the session location")

    for (const reserved of ["CONIN$", "CONOUT$", "CLOCK$", "COM¹", "LPT³"]) {
      expect(() =>
        SessionRevertSnapshot.encode(
          preflight({
            files: [
              {
                ...preflight().files[0]!,
                relativePath: `src/${reserved}.txt`,
                path: `C:\\Repo\\src\\${reserved}.txt`,
              },
            ],
            targetRevisions: [{ kind: "snapshot", id: commit("4") }],
          }),
        ),
      ).toThrow("reserved Windows path segment")
    }
  })

  test("fails closed when evidence is incomplete or internally contradictory", () => {
    let arrayGetterCalled = false
    const accessorFiles: unknown[] = []
    Object.defineProperty(accessorFiles, "0", {
      enumerable: true,
      configurable: true,
      get: () => {
        arrayGetterCalled = true
        return preflight().files[0]
      },
    })
    expect(() =>
      SessionRevertSnapshot.encode({
        ...preflight(),
        files: accessorFiles as SessionRevertSnapshot.Preflight["files"],
      }),
    ).toThrow(/accessor property/)
    expect(arrayGetterCalled).toBe(false)

    let proxyTrapCalled = false
    const proxied = new Proxy(preflight(), {
      getPrototypeOf: () => {
        proxyTrapCalled = true
        return Object.prototype
      },
    })
    expect(() => SessionRevertSnapshot.encode(proxied)).toThrow(/cannot be a Proxy/)
    expect(proxyTrapCalled).toBe(false)

    const tooDeep = preflight() as SessionRevertSnapshot.Preflight & { nested?: unknown }
    let cursor: Record<string, unknown> = tooDeep as unknown as Record<string, unknown>
    for (let depth = 0; depth <= SessionRevertSnapshot.MAX_RAW_DEPTH; depth++) {
      const child: Record<string, unknown> = {}
      cursor.nested = child
      cursor = child
    }
    expect(() => SessionRevertSnapshot.encode(tooDeep)).toThrow(/raw depth limit/)

    const historyOnlySnapshot = SessionRevertSnapshot.encode(preflight({ files: [], targetRevisions: [] }))
    const historyOnly = SessionRevertSnapshot.decode(
      JSON.parse(JSON.stringify(historyOnlySnapshot)),
      SessionRevertSnapshot.claimMaterial(historyOnlySnapshot).input,
    ).snapshot
    expect(historyOnly.files).toEqual([])
    expect(historyOnly.targetRevisions).toEqual([])
    const dirtyHistoryOnly = SessionRevertSnapshot.encode(
      preflight({ files: [], targetRevisions: [], dirtyFingerprint: digest("d") }),
    )
    expect(dirtyHistoryOnly.dirtyFingerprint).toBe(digest("d"))
    expect(() =>
      SessionRevertSnapshot.encode(
        preflight({
          target: {
            messageID: MessageID.make("msg_revert_boundary"),
            messageSequence: 17,
            partID: PartID.make("prt_revert_boundary"),
          },
        }),
      ),
    ).toThrow("partID and partIndex")
    expect(() =>
      SessionRevertSnapshot.encode(
        preflight({
          files: preflight().files.map((item, index) =>
            index === 0
              ? {
                  ...item,
                  current: { kind: "file", object: "blob", mode: "100644", hash: digest("a"), bytes: 12 },
                }
              : item,
          ),
        }),
      ),
    ).toThrow("current content drifted")
    expect(() =>
      SessionRevertSnapshot.encode(
        preflight({
          files: [preflight().files[0]!],
        }),
      ),
    ).toThrow("exactly match")

    expect(() =>
      SessionRevertSnapshot.encode({
        ...preflight(),
        files: Array.from({ length: SessionRevertSnapshot.MAX_RESTORE_FILES + 1 }, () => preflight().files[0]!),
      }),
    ).toThrow(/file limit|raw array items/)

    expect(() =>
      SessionRevertSnapshot.decode(
        {
          ...SessionRevertSnapshot.encode(preflight()),
          files: preflight().files.map((item, index) =>
            index === 0
              ? {
                  ...item,
                  preimage: { ...item.preimage, object: "tree", mode: "040000" },
                }
              : item,
          ),
        },
        SessionRevertSnapshot.claimMaterial(SessionRevertSnapshot.encode(preflight())).input,
      ),
    ).toThrow("snapshot schema is invalid")
  })
})
