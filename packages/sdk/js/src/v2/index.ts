export * from "./client.js"
export * from "./server.js"

import { createArforgeClient } from "./client.js"
import { createArforgeServer } from "./server.js"
import type { ServerOptions } from "./server.js"

export * as data from "./data.js"

export async function createArforge(options?: ServerOptions) {
  const server = await createArforgeServer({
    ...options,
  })

  const client = createArforgeClient({
    baseUrl: server.url,
  })

  return {
    client,
    server,
  }
}
