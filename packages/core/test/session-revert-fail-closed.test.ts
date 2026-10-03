import { describe, expect, it } from "bun:test"
import { Effect } from "effect"

import { SessionRevert } from "../src/session/revert"
import { SessionMessage } from "../src/session/message"
import type { SessionSchema } from "../src/session/schema"

describe("low-level session revert fail-closed", () => {
  it("rejects stage, clear, and commit before reading the session input", async () => {
    let reads = 0
    const session = new Proxy(
      {},
      {
        get() {
          reads += 1
          throw new Error("session input must not be read")
        },
      },
    ) as SessionSchema.Info

    const stage = await Effect.runPromise(
      SessionRevert.stage({ session, messageID: SessionMessage.ID.make("msg_blocked") }).pipe(Effect.flip),
    )
    const clear = await Effect.runPromise(SessionRevert.clear(session).pipe(Effect.flip))
    const commit = await Effect.runPromise(SessionRevert.commit(session).pipe(Effect.flip))

    expect(stage).toBeInstanceOf(SessionRevert.MutationUnavailableError)
    expect(clear).toBeInstanceOf(SessionRevert.MutationUnavailableError)
    expect(commit).toBeInstanceOf(SessionRevert.MutationUnavailableError)
    expect([stage.operation, clear.operation, commit.operation]).toEqual(["stage", "clear", "commit"])
    expect(reads).toBe(0)
  })
})
