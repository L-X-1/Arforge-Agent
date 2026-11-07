import { describe, expect, test } from "bun:test"
import { createOwnedProcessStop, createQuitCoordinator, createSidecarOwner, createStartupGate } from "./lifecycle"

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe("owned application shutdown", () => {
  test("visible startup feedback precedes backend readiness without publishing ready", async () => {
    const ready = deferred()
    const order: string[] = []
    const gate = createStartupGate()
    const start = gate.start(
      () => order.push("visible-window"),
      async () => {
        order.push("owned-spawn")
        await ready.promise
        order.push("health-ready")
      },
    )
    expect(order).toEqual(["visible-window", "owned-spawn"])
    ready.resolve()
    await start
    expect(order).toEqual(["visible-window", "owned-spawn", "health-ready"])
  })

  test("closing the startup window fences late child admission, even after cleanup has resolved", async () => {
    const gate = createStartupGate()
    let children = 0
    await expect(
      gate.start(
        () => gate.close(),
        async () => {
          children++
        },
      ),
    ).rejects.toThrow("shutting down")
    await expect(
      gate.start(
        () => {
          throw new Error("must not reopen a window")
        },
        async () => {
          children++
        },
      ),
    ).rejects.toThrow("shutting down")
    expect(children).toBe(0)
  })
  test("repeated Quit waits for cleanup once and permits the subsequent Electron quit", async () => {
    const cleanup = deferred()
    let stops = 0,
      quits = 0,
      prevented = 0
    const coordinator = createQuitCoordinator({
      stop: () => {
        stops++
        return cleanup.promise
      },
      quit: () => {
        quits++
      },
      onError: (error) => {
        throw error
      },
    })
    const event = {
      preventDefault: () => {
        prevented++
      },
    }
    coordinator.beforeQuit(event)
    coordinator.beforeQuit(event)
    await Promise.resolve()
    expect(coordinator.requested).toBe(true)
    expect(stops).toBe(1)
    expect(quits).toBe(0)
    cleanup.resolve()
    await coordinator.stop()
    await Promise.resolve()
    expect(quits).toBe(1)
    coordinator.beforeQuit(event)
    expect(prevented).toBe(2)
  })

  test("failed cleanup is visible and never declares a successful quit", async () => {
    const failure = new Error("captured child still alive")
    let error: unknown,
      quits = 0
    const coordinator = createQuitCoordinator({
      stop: async () => {
        throw failure
      },
      quit: () => {
        quits++
      },
      onError: (value) => {
        error = value
      },
    })
    coordinator.beforeQuit({ preventDefault() {} })
    await coordinator.stop().catch(() => {})
    await Promise.resolve()
    expect(error).toBe(failure)
    expect(quits).toBe(0)
  })

  test("Quit can retry an owned cleanup failure without losing its owner", async () => {
    let attempts = 0,
      quits = 0
    const coordinator = createQuitCoordinator({
      stop: async () => {
        if (++attempts === 1) throw new Error("owned exit pending")
      },
      quit: () => {
        quits++
      },
      onError() {},
    })
    coordinator.beforeQuit({ preventDefault() {} })
    await coordinator.stop().catch(() => {})
    await Promise.resolve()
    coordinator.beforeQuit({ preventDefault() {} })
    await coordinator.stop()
    await Promise.resolve()
    expect(attempts).toBe(2)
    expect(quits).toBe(1)
  })

  test("a graceful owned child exit is awaited without killing", async () => {
    const exit = deferred()
    let requests = 0,
      kills = 0,
      finished = false
    const stop = createOwnedProcessStop({
      exited: () => false,
      exit: exit.promise,
      requestStop: () => {
        requests++
      },
      kill: () => {
        kills++
      },
    })
    const first = stop()
    expect(stop()).toBe(first)
    void first.then(() => {
      finished = true
    })
    await Promise.resolve()
    expect(finished).toBe(false)
    expect(requests).toBe(1)
    exit.resolve()
    await first
    expect(kills).toBe(0)
  })

  test("a stalled child is killed once and shutdown still waits for its exit", async () => {
    const exit = deferred(),
      killed = deferred()
    let kills = 0,
      finished = false
    const stop = createOwnedProcessStop({
      exited: () => false,
      exit: exit.promise,
      requestStop() {},
      kill: () => {
        kills++
        killed.resolve()
      },
      graceMs: 5,
      killWaitMs: 1000,
    })
    const result = stop().then(() => {
      finished = true
    })
    await killed.promise
    expect(kills).toBe(1)
    expect(finished).toBe(false)
    exit.resolve()
    await result
  })

  test("missing exit after the captured-child kill fails rather than allowing an orphan claim", async () => {
    const stop = createOwnedProcessStop({
      exited: () => false,
      exit: new Promise(() => {}),
      requestStop() {},
      kill() {},
      graceMs: 1,
      killWaitMs: 1,
    })
    await expect(stop()).rejects.toThrow("did not exit")
  })

  test("stop during backend construction waits for the returned listener and closes sockets once", async () => {
    const constructed = deferred(),
      closed = deferred()
    let closes = 0
    const owner = createSidecarOwner()
    const start = owner.start(async () => {
      await constructed.promise
      return {
        stop: async (force?: boolean) => {
          expect(force).toBe(true)
          closes++
          await closed.promise
        },
      }
    })
    let finished = false
    const stop = owner.stop()
    expect(owner.stop()).toBe(stop)
    void stop.then(() => {
      finished = true
    })
    constructed.resolve()
    await start
    await Promise.resolve()
    expect(owner.stopping).toBe(true)
    expect(closes).toBe(1)
    expect(finished).toBe(false)
    closed.resolve()
    await stop
    await expect(owner.start(async () => ({ stop() {} }))).rejects.toThrow("already stopping")
  })
})
