import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Flag } from "@arforge-ai/core/flag/flag"
import { Effect } from "effect"

test("embedded trigger client and scheduled-prompt client share one durable local state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "arforge-trigger-"))
  const database = Flag.ARFORGE_DB
  Flag.ARFORGE_DB = join(directory, "arforge.sqlite")
  const { AbsolutePath, Arforge, Location, Session, Trigger } = await import("../src")
  const sessionID = Session.ID.make(`ses_trigger_${crypto.randomUUID()}`)
  const local = Trigger.ProfileName.make("local")

  try {
    const program = Effect.gen(function* () {
      const arforge = yield* Arforge.create()
      yield* arforge.sessions.create({
        id: sessionID,
        location: Location.Ref.make({ directory: AbsolutePath.make(directory) }),
      })
      expect(yield* arforge.triggers.profiles()).toMatchObject({
        count: 1,
        items: [{ name: "local", kind: "local" }],
      })
      const created = yield* arforge.triggers.create({
        sessionID,
        profile: local,
        body: {
          name: "Trigger schedule",
          cron_expression: "* * * * *",
          prompt: "Review the release.",
          recurring: true,
          durable: true,
          enabled: false,
        },
      })
      expect(created).toMatchObject({ profile: "local", action: "create", ok: true })
      const trigger = created.data as { id: string; revision: number; enabled: boolean }
      expect(trigger.enabled).toBeFalse()

      const schedules = yield* arforge.scheduledPrompts.list({ sessionID })
      expect(schedules).toHaveLength(1)
      expect(schedules[0]).toMatchObject({ id: trigger.id, name: "Trigger schedule", enabled: false })

      const updated = yield* arforge.triggers.update({
        sessionID,
        profile: local,
        triggerID: trigger.id,
        body: { prompt: "Collect release evidence.", recurring: false, enabled: true },
      })
      expect(updated.data).toMatchObject({ prompt: "Collect release evidence.", recurring: false, enabled: true })
      const beforeRun = updated.data as { revision: number }
      expect(
        yield* arforge.scheduledPrompts.get({
          sessionID,
          scheduleID: schedules[0]!.id,
        }),
      ).toMatchObject({ prompt: "Collect release evidence.", recurring: false, enabled: true })

      const run = yield* arforge.triggers.run({ sessionID, profile: local, triggerID: trigger.id })
      expect(run.data).toMatchObject({
        prompt: "Collect release evidence.",
        status: "completed",
        revision: beforeRun.revision + 1,
      })
      expect((yield* arforge.triggers.list({ sessionID, profile: local })).data).toMatchObject({ count: 1 })
      expect(
        yield* arforge.triggers.get({ sessionID, profile: local, triggerID: "../escape" }).pipe(Effect.flip),
      ).toMatchObject({ _tag: "TriggerRequestError", code: "INVALID_TRIGGER_ID" })
    })
    await Effect.runPromise(Effect.scoped(program))
    await Bun.sleep(250)
  } finally {
    Flag.ARFORGE_DB = database
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => undefined)
  }
}, 10_000)
