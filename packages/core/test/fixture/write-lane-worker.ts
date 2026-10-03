import { writeFile } from "node:fs/promises"
import { withWriteLane } from "@arforge-ai/core/runtime/write-conflict-control"

const [lockDirectory, workspace, acquiredMarker, releasedMarker] = Bun.argv.slice(2)
if (!lockDirectory || !workspace || !acquiredMarker || !releasedMarker) throw new Error("missing write-lane fixture input")

await withWriteLane(
  {
    parentRunID: "fixture-parent",
    childRunID: "fixture-child",
    nodeID: "fixture-node",
    ownerID: `fixture-${process.pid}`,
    workspace,
    access: "write",
    isolation: "workspace-exclusive",
  },
  new AbortController().signal,
  async () => {
    await writeFile(acquiredMarker, "acquired", { flag: "wx" })
    await Bun.sleep(250)
    await writeFile(releasedMarker, "released", { flag: "wx" })
  },
  { lockDirectory },
)
