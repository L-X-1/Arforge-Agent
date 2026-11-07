import { expect, test } from "bun:test"
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { isAbsolute, join, relative, resolve } from "node:path"
import { tmpdir } from "node:os"

test("standard Node server entry boots its real graph, serves health/provider capability, and releases its listener", async () => {
  const packageRoot = resolve(import.meta.dir, "../..")
  // Resolve the canonical externals from Core, which declares node-pty and
  // jsonc-parser. No dependency copies, installs, aliases or service replacements.
  // This is a fresh test-only bundle, never an existing Native artifact.
  const outputBase = resolve(packageRoot, "../core")
  const output = await mkdtemp(join(outputBase, ".node-provider-startup-"))
  const owned = await mkdtemp(join(tmpdir(), "arforge-node-provider-startup-"))
  const workspace = join(owned, "workspace")
  let child: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined
  try {
    await mkdir(workspace)
    await writeFile(
      join(workspace, "ARFORGE.md"),
      "# Owned Node startup regression\nNo external services or user profile.\n",
    )
    const result = await Bun.build({
      target: "node",
      entrypoints: [join(packageRoot, "src/node.ts")],
      outdir: output,
      format: "esm",
      external: ["jsonc-parser", "@lydell/node-pty"],
      files: { "arforge-web-ui.gen.ts": "" },
    })
    if (!result.success) throw new AggregateError(result.logs, "Fresh standard Node entry could not compile")
    const runner = join(output, "startup.mjs")
    await writeFile(
      runner,
      `
import assert from 'node:assert/strict';
import { connect } from 'node:net';
assert.equal(typeof globalThis.Bun, 'undefined');
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, options) => {
  const url = new URL(input instanceof Request ? input.url : input);
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'External request forbidden in owned startup test');
  return originalFetch(input, options);
};
const { Server } = await import('./node.js');
const listener = await Server.listen({ hostname: '127.0.0.1', port: 0, mdns: false });
try {
  const health = await fetch(new URL('/api/health', listener.url));
  assert.equal(health.status, 200);
  assert.equal((await health.json()).healthy, true);
  const path = new URL('/api/provider/configuration/capability', listener.url);
  path.searchParams.set('location[directory]', process.cwd());
  const capability = await fetch(path);
  assert.equal(capability.status, 200);
  assert.equal((await capability.json()).data.canWrite, true);
  console.log('standard-node-provider-startup-ready');
} finally { await listener.stop(true); }
const closed = await new Promise(resolve => {
  const socket = connect({ host: '127.0.0.1', port: listener.port });
  socket.once('connect', () => { socket.destroy(); resolve(false); });
  socket.once('error', () => resolve(true));
});
assert.equal(closed, true);
console.log('standard-node-provider-startup-closed');
process.exit(0);
`,
    )
    const environment: Record<string, string> = {}
    for (const key of [
      "SystemRoot",
      "WINDIR",
      "PATH",
      "PATHEXT",
      "COMSPEC",
      "NUMBER_OF_PROCESSORS",
      "PROCESSOR_ARCHITECTURE",
    ])
      if (process.env[key]) environment[key] = process.env[key]!
    Object.assign(environment, {
      NODE_ENV: "production",
      ARFORGE_DATABASE_MODE: "local",
      ARFORGE_DB: join(owned, "owned.db"),
      ARFORGE_HOME: join(owned, "profile"),
      ARFORGE_TEST_HOME: join(owned, "home"),
      HOME: join(owned, "home"),
      USERPROFILE: join(owned, "home"),
      ARFORGE_TEST_MANAGED_CONFIG_DIR: join(owned, "managed"),
      ARFORGE_AUTH_MODE: "private",
      ARFORGE_DISABLE_MODELS_FETCH: "1",
      ARFORGE_DISABLE_AUTOUPDATE: "1",
      ARFORGE_DISABLE_PRUNE: "1",
      APPDATA: join(owned, "roaming"),
      LOCALAPPDATA: join(owned, "local"),
      XDG_DATA_HOME: join(owned, "xdg/data"),
      XDG_CONFIG_HOME: join(owned, "xdg/config"),
      XDG_CACHE_HOME: join(owned, "xdg/cache"),
      XDG_STATE_HOME: join(owned, "xdg/state"),
      TEMP: join(owned, "tmp"),
      TMP: join(owned, "tmp"),
      npm_config_offline: "true",
      npm_config_ignore_scripts: "true",
    })
    await mkdir(environment.TEMP!, { recursive: true })
    await mkdir(environment.HOME!, { recursive: true })
    child = Bun.spawn(["node", runner], { cwd: workspace, env: environment, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
    const timer = setTimeout(() => child?.kill(), 45_000)
    try {
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      if (code !== 0) throw new Error(`Standard Node entry failed (${code}): ${(stderr || stdout).slice(-12000)}`)
      expect(stdout).toContain("standard-node-provider-startup-ready")
      expect(stdout).toContain("standard-node-provider-startup-closed")
    } finally {
      clearTimeout(timer)
    }
  } finally {
    if (child?.exitCode === null) {
      child.kill()
      await child.exited
    }
    for (const [base, target, prefix] of [
      [outputBase, output, ".node-provider-startup-"],
      [tmpdir(), owned, "arforge-node-provider-startup-"],
    ] as const) {
      const rel = relative(resolve(base), resolve(target))
      if (!rel || rel.startsWith("..") || isAbsolute(rel) || !rel.startsWith(prefix))
        throw new Error("Unsafe owned startup cleanup")
      await rm(target, { recursive: true, force: true })
    }
  }
}, 90_000)
