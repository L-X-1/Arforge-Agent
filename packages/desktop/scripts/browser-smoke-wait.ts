import type { EventEmitter } from "node:events"

type SmokeEventOptions = {
  label: string
  timeoutMs?: number
  action?: () => unknown
  failureEvents?: readonly string[]
}

// Register before invoking the action, and bound both its promise and the event.
export function waitForSmokeEvent(
  emitter: Pick<EventEmitter, "on" | "removeListener">,
  eventName: string,
  { label, timeoutMs = 8_000, action, failureEvents = [] }: SmokeEventOptions,
): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    let settled = false
    let actionDone = !action
    let values: unknown[] | undefined
    const cleanup = () => {
      clearTimeout(timer)
      emitter.removeListener(eventName, onEvent)
      for (const [name, handler] of failures) emitter.removeListener(name, handler)
    }
    const fail = (error: unknown) => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }
    const complete = () => {
      if (settled || !actionDone || !values) return
      settled = true
      cleanup()
      resolve(values)
    }
    const onEvent = (...args: unknown[]) => {
      values ??= args
      complete()
    }
    const failures = failureEvents.map((name) => [
      name, () => fail(new Error("[" + label + "] Received " + name + " while waiting for " + eventName)),
    ] as const)
    const timer = setTimeout(
      () => fail(new Error("[" + label + "] Timed out waiting for " + eventName + " and its action")),
      timeoutMs,
    )
    emitter.on(eventName, onEvent)
    for (const [name, handler] of failures) emitter.on(name, handler)
    if (action) {
      try {
        Promise.resolve(action()).then(() => { actionDone = true; complete() }, fail)
      } catch (error) { fail(error) }
    }
  })
}
