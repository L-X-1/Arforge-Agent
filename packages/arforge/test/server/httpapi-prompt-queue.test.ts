import { afterEach, describe, expect, test } from "bun:test"
import { Context } from "effect"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"

const context = Context.empty() as Context.Context<unknown>

function request(route: string, directory: string, init?: RequestInit) {
  return HttpApiApp.webHandler().handler(
    new Request(`http://localhost${route}`, {
      ...init,
      headers: {
        ...Object.fromEntries(new Headers(init?.headers).entries()),
        "content-type": "application/json",
        "x-arforge-directory": directory,
      },
    }),
    context,
  )
}

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("durable prompt queue HttpApi", () => {
  test("shares FIFO list, update, and remove state through the Server contract", async () => {
    await using workspace = await tmpdir()
    const sessionID = "ses_prompt_queue_http"
    const messageID = "msg_prompt_queue_http"

    const created = await request("/api/session", workspace.path, {
      method: "POST",
      body: JSON.stringify({
        id: sessionID,
        location: { directory: workspace.path },
      }),
    })
    expect(created.status).toBe(200)

    const admittedResponse = await request(`/api/session/${sessionID}/prompt`, workspace.path, {
      method: "POST",
      body: JSON.stringify({
        id: messageID,
        prompt: { text: "queued from desktop" },
        delivery: "queue",
        resume: false,
      }),
    })
    expect(admittedResponse.status).toBe(200)
    const admitted = (await admittedResponse.json()) as { data: { admittedSeq: number } }

    const listed = await request(`/api/session/${sessionID}/prompt/queue`, workspace.path)
    expect(listed.status).toBe(200)
    expect(await listed.json()).toMatchObject({
      data: [
        {
          id: messageID,
          delivery: "queue",
          prompt: { text: "queued from desktop" },
        },
      ],
    })

    const updated = await request(`/api/session/${sessionID}/prompt/queue/${messageID}`, workspace.path, {
      method: "PATCH",
      body: JSON.stringify({
        expectedAdmittedSeq: admitted.data.admittedSeq,
        prompt: { text: "edited durable prompt" },
      }),
    })
    expect(updated.status).toBe(200)
    expect(await updated.json()).toMatchObject({
      data: { id: messageID, prompt: { text: "edited durable prompt" } },
    })

    const removed = await request(`/api/session/${sessionID}/prompt/queue/${messageID}`, workspace.path, {
      method: "DELETE",
      body: JSON.stringify({ expectedAdmittedSeq: admitted.data.admittedSeq }),
    })
    expect(removed.status).toBe(204)

    const empty = await request(`/api/session/${sessionID}/prompt/queue`, workspace.path)
    expect(await empty.json()).toEqual({ data: [] })

    const repeated = await request(`/api/session/${sessionID}/prompt/queue/${messageID}`, workspace.path, {
      method: "DELETE",
      body: JSON.stringify({ expectedAdmittedSeq: admitted.data.admittedSeq }),
    })
    expect(repeated.status).toBe(404)
  }, 30_000)
})
