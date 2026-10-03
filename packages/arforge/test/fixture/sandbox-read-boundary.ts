import path from "node:path"
import { Effect } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { SandboxRunner } from "../../src/sandbox/runner"

const [workspace, library] = process.argv.slice(2)
if (!workspace || !library) throw new Error("owned workspace and library fixture paths required")

const result = await Effect.runPromise(
  Effect.gen(function* () {
    const runner = yield* SandboxRunner.Service
    const results = []
    for (const readOnlyRoots of [undefined, [], [library]]) {
      results.push(
        yield* runner
          .prepare({
            command: ChildProcess.make(process.execPath, [
              "-e",
              `require('node:fs').writeFileSync(${JSON.stringify(path.join(library, "unexpected.txt"))}, 'spawned')`,
            ]),
            workspace,
            cwd: workspace,
            profile: "workspace-write",
            readOnlyRoots,
          })
          .pipe(
            Effect.match({
              onFailure: (error) => ({ status: "rejected", tag: error._tag, message: error.message }),
              onSuccess: ({ report }) => ({ status: "prepared", enforcement: report.enforcement }),
            }),
          ),
      )
    }
    return { backend: runner.backend().kind, results }
  }).pipe(Effect.provide(LayerNode.compile(SandboxRunner.node))),
)
process.stdout.write(JSON.stringify(result))
