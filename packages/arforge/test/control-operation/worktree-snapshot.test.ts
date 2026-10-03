import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import type { PreparedCreate, PreparedRemove, PreparedReset } from "@/worktree"
import { WorktreeSnapshot } from "@/control-operation/worktree-snapshot"
import { canonicalHash } from "@arforge-ai/core/util/canonical-hash"

const commit = (digit: string) => digit.repeat(40)

const scope: WorktreeSnapshot.Scope = {
  projectID: "project-123",
  projectRoot: "C:\\repo",
  location: "C:\\repo",
  managedWorktreeRoot: "C:\\data\\worktrees\\project-123",
  reservationRoot: "C:\\data\\reservations\\project-123",
  managedWorktreeAnchor: {
    path: "C:\\data",
    realPath: "C:\\data",
    device: "1",
    inode: "2",
  },
  reservationAnchor: {
    path: "C:\\data",
    realPath: "C:\\data",
    device: "1",
    inode: "2",
  },
}

const target = "C:\\data\\worktrees\\project-123\\task"
const ownerPath = `C:\\data\\reservations\\project-123\\${createHash("sha256").update(target.toLowerCase()).digest("hex")}.json`

const roots = {
  managedWorktreeRoot: scope.managedWorktreeRoot,
  reservationRoot: scope.reservationRoot,
  managedWorktreeAnchor: scope.managedWorktreeAnchor,
  reservationAnchor: scope.reservationAnchor,
}

function mutationPath(kind: "remove" | "reset", requestID: string) {
  return `${ownerPath}.${kind}.${createHash("sha256").update(requestID).digest("hex").slice(0, 32)}.json`
}

const owner = {
  version: 1 as const,
  projectID: scope.projectID,
  requestID: "cpr_create_owner_0001",
  actionID: "act_create_owner_0001",
  directory: target,
  branch: "arforge/task",
  sourceCommit: commit("1"),
}

function preparedCreate(overrides: Partial<PreparedCreate> = {}): PreparedCreate {
  return {
    info: { name: "task", branch: "arforge/task", directory: target },
    start: { project: "", extra: "" },
    requestID: "cpr_create_00000001",
    reservationPath: ownerPath,
    sourceCommit: commit("2"),
    roots,
    ...overrides,
  }
}

function preparedRemove(overrides: Partial<PreparedRemove> = {}): PreparedRemove {
  const requestID = overrides.requestID ?? "cpr_remove_00000001"
  return {
    directory: target,
    worktreePath: target,
    branch: "arforge/task",
    branchCommit: commit("3"),
    requestID,
    owner,
    mutationReservationPath: mutationPath("remove", requestID),
    roots,
    ...overrides,
  }
}

function preparedReset(overrides: Partial<PreparedReset> = {}): PreparedReset {
  const requestID = overrides.requestID ?? "cpr_reset_00000001"
  return {
    directory: target,
    worktreePath: target,
    start: { project: "", extra: "" },
    requestID,
    owner,
    mutationReservationPath: mutationPath("reset", requestID),
    currentCommit: commit("4"),
    base: { name: "main", ref: "refs/remotes/origin/main", commit: commit("5") },
    roots,
    ...overrides,
  }
}

