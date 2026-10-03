import { clearTimeout, setTimeout } from "node:timers"

export class TimelineDeadlineError extends Error {
  constructor(label: string, timeoutMs: number) {
    super(`${label} exceeded ${timeoutMs}ms (host deadline)`)
    this.name = "TimelineDeadlineError"
  }
}

// Keep the deadline outside Chromium so a busy renderer cannot delay diagnostics.
// The caller owns cancellation or teardown of the underlying operation.
export async function withTimelineDeadline<T>(operation: Promise<T>, label: string, timeoutMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new TimelineDeadlineError(label, timeoutMs)), timeoutMs)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
