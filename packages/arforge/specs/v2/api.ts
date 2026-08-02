// @ts-nocheck

import { Arforge } from "@arforge-ai/core"
import { ReadTool } from "@arforge-ai/core/tools"

const arforge = Arforge.make({})

arforge.tool.add(ReadTool)

arforge.tool.add({
  name: "bash",
  schema: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "The command to run.",
      },
    },
    required: ["command"],
  },
  execute(input, ctx) {},
})

arforge.auth.add({
  provider: "openai",
  type: "api",
  value: process.env.OPENAI_API_KEY,
})

arforge.agent.add({
  name: "build",
  permissions: [],
  model: {
    id: "gpt-5-5",
    provider: "openai",
    variant: "xhigh",
  },
})

const sessionID = await arforge.session.create({
  agent: "build",
})

arforge.subscribe((event) => {
  console.log(event)
})

await arforge.session.prompt({
  sessionID,
  text: "hey what is up",
})

await arforge.session.prompt({
  sessionID,
  text: "what is up with this",
  files: [
    {
      mime: "image/png",
      uri: "data:image/png;base64,xxxx",
    },
  ],
})

await arforge.session.wait()

console.log(await arforge.session.messages(sessionID))
