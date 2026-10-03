"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { JsonlBridge } = require("../bridgeClient");

test("connects to the real Arforge bridge and creates a session", async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "arforge-vscode-test-"));
  const repository = path.resolve(__dirname, "..", "..", "..");
  const workspace = path.join(profile, "workspace");
  fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, "tracked.txt"), "before\n");
  const git = (...args) => execFileSync("git", args, { cwd: workspace, stdio: "ignore" });
  git("init");
  git("config", "user.email", "test@arforge.local");
  git("config", "user.name", "Arforge Test");
  git("add", "tracked.txt");
  git("commit", "-m", "base");
  fs.writeFileSync(path.join(workspace, "tracked.txt"), "before\nafter\n");
  const bridge = new JsonlBridge({ requestTimeoutMs: 30000 });
  try {
    await bridge.start({
      command: "bun",
      args: ["--conditions=browser", path.join(repository, "packages/arforge/src/index.ts"), "bridge"],
      cwd: workspace,
      env: {
        ARFORGE_HOME: profile,
        ARFORGE_WORKSPACE: workspace,
        ARFORGE_DB_URL: `sqlite:///${path.join(profile, "main.db").replaceAll("\\", "/")}`,
        ARFORGE_MULTIAGENT_DB_URL: `sqlite:///${path.join(profile, "multi.db").replaceAll("\\", "/")}`,
      }
    });
    const description = await bridge.request("protocol.describe", {});
    const health = await bridge.request("health", {});
    const session = await bridge.request("session.create", {});
    const current = await bridge.request("session.get", { session_id: session.session_id });
    const resumed = await bridge.request("session.resume", {
      session_id: session.session_id
    });
    const changes = await bridge.request("git.diff", { max_chars: 10000 });
    assert.equal(description.runtime, "typescript");
    assert.ok(description.methods.includes("chat.start"));
    assert.equal(health.status, "ok");
    assert.equal(typeof session.session_id, "string");
    assert.ok(session.session_id.length > 0);
    assert.equal(current.session_id, session.session_id);
    assert.equal(resumed.session_id, session.session_id);
    assert.equal(typeof changes.root, "string");
    assert.ok(changes.root.length > 0);
    assert.equal(changes.available, true);
    assert.equal(changes.files.length, 1);
    assert.ok(changes.patch.length <= 10000);
  } finally {
    await bridge.stop();
    fs.rmSync(profile, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100
    });
  }
});
