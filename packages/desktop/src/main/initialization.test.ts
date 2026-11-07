import { expect, test } from "bun:test"
import { readyLocalServer } from "./initialization"

test("initialization data cannot escape before actual backend health", async () => {
  let healthy!: () => void
  let published = false
  const health = new Promise<void>((resolve) => {
    healthy = resolve
  })
  const data = { url: "http://127.0.0.1:43210" }
  const initialized = readyLocalServer({ listener: { stop: async () => {} }, health: { wait: health } }, data).then(
    (value) => {
      published = true
      return value
    },
  )
  await Promise.resolve()
  expect(published).toBe(false)
  healthy()
  expect(await initialized).toBe(data)
})

test("health failure stops its owned backend and propagates the real startup failure", async () => {
  const failure = new Error("actual health 503")
  let stopped = false
  await expect(
    readyLocalServer(
      {
        listener: {
          stop: async () => {
            stopped = true
          },
        },
        health: { wait: Promise.reject(failure) },
      },
      { url: "unused" },
    ),
  ).rejects.toBe(failure)
  expect(stopped).toBe(true)
})
