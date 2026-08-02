import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Flag } from "@arforge-ai/core/flag/flag"
import { Effect } from "effect"

test("embedded client exposes session-scoped cooperative wait observation and stale-safe wake", async () => {
  const directory = await mkdtemp(join(tmpdir(), "arforge-wait-"))
  const database = Flag.ARFORGE_DB
  Flag.ARFORGE_DB = join(directory, "arforge.sqlite")
  const { AbsolutePath, Arforge, CooperativeWait, Location, Session } = await import("../src")
  const sessionID = Session.ID.make(`ses_wait_${crypto.randomUUID()}`)

  try {
    const program = Effect.gen(function* () {
      const arforge = yield* Arforge.create()
      yield* arforge.sessions.create({
        id: sessionID,
        location: Location.Ref.make({ directory: AbsolutePath.make(directory) }),
      })
      expect(yield* arforge.waits.active({ sessionID })).toBeNull()
      expect(
        yield* arforge.waits
          .wake({ sessionID, waitID: CooperativeWait.ID.create() })
          .pipe(Effect.flip),
      ).toMatchObject({ _tag: "WaitNotFoundError", sessionID })
    })
    await Effect.runPromise(Effect.scoped(program))
    await Bun.sleep(250)
  } finally {
    Flag.ARFORGE_DB = database
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => undefined)
  }
}, 10_000)
