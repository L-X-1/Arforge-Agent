import { afterAll, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Flag } from "@arforge-ai/core/flag/flag"
import { DateTime, Effect } from "effect"

const originalDisableFileWatcher = process.env.ARFORGE_EXPERIMENTAL_DISABLE_FILEWATCHER
if (process.platform === "win32") process.env.ARFORGE_EXPERIMENTAL_DISABLE_FILEWATCHER = "true"
afterAll(() => {
  if (originalDisableFileWatcher === undefined) delete process.env.ARFORGE_EXPERIMENTAL_DISABLE_FILEWATCHER
  else process.env.ARFORGE_EXPERIMENTAL_DISABLE_FILEWATCHER = originalDisableFileWatcher
})

test("embedded API exposes isolated approve, activate, redact, and reject candidate lifecycles", async () => {
  const directory = await mkdtemp(join(tmpdir(), "arforge-memory-candidate-review-"))
  const database = Flag.ARFORGE_DB
  Flag.ARFORGE_DB = join(directory, "arforge.sqlite")
  const { Arforge } = await import("../src")

  try {
    const program = Effect.gen(function* () {
      const arforge = yield* Arforge.create()
      const location = { directory }
      const before = yield* arforge.personalWorkspace.snapshot({ location, limit: 100 })
      const priorIDs = new Set(before.memoryCandidates.map((candidate) => candidate.candidateID))

      const routed = yield* arforge.memories
        .create({
          location,
          content: "Prefer small reviewable changes when modifying this project.",
          type: "preference",
          scope: "workspace",
          source: "model",
        })
        .pipe(Effect.flip)
      expect(routed._tag).toBe("InvalidRequestError")

      const snapshot = yield* arforge.personalWorkspace.snapshot({ location, limit: 100 })
      const candidate = snapshot.memoryCandidates.find((item) => !priorIDs.has(item.candidateID))
      expect(candidate).toBeDefined()
      const review = yield* arforge.memories.candidateReview({ location, candidateID: candidate!.candidateID })
      expect(review).toMatchObject({ status: "proposed", approvalAllowed: true, contentRedacted: false })
      expect(review.content).toContain("small reviewable changes")
      expect(review.audit.map((entry) => entry.operation)).toEqual(["proposed"])
      const otherWorkspace = join(directory, "other-workspace")
      yield* Effect.promise(() => mkdir(otherWorkspace))
      const hiddenFromOtherWorkspace = yield* arforge.memories
        .candidateReview({
          location: { directory: otherWorkspace },
          candidateID: candidate!.candidateID,
        })
        .pipe(Effect.flip)
      expect(hiddenFromOtherWorkspace._tag).toBe("InvalidRequestError")

      const approved = yield* arforge.memories.candidateApprove({
        location,
        candidateID: candidate!.candidateID,
        expectedUpdatedAt: DateTime.toEpochMillis(review.time.updated),
        reason: "This preference matches the user's project workflow.",
      })
      expect(approved).toMatchObject({ status: "approved", activationAllowed: true })
      const pendingActivation = yield* arforge.personalWorkspace.snapshot({ location, limit: 100 })
      expect(pendingActivation.memoryCandidates).toContainEqual(
        expect.objectContaining({ candidateID: candidate!.candidateID, status: "approved", needsHuman: true }),
      )

      const activated = yield* arforge.memories.candidateActivate({
        location,
        candidateID: candidate!.candidateID,
        expectedUpdatedAt: DateTime.toEpochMillis(approved.time.updated),
        reason: "Activate the explicitly reviewed project preference.",
      })
      expect(activated.status).toBe("promoted")
      expect(activated.audit.map((entry) => entry.operation)).toEqual(["proposed", "approved", "activated"])
      const afterActivation = yield* arforge.personalWorkspace.snapshot({ location, limit: 100 })
      expect(afterActivation.memoryCandidates.some((item) => item.candidateID === candidate!.candidateID)).toBe(false)

      yield* arforge.memories
        .create({
          location,
          content: "api_key=TEST_ONLY_NOT_A_REAL_KEY_1234567890",
          type: "fact",
          scope: "workspace",
          source: "model",
        })
        .pipe(Effect.flip)
      const afterSecret = yield* arforge.personalWorkspace.snapshot({ location, limit: 100 })
      const secretCandidate = afterSecret.memoryCandidates.find(
        (item) => item.candidateID !== candidate!.candidateID && !priorIDs.has(item.candidateID),
      )
      expect(secretCandidate).toBeDefined()
      const secretReview = yield* arforge.memories.candidateReview({
        location,
        candidateID: secretCandidate!.candidateID,
      })
      expect(secretReview).toMatchObject({
        sensitivity: "secret",
        contentRedacted: true,
        approvalAllowed: false,
      })
      expect(secretReview.content).toBeUndefined()
      expect(secretReview.blockedReasons).toContain("secret_or_credential")

      const rejected = yield* arforge.memories.candidateReject({
        location,
        candidateID: secretCandidate!.candidateID,
        expectedUpdatedAt: DateTime.toEpochMillis(secretReview.time.updated),
        reason: "Credentials must never become durable memory.",
      })
      expect(rejected.status).toBe("rejected")
      expect(rejected.audit.map((entry) => entry.operation)).toEqual(["proposed", "rejected"])
    })
    await Effect.runPromise(Effect.scoped(program))
  } finally {
    Flag.ARFORGE_DB = database
    await cleanup(directory)
  }
}, 120_000)

async function cleanup(directory: string) {
  Bun.gc(true)
  for (let attempt = 0; ; attempt++) {
    try {
      await rm(directory, { recursive: true, force: true })
      return
    } catch (error) {
      const transient =
        process.platform === "win32" &&
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        ["EBUSY", "EPERM", "ENOTEMPTY"].includes(String(error.code))
      if (!transient || attempt >= 5) throw error
      Bun.gc(true)
      await Bun.sleep(100 * (attempt + 1))
    }
  }
}
