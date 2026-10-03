import { expect, test } from "bun:test"
import type { Message, ArforgeClient, Part, Session } from "@arforge-ai/sdk/v2/client"
import { createServerSession } from "../src/context/server-session"

test("replaces the cached window with a dense smaller page on an explicit refresh", async () => {
  const session: Session = {
    id: "child",
    slug: "child",
    projectID: "project",
    directory: "/repo",
    title: "child",
    version: "1",
    parentID: "root",
    time: { created: 1, updated: 1 },
  }
  const items = Array.from({ length: 25 }, (_, index): { info: Message; parts: Part[] } => ({
    info: {
      id: `message-${String(index).padStart(3, "0")}`,
      sessionID: "child",
      role: "user",
      time: { created: index + 1 },
      agent: "build",
      model: { providerID: "provider", modelID: "model" },
    },
    parts: [],
  }))
  const pages = [items, items.slice(-7)]
  const requests: unknown[] = []
  const client = {
    session: {
      get: async () => ({ data: session }),
      messages: async (input: unknown) => {
        requests.push(input)
        return { data: pages[requests.length - 1], response: { headers: new Headers() } }
      },
    },
  } as unknown as ArforgeClient
  const store = createServerSession(client)

  await store.sync("child", { messageLimit: 25 })
  expect(store.data.message.child).toHaveLength(25)

  await store.sync("child", { force: true, messageLimit: 7 })

  expect(requests).toEqual([
    { sessionID: "child", limit: 25, before: undefined },
    { sessionID: "child", limit: 7, before: undefined },
  ])
  expect(store.data.message.child).toHaveLength(7)
  expect(Array.from(store.data.message.child, (message) => message?.id)).toEqual(
    items.slice(-7).map((item) => item.info.id),
  )
})
