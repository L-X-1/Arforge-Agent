"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const { JsonlBridge } = require("../bridgeClient");

function fakeProcess(onRequest) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = () => { child.killed = true; child.emit("exit", 0); };
  let buffer = "";
  child.stdin.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    while (buffer.includes("\n")) {
      const index = buffer.indexOf("\n");
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (line) onRequest(JSON.parse(line), child);
    }
  });
  return child;
}

test("starts with health handshake and correlates responses", async () => {
  const child = fakeProcess((request, process) => {
    process.stdout.write(`${JSON.stringify({
      protocol: "arforge.bridge",
      version: "1.2",
      id: request.id,
      ok: true,
      data: { method: request.method }
    })}\n`);
  });
  const bridge = new JsonlBridge({ spawnProcess: () => child });
  await bridge.start({ command: "python", args: [], cwd: "." });
  const result = await bridge.request("status.get", {});
  assert.equal(result.method, "status.get");
  bridge.stop();
});

test("delivers versioned events without consuming pending requests", async () => {
  let requestCount = 0;
  const child = fakeProcess((request, process) => {
    requestCount += 1;
    if (requestCount === 2) {
      process.stdout.write(`${JSON.stringify({
        protocol: "arforge.bridge", version: "1.2", event: true,
        type: "answer.delta", operation_id: "o1", session_id: "s1",
        sequence: 1, data: { content: "hello" }
      })}\n`);
    }
    process.stdout.write(`${JSON.stringify({
      protocol: "arforge.bridge", version: "1.2", id: request.id,
      ok: true, data: {}
    })}\n`);
  });
  const bridge = new JsonlBridge({ spawnProcess: () => child });
  const events = [];
  bridge.on("event", (event) => events.push(event));
  await bridge.start({ command: "python", cwd: "." });
  await bridge.request("chat.start", {});
  assert.equal(events.length, 1);
  assert.equal(events[0].data.content, "hello");
  bridge.stop();
});

test("rejects protocol mismatch and bridge exit", async () => {
  let count = 0;
  const child = fakeProcess((request, process) => {
    count += 1;
    process.stdout.write(`${JSON.stringify({
      protocol: count === 1 ? "arforge.bridge" : "wrong",
      version: "1.2", id: request.id, ok: true, data: {}
    })}\n`);
  });
  const bridge = new JsonlBridge({ spawnProcess: () => child });
  await bridge.start({ command: "python", cwd: "." });
  await assert.rejects(
    bridge.request("status.get", {}),
    (error) => error.code === "INVALID_RESPONSE"
  );
  bridge.stop();
});
