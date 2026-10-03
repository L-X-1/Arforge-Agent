import { expect, test } from "bun:test"
import { ChildProcess } from "effect/unstable/process"
import { allowlistedChildEnvironment } from "@arforge-ai/core/secret-environment"
import { SandboxRunner } from "../../src/sandbox/runner"
import { tmpdir } from "../fixture/fixture"

test.skipIf(process.platform !== "win32")(
  "selected native backend preserves stdin, stdout, stderr and exit code",
  async () => {
    await using tmp = await tmpdir()
    const backend = SandboxRunner.detectBackend()
    expect(backend.kind).toBe("windows-native")
    const command = SandboxRunner.prepareCommand(
      ChildProcess.make(process.execPath, [
        "-e",
        'const input = await Bun.stdin.text(); process.stdout.write("out:" + input); process.stderr.write("err:" + input); process.exitCode = 23',
      ]),
      { profile: "workspace-write", network: "inherit", workspace: tmp.path, cwd: tmp.path, roots: [tmp.path] },
      backend,
    )
    const child = Bun.spawn([command.command, ...command.args], {
      cwd: tmp.path,
      env: allowlistedChildEnvironment(process.env),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
    const timer = setTimeout(() => child.kill(), 10_000)
    try {
      child.stdin.write("fixture input 两个词\n")
      child.stdin.end()
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      expect({ code, stdout, stderr }).toEqual({
        code: 23,
        stdout: "out:fixture input 两个词\n",
        stderr: "err:fixture input 两个词\n",
      })
    } finally {
      clearTimeout(timer)
      child.kill()
      await child.exited
    }
  },
)
