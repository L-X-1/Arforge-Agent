import { afterEach, describe, expect, test } from "bun:test"
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import {
  defaultPythonHome,
  MANAGEMENT_METHODS,
  PythonBridgeClient,
  PythonBridgeError,
  READ_ONLY_METHODS,
} from "../src"

const root = resolve(import.meta.dir, "../../..")
const python = join(root, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python")
const clients: PythonBridgeClient[] = []
const homes: string[] = []

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()))
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })))
})

describe("PythonBridgeClient", () => {
  test("calls the real Bridge 1.2 read-only capability surface", async () => {
    await access(python)
    const home = await mkdtemp(join(tmpdir(), "arforge-agent-python-"))
    homes.push(home)
    const client = new PythonBridgeClient({
      workspace: root,
      pythonExecutable: python,
      home,
      requestTimeoutMs: 20_000,
    })
    clients.push(client)

    const health = await client.call<{ status: string; brand: string; python_supported: boolean }>("health")
    expect(health.status).toBe("ok")
    expect(health.brand).toBe("Arforge Agent")
    expect(health.python_supported).toBe(true)

    const capabilities = await client.call<{ count: number; items: unknown[] }>("capabilities.list")
    expect(Array.isArray(capabilities.items)).toBe(true)
    expect(capabilities.count).toBe(capabilities.items.length)
    expect(capabilities.items.length).toBeGreaterThan(0)

    const protocol = await client.call<{ methods: string[]; stateful_methods: string[] }>("protocol.describe")
    const stateful = new Set(protocol.stateful_methods)
    const pythonReadOnly = protocol.methods.filter((method) => method === "protocol.describe" || !stateful.has(method))
    const typescriptReadOnly: string[] = [...READ_ONLY_METHODS]
    expect(typescriptReadOnly.sort()).toEqual(pythonReadOnly.sort())
    for (const method of MANAGEMENT_METHODS) expect(stateful.has(method)).toBe(true)
    expect(protocol.methods).not.toContain("session.create")
    expect(protocol.methods).not.toContain("goal.create")

    const quality = await client.call<{
      passed: boolean
      score: number
      files_checked: number
    }>("quality.assess", { files: ["package.json"] })
    expect(quality.passed).toBe(true)
    expect(quality.score).toBeGreaterThanOrEqual(70)
    expect(quality.files_checked).toBe(1)
  }, 30_000)

  test("keeps Python profile state outside the selected workspace by default", () => {
    const userHome = join(tmpdir(), "arforge-private-profile")
    expect(defaultPythonHome(userHome)).toBe(join(userHome, ".arforge"))
  })

  test("rejects methods outside the read-only capability boundary", async () => {
    const client = new PythonBridgeClient({ workspace: root, pythonExecutable: python })
    clients.push(client)
    await expect(client.call("session.create")).rejects.toMatchObject({
      code: "METHOD_NOT_ALLOWED",
    } satisfies Partial<PythonBridgeError>)
  })

  test("allows only explicitly declared management methods through the mutation boundary", async () => {
    await access(python)
    const home = await mkdtemp(join(tmpdir(), "arforge-agent-python-"))
    homes.push(home)
    const client = new PythonBridgeClient({
      workspace: root,
      pythonExecutable: python,
      home,
      requestTimeoutMs: 20_000,
    })
    clients.push(client)

    const disabled = await client.mutate<{ skill_id: string; enabled: boolean }>("skills.disable", {
      skill_id: "openspec",
    })
    expect(disabled).toMatchObject({ skill_id: "openspec", enabled: false })
    const enabled = await client.mutate<{ skill_id: string; enabled: boolean }>("skills.enable", {
      skill_id: "openspec",
    })
    expect(enabled).toMatchObject({ skill_id: "openspec", enabled: true })
    await expect(client.mutate("session.create")).rejects.toMatchObject({
      code: "METHOD_NOT_ALLOWED",
    } satisfies Partial<PythonBridgeError>)
  }, 30_000)

  test("separates the product runtime from the selected workspace", async () => {
    await access(python)
    const workspace = await mkdtemp(join(tmpdir(), "arforge-agent-workspace-"))
    const home = await mkdtemp(join(tmpdir(), "arforge-agent-python-home-"))
    homes.push(workspace, home)
    const client = new PythonBridgeClient({
      runtimeRoot: root,
      workspace,
      pythonExecutable: python,
      home,
    })
    clients.push(client)

    const selected = await client.call<{ root: string }>("workspace.get")
    expect(resolve(selected.root)).toBe(resolve(workspace))
  }, 30_000)

  test("starts request timeouts when serial execution begins rather than while queued", async () => {
    await access(python)
    const workspace = await mkdtemp(join(tmpdir(), "arforge-agent-queue-workspace-"))
    const home = await mkdtemp(join(tmpdir(), "arforge-agent-queue-home-"))
    homes.push(workspace, home)
    const moduleRoot = join(workspace, "arforge")
    await mkdir(moduleRoot)
    await writeFile(join(moduleRoot, "__init__.py"), "", "utf8")
    await writeFile(
      join(moduleRoot, "bridge.py"),
      [
        "import json",
        "import sys",
        "import time",
        "for line in sys.stdin:",
        "    request = json.loads(line)",
        "    time.sleep(0.45)",
        "    response = {",
        "        'protocol': 'arforge.bridge',",
        "        'version': request['version'],",
        "        'id': request['id'],",
        "        'ok': True,",
        "        'data': {",
        "            'status': 'ok',",
        "            'brand': 'Arforge Agent',",
        "            'version': 'test',",
        "            'python': sys.version.split()[0],",
        "            'python_supported': True,",
        "        },",
        "    }",
        "    print(json.dumps(response, separators=(',', ':')), flush=True)",
      ].join("\n"),
      "utf8",
    )

    const client = new PythonBridgeClient({
      runtimeRoot: root,
      workspace,
      pythonExecutable: python,
      home,
    })
    clients.push(client)

    const [first, second] = await Promise.all([
      client.call<{ status: string }>("health", {}, { timeoutMs: 700 }),
      client.call<{ status: string }>("health", {}, { timeoutMs: 700 }),
    ])
    expect(first.status).toBe("ok")
    expect(second.status).toBe("ok")
  }, 10_000)

  test("recycles the serial Bridge after an in-flight request times out", async () => {
    await access(python)
    const workspace = await mkdtemp(join(tmpdir(), "arforge-agent-timeout-workspace-"))
    const home = await mkdtemp(join(tmpdir(), "arforge-agent-timeout-home-"))
    homes.push(workspace, home)
    const moduleRoot = join(workspace, "arforge")
    const marker = join(workspace, "first-request-started")
    await mkdir(moduleRoot)
    await writeFile(join(moduleRoot, "__init__.py"), "", "utf8")
    await writeFile(
      join(moduleRoot, "bridge.py"),
      [
        "import json",
        "import os",
        "import sys",
        "import time",
        "from pathlib import Path",
        "marker = Path(os.environ['ARFORGE_FAKE_BRIDGE_MARKER'])",
        "for line in sys.stdin:",
        "    request = json.loads(line)",
        "    if not marker.exists():",
        "        marker.write_text('started', encoding='utf-8')",
        "        time.sleep(60)",
        "    response = {",
        "        'protocol': 'arforge.bridge',",
        "        'version': request['version'],",
        "        'id': request['id'],",
        "        'ok': True,",
        "        'data': {",
        "            'status': 'ok',",
        "            'brand': 'Arforge Agent',",
        "            'version': 'test',",
        "            'python': sys.version.split()[0],",
        "            'python_supported': True,",
        "        },",
        "    }",
        "    print(json.dumps(response, separators=(',', ':')), flush=True)",
      ].join("\n"),
      "utf8",
    )

    const client = new PythonBridgeClient({
      runtimeRoot: root,
      workspace,
      pythonExecutable: python,
      home,
      env: { ARFORGE_FAKE_BRIDGE_MARKER: marker },
    })
    clients.push(client)

    await expect(client.call("health", {}, { timeoutMs: 1_000 })).rejects.toMatchObject({
      code: "REQUEST_TIMEOUT",
    } satisfies Partial<PythonBridgeError>)
    expect(client.running).toBe(false)

    const recovered = await client.call<{ status: string }>("health", {}, { timeoutMs: 5_000 })
    expect(recovered.status).toBe("ok")
  }, 15_000)
})
