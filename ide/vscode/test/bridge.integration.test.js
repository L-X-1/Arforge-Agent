"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { JsonlBridge } = require("../bridgeClient");

test("connects to the real Arforge bridge and creates a session", async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "arforge-vscode-test-"));
  const workspace = path.resolve(__dirname, "..", "..", "..");
  const bridge = new JsonlBridge({ requestTimeoutMs: 30000 });
  try {
    await bridge.start({
      command: "python",
      args: ["-m", "arforge.bridge"],
      cwd: workspace,
      env: {
        ARFORGE_HOME: profile,
        ARFORGE_WORKSPACE: workspace,
        ARFORGE_DB_URL: `sqlite:///${path.join(profile, "main.db").replaceAll("\\", "/")}`,
        ARFORGE_MULTIAGENT_DB_URL: `sqlite:///${path.join(profile, "multi.db").replaceAll("\\", "/")}`,
        PYTHONUTF8: "1"
      }
    });
    const health = await bridge.request("health", {});
    const session = await bridge.request("session.create", {});
    const resumed = await bridge.request("session.resume", {
      session_id: session.session_id
    });
    const changes = await bridge.request("git.diff", { max_chars: 10000 });
    assert.equal(health.status, "ok");
    assert.equal(typeof session.session_id, "string");
    assert.ok(session.session_id.length > 0);
    assert.equal(resumed.session_id, session.session_id);
    assert.equal(typeof changes.root, "string");
    assert.ok(changes.root.length > 0);
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
