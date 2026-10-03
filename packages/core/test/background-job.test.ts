import { describe, expect } from "bun:test"
import { BackgroundJob } from "@arforge-ai/core/background-job"
import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { Deferred, Effect, Exit, Scope, Schema } from "effect"
import { it } from "./lib/effect"

const jobsLayer = LayerNode.compile(BackgroundJob.node)

describe("BackgroundJob", () => {
  it.live("cancels a metadata-linked subtree leaf-first and leaves unrelated jobs running", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const order: string[] = []
      for (const [id, sessionId, parentSessionId] of [
        ["child-job", "child-session", "root-session"],
        ["grandchild-job", "grandchild-session", "child-session"],
        ["unrelated-job", "unrelated-session", "other-root"],
      ] as const) {
        const ready = yield* Deferred.make<void>()
        yield* jobs.start({
          id,
          type: "task",
          metadata: { sessionId, parentSessionId },
          run: Deferred.succeed(ready, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.onInterrupt(() =>
              Effect.sync(() => {
                order.push(id)
              }),
            ),
          ),
        })
        yield* Deferred.await(ready)
      }
      yield* jobs.cancelSession("root-session")
      expect(order).toEqual(["grandchild-job", "child-job"])
      expect((yield* jobs.get("child-job"))?.status).toBe("cancelled")
      expect((yield* jobs.get("grandchild-job"))?.status).toBe("cancelled")
      expect((yield* jobs.get("unrelated-job"))?.status).toBe("running")
      yield* jobs.cancelSession("root-session")
      expect(order).toEqual(["grandchild-job", "child-job"])
    }).pipe(Effect.provide(jobsLayer)),
  )

  it.live("keeps failed jobs readable when an error has no message without exposing structured details", () =>
    Effect.gen(function* () {
      class StructuredFailure extends Schema.TaggedErrorClass<StructuredFailure>()("StructuredFailure", {
        reason: Schema.String,
      }) {}
      const jobs = yield* BackgroundJob.Service
      for (const failure of [
        new Error(),
        new Error(" \n\t"),
        "",
        new StructuredFailure({ reason: "private diagnostic details" }),
      ]) {
        const job = yield* jobs.start({
          type: "test",
          run: Effect.fail(failure),
          metadata: { sessionId: "child-fixture" },
        })
        const result = yield* jobs.wait({ id: job.id })
        expect(result.info).toMatchObject({
          status: "error",
          error: "Background task failed without an error message.",
          metadata: { sessionId: "child-fixture" },
        })
        expect(result.info?.error).not.toContain("private diagnostic details")
      }
      const job = yield* jobs.start({ type: "test", run: Effect.fail(new Error("Known task failure")) })
      expect((yield* jobs.wait({ id: job.id })).info?.error).toBe("Known task failure")
    }).pipe(Effect.provide(jobsLayer)),
  )
  for (const outcome of ["cancel", "complete"] as const)
    it.live(`discards only unstarted queued work on ${outcome}`, () =>
      Effect.gen(function* () {
        const jobs = yield* BackgroundJob.Service
        const gate = yield* Deferred.make<void>()
        let discarded = 0
        let executed = 0
        const job = yield* jobs.start({ type: "test", run: Deferred.await(gate).pipe(Effect.as("first")) })
        expect(
          yield* jobs.extend({
            id: job.id,
            run: Effect.sync(() => {
              executed++
              return "second"
            }),
            onDiscard: Effect.sync(() => {
              discarded++
            }),
          }),
        ).toBe(true)
        if (outcome === "cancel") yield* jobs.cancel(job.id)
        else {
          yield* Deferred.succeed(gate, undefined)
          yield* jobs.wait({ id: job.id })
        }
        expect(executed).toBe(outcome === "cancel" ? 0 : 1)
        expect(discarded).toBe(outcome === "cancel" ? 1 : 0)
        yield* jobs.cancel(job.id)
        expect(discarded).toBe(outcome === "cancel" ? 1 : 0)
        expect(
          yield* jobs.extend({
            id: "missing",
            run: Effect.succeed("unused"),
            onDiscard: Effect.sync(() => {
              discarded++
            }),
          }),
        ).toBe(false)
        expect(discarded).toBe(outcome === "cancel" ? 1 : 0)
      }).pipe(Effect.provide(jobsLayer)),
    )

  it.live("tracks process-local work through explicit observation", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const latch = yield* Deferred.make<void>()
      const job = yield* jobs.start({
        type: "test",
        metadata: { durable: false },
        run: Deferred.await(latch).pipe(Effect.as("done")),
      })

      expect(job).toMatchObject({ type: "test", status: "running", metadata: { durable: false } })
      expect(yield* jobs.wait({ id: job.id, timeout: 0 })).toMatchObject({
        timedOut: true,
        info: { status: "running" },
      })

      yield* Deferred.succeed(latch, undefined)
      expect(yield* jobs.wait({ id: job.id })).toMatchObject({
        timedOut: false,
        info: { status: "completed", output: "done" },
      })
    }).pipe(Effect.provide(jobsLayer)),
  )

  it.live("publishes jobs before starting immediately settling work", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service

      yield* Effect.forEach(Array.from({ length: 100 }), (_, index) => {
        const id = `job_immediate_start_${index}`
        return Effect.gen(function* () {
          const job = yield* jobs.start({
            id,
            type: "test",
            run: jobs
              .get(id)
              .pipe(
                Effect.flatMap((info) =>
                  info?.status === "running"
                    ? Effect.succeed(`done-${index}`)
                    : Effect.fail("job started before publish"),
                ),
              ),
          })

          expect(yield* jobs.wait({ id: job.id })).toMatchObject({
            timedOut: false,
            info: { status: "completed", output: `done-${index}` },
          })
        })
      })
    }).pipe(Effect.provide(jobsLayer)),
  )

  it.live("increments pending work before starting immediately settling extensions", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service

      yield* Effect.forEach(Array.from({ length: 100 }), (_, index) =>
        Effect.gen(function* () {
          const first = yield* Deferred.make<void>()
          const job = yield* jobs.start({
            type: "test",
            run: Deferred.await(first).pipe(Effect.as(`first-${index}`)),
          })

          expect(yield* jobs.extend({ id: job.id, run: Effect.succeed(`second-${index}`) })).toBe(true)
          expect((yield* jobs.get(job.id))?.status).toBe("running")

          yield* Deferred.succeed(first, undefined)
          expect(yield* jobs.wait({ id: job.id })).toMatchObject({
            timedOut: false,
            info: { status: "completed", output: `second-${index}` },
          })
        }),
      )
    }).pipe(Effect.provide(jobsLayer)),
  )

  it.live("interrupts live work without promising settlement after the owning process-local scope closes", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make()
      const interrupted = yield* Deferred.make<void>()
      const jobs = yield* BackgroundJob.make.pipe(Scope.provide(scope))
      const job = yield* jobs.start({
        type: "test",
        run: Effect.never.pipe(Effect.ensuring(Deferred.succeed(interrupted, undefined))),
      })

      yield* Scope.close(scope, Exit.void)

      yield* Deferred.await(interrupted).pipe(Effect.timeout("1 second"))
      // The abandoned in-memory registry is not a durable observation channel.
      expect((yield* jobs.get(job.id))?.status).toBe("running")
    }),
  )
})