describe("worktree control-operation snapshot", () => {
  test("round-trips a create without scripts, environment, or caller metadata", () => {
    const snapshot = WorktreeSnapshot.encode({ kind: "create", value: preparedCreate() }, scope)
    const serialized = JSON.stringify(snapshot)
    const decoded = WorktreeSnapshot.decode(JSON.parse(serialized), scope)

    expect(decoded.prepared).toEqual({
      kind: "create",
      value: {
        info: { name: "task", branch: "arforge/task", directory: target.toLowerCase() },
        start: { project: "", extra: "" },
        requestID: "cpr_create_00000001",
        reservationPath: ownerPath.toLowerCase(),
        sourceCommit: commit("2"),
        roots: {
          managedWorktreeRoot: scope.managedWorktreeRoot.toLowerCase(),
          reservationRoot: scope.reservationRoot.toLowerCase(),
          managedWorktreeAnchor: {
            path: scope.managedWorktreeAnchor.path.toLowerCase(),
            realPath: scope.managedWorktreeAnchor.realPath.toLowerCase(),
            device: "1",
            inode: "2",
          },
          reservationAnchor: {
            path: scope.reservationAnchor.path.toLowerCase(),
            realPath: scope.reservationAnchor.realPath.toLowerCase(),
            device: "1",
            inode: "2",
          },
        },
      },
    })
    expect(snapshot.digest).toHaveLength(64)
    expect(serialized).not.toContain("start")
    expect(serialized).not.toContain("env")
    expect(serialized).not.toContain("metadata")
  })

  test("round-trips remove and reset ownership and immutable commits", () => {
    const remove = WorktreeSnapshot.encode({ kind: "remove", value: preparedRemove() }, scope)
    const reset = WorktreeSnapshot.encode({ kind: "reset", value: preparedReset() }, scope)

    const restoredRemove = WorktreeSnapshot.decode(JSON.parse(JSON.stringify(remove)), scope).prepared
    const restoredReset = WorktreeSnapshot.decode(JSON.parse(JSON.stringify(reset)), scope).prepared

    expect(restoredRemove.kind).toBe("remove")
    if (restoredRemove.kind === "remove") {
      expect(restoredRemove.value.owner.actionID).toBe(owner.actionID)
      expect(restoredRemove.value.branchCommit).toBe(commit("3"))
      expect(restoredRemove.value.mutationReservationPath).toBe(mutationPath("remove", remove.requestID).toLowerCase())
    }
    expect(restoredReset.kind).toBe("reset")
    if (restoredReset.kind === "reset") {
      expect(restoredReset.value.currentCommit).toBe(commit("4"))
      expect(restoredReset.value.base).toEqual({
        name: "main",
        ref: "refs/remotes/origin/main",
        commit: commit("5"),
      })
    }
  })

  test("projects only validated terminal continuation results", () => {
    const create = WorktreeSnapshot.encode({ kind: "create", value: preparedCreate() }, scope)
    const remove = WorktreeSnapshot.encode({ kind: "remove", value: preparedRemove() }, scope)
    expect(
      WorktreeSnapshot.completionResult(create, {
        projectID: scope.projectID,
        location: scope.location,
        operation: "worktree.create",
      }),
    ).toEqual({
      kind: "worktree.create",
      name: "task",
      directory: target.toLowerCase(),
      branch: "arforge/task",
    })
    expect(
      WorktreeSnapshot.completionResult(remove, {
        projectID: scope.projectID,
        location: scope.location,
        operation: "worktree.remove",
      }),
    ).toEqual({ kind: "worktree.remove", completed: true })
    expect(() =>
      WorktreeSnapshot.completionResult(
        { ...create, target: `${target}-forged` },
        {
          projectID: scope.projectID,
          location: scope.location,
          operation: "worktree.create",
        },
      ),
    ).toThrow()
    expect(() =>
      WorktreeSnapshot.completionResult(create, {
        projectID: "foreign-project",
        location: scope.location,
        operation: "worktree.create",
      }),
    ).toThrow()
  })

  test("matches only the normalized HTTP input that produced a sealed request", () => {
    const create = WorktreeSnapshot.encode({ kind: "create", value: preparedCreate() }, scope)
    const remove = WorktreeSnapshot.encode({ kind: "remove", value: preparedRemove() }, scope)
    const reset = WorktreeSnapshot.encode({ kind: "reset", value: preparedReset() }, scope)

    expect(
      WorktreeSnapshot.matchesPresentedInput(create, {
        operation: "worktree.create",
        requestID: create.requestID,
        payload: { requestID: create.requestID, name: " Task ", startCommand: "  " },
      }),
    ).toBe(true)
    expect(
      WorktreeSnapshot.matchesPresentedInput(create, {
        operation: "worktree.create",
        requestID: create.requestID,
        payload: { requestID: create.requestID, name: "different" },
      }),
    ).toBe(false)
    expect(
      WorktreeSnapshot.matchesPresentedInput(create, {
        operation: "worktree.create",
        requestID: create.requestID,
        payload: { requestID: create.requestID, name: "task", startCommand: "npm run start" },
      }),
    ).toBe(false)

    for (const [operation, snapshot] of [
      ["worktree.remove", remove],
      ["worktree.reset", reset],
    ] as const) {
      expect(
        WorktreeSnapshot.matchesPresentedInput(snapshot, {
          operation,
          requestID: snapshot.requestID,
          payload: { requestID: snapshot.requestID, directory: target },
        }),
      ).toBe(true)
      expect(
        WorktreeSnapshot.matchesPresentedInput(snapshot, {
          operation,
          requestID: snapshot.requestID,
          payload: { requestID: snapshot.requestID, directory: `${target}-different` },
        }),
      ).toBe(false)
    }
    expect(
      WorktreeSnapshot.matchesPresentedInput(
        { ...create, digest: "0".repeat(64) },
        {
          operation: "worktree.create",
          requestID: create.requestID,
          payload: { requestID: create.requestID, name: "task" },
        },
      ),
    ).toBe(false)
  })

  test("derives identical gateway material from the same serialized snapshot", () => {
    for (const prepared of [
      { kind: "create", value: preparedCreate() },
      { kind: "remove", value: preparedRemove() },
      { kind: "reset", value: preparedReset() },
    ] as const) {
      const snapshot = WorktreeSnapshot.encode(prepared, scope)
      const replay = WorktreeSnapshot.decode(JSON.parse(JSON.stringify(snapshot)), scope).snapshot
      expect(WorktreeSnapshot.actionMaterial(replay)).toEqual(WorktreeSnapshot.actionMaterial(snapshot))
      expect(WorktreeSnapshot.actionMaterial(snapshot).inputDigest).toBe(
        canonicalHash(WorktreeSnapshot.claimMaterial(snapshot).input) ?? "",
      )
      expect(WorktreeSnapshot.actionMaterial(snapshot).semantics.secretScope).toEqual([])
      expect(WorktreeSnapshot.actionMaterial(snapshot).semantics.filesystemScope).toContain(
        scope.managedWorktreeRoot.toLowerCase(),
      )
      expect(WorktreeSnapshot.actionMaterial(snapshot).semantics.filesystemScope).toContain(
        scope.reservationRoot.toLowerCase(),
      )
      expect(WorktreeSnapshot.actionMaterial(snapshot).semantics.networkScope).toContain("git-filter-processes")
      expect(WorktreeSnapshot.actionMaterial(snapshot).semantics.externalServices).toContain(
        "repository-configured-processes",
      )
      const material = WorktreeSnapshot.actionMaterial(snapshot)
      if (snapshot.kind === "create") {
        expect(material.resources).toContain("git:worktree-add")
        expect(material.semantics.expectedArtifacts).toEqual([snapshot.target, snapshot.ownershipReservationPath])
        expect(material.semantics.successCriteria).toEqual([
          `git worktree list contains ${snapshot.target}`,
          `git HEAD at ${snapshot.target} equals ${snapshot.sourceCommit}`,
          `git branch ${snapshot.branch} resolves to ${snapshot.sourceCommit}`,
          `project registry ${snapshot.projectID} contains sandbox ${snapshot.target}`,
        ])
      } else if (snapshot.kind === "remove") {
        expect(material.semantics.expectedArtifacts).toEqual([])
        expect(material.semantics.successCriteria).toContain(`filesystem path ${snapshot.target} does not exist`)
        expect(material.semantics.successCriteria).toContain(
          `project registry ${snapshot.projectID} excludes sandbox ${snapshot.target}`,
        )
      } else {
        expect(material.semantics.expectedArtifacts).toEqual([snapshot.target])
        expect(material.semantics.successCriteria).toContain(
          `git HEAD at ${snapshot.target} equals ${snapshot.baseCommit}`,
        )
        expect(material.semantics.successCriteria).toContain(`git status --porcelain at ${snapshot.target} is empty`)
      }
    }
  })

  test("separates request-bound sealed payloads from canonical claim material", () => {
    const createA = WorktreeSnapshot.encode({ kind: "create", value: preparedCreate() }, scope)
    const createB = WorktreeSnapshot.encode(
      {
        kind: "create",
        value: preparedCreate({ requestID: "cpr_create_00000002" }),
      },
      scope,
    )
    expect(createA.digest).not.toBe(createB.digest)
    expect(canonicalHash(WorktreeSnapshot.executionInput(createA))).toBe(createA.digest)
    expect(WorktreeSnapshot.claimMaterial(createA)).toEqual(WorktreeSnapshot.claimMaterial(createB))
    expect(WorktreeSnapshot.actionMaterial(createA)).toEqual(WorktreeSnapshot.actionMaterial(createB))

    const removeA = WorktreeSnapshot.encode({ kind: "remove", value: preparedRemove() }, scope)
    const removeB = WorktreeSnapshot.encode(
      {
        kind: "remove",
        value: preparedRemove({
          requestID: "cpr_remove_00000002",
          owner: { ...owner, requestID: "cpr_create_owner_0002", actionID: "act_create_owner_0002" },
        }),
      },
      scope,
    )
    expect(removeA.digest).not.toBe(removeB.digest)
    expect(WorktreeSnapshot.claimMaterial(removeA)).toEqual(WorktreeSnapshot.claimMaterial(removeB))
    expect(WorktreeSnapshot.actionMaterial(removeA)).toEqual(WorktreeSnapshot.actionMaterial(removeB))
  })

  test("rejects startup scripts, non-canonical authority, and paths outside project scopes", () => {
    expect(() =>
      WorktreeSnapshot.encode(
        { kind: "create", value: preparedCreate({ start: { project: "npm start", extra: "" } }) },
        scope,
      ),
    ).toThrow("startup scripts")
    expect(() =>
      WorktreeSnapshot.encode(
        { kind: "remove", value: preparedRemove({ directory: "C:\\someone-else\\task" }) },
        scope,
      ),
    ).toThrow("managed worktree boundary")
    expect(() =>
      WorktreeSnapshot.encode(
        {
          kind: "remove",
          value: preparedRemove({ owner: { ...owner, projectID: "different-project" } }),
        },
        scope,
      ),
    ).toThrow("different project")
    expect(() =>
      WorktreeSnapshot.encode(
        { kind: "reset", value: preparedReset({ mutationReservationPath: "C:\\outside\\reset.json" }) },
        scope,
      ),
    ).toThrow("reservation boundary")
  })

  test("rejects bad commits, request bindings, digest tampering, and unknown fields", () => {
    expect(() =>
      WorktreeSnapshot.encode({ kind: "create", value: preparedCreate({ sourceCommit: "HEAD" }) }, scope),
    ).toThrow("immutable Git commit")
    expect(() =>
      WorktreeSnapshot.encode(
        {
          kind: "remove",
          value: preparedRemove({ mutationReservationPath: `${ownerPath}.remove.wrong.json` }),
        },
        scope,
      ),
    ).toThrow("not bound")

    const snapshot = WorktreeSnapshot.encode({ kind: "create", value: preparedCreate() }, scope)
    expect(() => WorktreeSnapshot.decode({ ...snapshot, sourceCommit: commit("9") }, scope)).toThrow("digest")
    expect(() => WorktreeSnapshot.decode({ ...snapshot, token: "secret" }, scope)).toThrow("schema is invalid")
    expect(() => WorktreeSnapshot.decode(snapshot, { ...scope, projectID: "other-project" })).toThrow(
      "does not match the current control run",
    )
  })

  test("binds reservation paths to the canonical project target", () => {
    const unrelatedOwner = "C:\\data\\reservations\\project-123\\unrelated.json"
    expect(() =>
      WorktreeSnapshot.encode(
        {
          kind: "create",
          value: preparedCreate({ reservationPath: unrelatedOwner }),
        },
        scope,
      ),
    ).toThrow("not bound")

    const requestID = "cpr_remove_00000001"
    const unrelatedMutation = `${unrelatedOwner}.remove.${createHash("sha256").update(requestID).digest("hex").slice(0, 32)}.json`
    expect(() =>
      WorktreeSnapshot.encode(
        {
          kind: "remove",
          value: preparedRemove({ mutationReservationPath: unrelatedMutation }),
        },
        scope,
      ),
    ).toThrow("not bound")
  })

  test("rejects Git-invalid ref components and root anchor drift", () => {
    expect(() =>
      WorktreeSnapshot.encode(
        {
          kind: "reset",
          value: preparedReset({ base: { name: "main", ref: "refs/remotes/origin/.main", commit: commit("5") } }),
        },
        scope,
      ),
    ).toThrow("safe Git ref")
    expect(() =>
      WorktreeSnapshot.encode(
        {
          kind: "reset",
          value: preparedReset({
            base: { name: "main", ref: "refs/remotes/origin/foo.lock/main", commit: commit("5") },
          }),
        },
        scope,
      ),
    ).toThrow("safe Git ref")

    const snapshot = WorktreeSnapshot.encode({ kind: "create", value: preparedCreate() }, scope)
    expect(() =>
      WorktreeSnapshot.decode(snapshot, {
        ...scope,
        managedWorktreeAnchor: { ...scope.managedWorktreeAnchor, inode: "99" },
      }),
    ).toThrow("does not match")
  })
})
