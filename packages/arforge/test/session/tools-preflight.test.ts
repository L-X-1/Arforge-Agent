import { describe, expect, test } from "bun:test"
import { mcpServerFor, permissionPreflight } from "@/session/tools"
import path from "node:path"
import os from "node:os"
import { Effect } from "effect"
import { ShellPreflight } from "@/tool/shell"

const workspace = path.join(os.tmpdir(), "arforge-preflight-test")

describe("session tool preflight plans", () => {
  test("binds statically known external-directory scopes for edit", () => {
    const plan = permissionPreflight({
      name: "edit",
      input: { filePath: path.join(workspace, "src/a.ts") },
      workspace,
      locationDirectory: workspace,
      riskTier: "L2",
    })
    expect(plan.requests).toEqual([{ action: "edit", resources: ["src/a.ts"] }])
  })

  test("binds absolute external-directory globs for paths outside the workspace", () => {
    const outside = path.join(os.tmpdir(), "elsewhere/config.json")
    const plan = permissionPreflight({
      name: "write",
      input: { filePath: outside },
      workspace,
      locationDirectory: workspace,
      riskTier: "L2",
    })
    const external = plan.requests.find((request) => request.action === "external_directory")
    expect(external?.resources).toEqual([path.join(path.dirname(outside), "*").replaceAll("\\", "/")])
  })

  test("omits an empty external_directory grant so runtime expansion fails closed", () => {
    const plan = permissionPreflight({
      name: "apply_patch",
      input: {
        patchText: "*** Begin Patch\n*** Update File: src/a.ts\n@@\n*** End Patch",
      },
      workspace,
      locationDirectory: workspace,
      riskTier: "L2",
    })
    expect(plan.requests).toEqual([{ action: "edit", resources: ["src/a.ts"] }])
  })

  test("keeps bash and task plans canonical", () => {
    const bash = permissionPreflight({
      name: "bash",
      input: { command: "npm test && git status" },
      workspace,
      locationDirectory: workspace,
      riskTier: "L3",
    })
    expect(bash.requests).toEqual([{ action: "bash", resources: ["npm test && git status"] }])

    const task = permissionPreflight({
      name: "task",
      input: { subagent_type: "reviewer" },
      workspace,
      locationDirectory: workspace,
      riskTier: "L2",
    })
    expect(task.requests).toEqual([{ action: "task", resources: ["reviewer"] }])
  })

  test("binds every statically determinable external shell directory before approval", async () => {
    const preflight = await Effect.runPromise(
      ShellPreflight.preflight({
        command: "cat ../outside/config.json",
        cwd: workspace,
        instanceDirectory: workspace,
        shell: "bash",
      }),
    )
    expect(preflight.type).toBe("known")
    if (preflight.type !== "known") return

    const plan = permissionPreflight({
      name: "bash",
      input: { command: preflight.command },
      workspace,
      locationDirectory: workspace,
      riskTier: "L3",
      shellPreflight: preflight,
    })
    expect(plan.requests).toContainEqual({ action: "bash", resources: ["cat ../outside/config.json"] })
    expect(plan.requests).toContainEqual({
      action: "external_directory",
      resources: expect.arrayContaining([path.join(os.tmpdir(), "outside", "*")]),
    })
  })

  test("classifies possible shell network effects separately from local-only commands", async () => {
    const local = await Effect.runPromise(
      ShellPreflight.preflight({
        command: "cat README.md",
        cwd: workspace,
        instanceDirectory: workspace,
        shell: "bash",
      }),
    )
    expect(local).toMatchObject({ type: "known", network: "none" })

    const network = await Effect.runPromise(
      ShellPreflight.preflight({ command: "git status", cwd: workspace, instanceDirectory: workspace, shell: "bash" }),
    )
    expect(network).toMatchObject({ type: "known", network: "possible" })
    if (network.type !== "known") return
    const plan = permissionPreflight({
      name: "bash",
      input: { command: network.command },
      workspace,
      locationDirectory: workspace,
      riskTier: "L3",
      shellPreflight: network,
    })
    expect(plan.requests).toContainEqual({
      action: "bash",
      resources: ["git status", "process:git status"],
    })
  })

  test("fails closed for redirects, pipelines, and substitutions rather than claiming shell containment", async () => {
    for (const command of [
      "echo data > ../outside/output.txt",
      "cat ../outside/input.txt | tee output.txt",
      "echo $(cat x)",
    ]) {
      const preflight = await Effect.runPromise(
        ShellPreflight.preflight({ command, cwd: workspace, instanceDirectory: workspace, shell: "bash" }),
      )
      expect(preflight).toMatchObject({ type: "unknown", command })
    }
  })

  test("does not classify PowerShell or cmd as sandboxed Bash", async () => {
    for (const shell of ["powershell", "cmd"]) {
      const preflight = await Effect.runPromise(
        ShellPreflight.preflight({ command: "Get-Content x", cwd: workspace, instanceDirectory: workspace, shell }),
      )
      expect(preflight).toMatchObject({ type: "unknown" })
    }
  })

  test("mcpServerFor resolves the longest matching native server name", () => {
    expect(mcpServerFor("github_list_issues", ["github", "linear"])).toBe("github")
    expect(mcpServerFor("my_server_do_thing", ["my_server", "my"])).toBe("my_server")
    expect(mcpServerFor("standalone_tool", [])).toBe("standalone")
  })
})
