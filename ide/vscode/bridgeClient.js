"use strict";

const { EventEmitter } = require("node:events");
const { spawn } = require("node:child_process");
const readline = require("node:readline");

const PROTOCOL = "arforge.bridge";
const VERSION = "1.2";
const MAX_REQUEST_BYTES = 1024 * 1024;
const REQUIRED_METHODS = [
  "protocol.describe",
  "health",
  "workspace.get",
  "session.create",
  "session.resume",
  "chat.start",
  "chat.cancel",
  "git.diff"
];

class BridgeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "BridgeError";
    this.code = code;
  }
}

class JsonlBridge extends EventEmitter {
  constructor(options = {}) {
    super();
    this.spawnProcess = options.spawnProcess || spawn;
    this.requestTimeoutMs = options.requestTimeoutMs || 30000;
    this.child = null;
    this.pending = new Map();
    this.nextId = 1;
    this.stderr = [];
    this.methods = null;
  }

  get running() {
    return Boolean(this.child && !this.child.killed);
  }

  async start({ command, args = [], cwd, env = {} }) {
    if (this.running) return;
    const child = this.spawnProcess(command, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      shell: false
    });
    this.child = child;
    this.stderr = [];
    readline.createInterface({ input: child.stdout }).on("line", (line) => {
      this._handleLine(line);
    });
    readline.createInterface({ input: child.stderr }).on("line", (line) => {
      this.stderr.push(String(line).slice(0, 1000));
      if (this.stderr.length > 20) this.stderr.shift();
    });
    child.once("error", (error) => this._close("BRIDGE_START_FAILED", error.message));
    child.once("exit", (code) => {
      const diagnostic = this.stderr.join("\n").trim();
      this._close(
        "BRIDGE_EXITED",
        diagnostic || `Arforge Bridge 已退出（code ${String(code)}）`
      );
    });
    try {
      const description = await this.request("protocol.describe", {}, 10000);
      const advertised = Array.isArray(description?.methods)
        ? new Set(description.methods.filter((method) => typeof method === "string"))
        : new Set();
      const missing = REQUIRED_METHODS.filter((method) => !advertised.has(method));
      if (
        !description ||
        description.runtime !== "typescript" ||
        description.protocol !== PROTOCOL ||
        missing.length > 0
      ) {
        throw new BridgeError(
          missing.length > 0 ? "BRIDGE_CAPABILITIES_UNSUPPORTED" : "BRIDGE_RUNTIME_UNSUPPORTED",
          missing.length > 0
            ? `Arforge Bridge 缺少必需能力：${missing.join(", ")}`
            : "Arforge Bridge 不是受支持的 TypeScript 运行时"
        );
      }
      this.methods = advertised;
      const health = await this.request("health", {}, 10000);
      if (!health || health.runtime !== "typescript" || health.status !== "ok") {
        throw new BridgeError(
          "BRIDGE_RUNTIME_UNSUPPORTED",
          "Arforge Bridge 健康检查未确认 TypeScript 运行时"
        );
      }
      return health;
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  request(method, params = {}, timeoutMs = this.requestTimeoutMs) {
    if (!this.child || !this.child.stdin || this.child.killed) {
      return Promise.reject(new BridgeError("BRIDGE_UNAVAILABLE", "Arforge Bridge 未运行"));
    }
    if (this.methods && !this.methods.has(method)) {
      return Promise.reject(
        new BridgeError("BRIDGE_METHOD_UNAVAILABLE", `当前 Bridge 未宣布能力：${method}`)
      );
    }
    const id = this.nextId++;
    const request = { protocol: PROTOCOL, version: VERSION, id, method, params };
    const encoded = Buffer.from(`${JSON.stringify(request)}\n`, "utf8");
    if (encoded.length > MAX_REQUEST_BYTES) {
      return Promise.reject(new BridgeError("REQUEST_TOO_LARGE", "Bridge 请求超过 1 MiB"));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BridgeError("BRIDGE_TIMEOUT", `Bridge 请求超时：${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(encoded, (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new BridgeError("BRIDGE_WRITE_FAILED", error.message));
      });
    });
  }

  stop() {
    const child = this.child;
    this.child = null;
    this.methods = null;
    this._rejectPending("BRIDGE_STOPPED", "Arforge Bridge 已停止");
    if (!child || child.killed) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, 2000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill();
    });
  }

  _handleLine(line) {
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      this.emit("diagnostic", "Bridge 返回了无效 JSON");
      return;
    }
    if (value && value.event === true) {
      if (value.protocol === PROTOCOL && value.version === VERSION) {
        // Responses and unsolicited events can arrive in the same stdout
        // chunk. Defer event delivery to the microtask queue so a successful
        // chat.start response can publish its operation id before clients
        // route the first operation.started event.
        queueMicrotask(() => this.emit("event", value));
      }
      return;
    }
    const entry = value && this.pending.get(value.id);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(value.id);
    if (value.protocol !== PROTOCOL || value.version !== VERSION) {
      entry.reject(new BridgeError("INVALID_RESPONSE", "Bridge 协议或版本不匹配"));
    } else if (!value.ok) {
      entry.reject(
        new BridgeError(
          value.error && value.error.code ? value.error.code : "BACKEND_ERROR",
          value.error && value.error.message ? value.error.message : "Bridge 请求失败"
        )
      );
    } else {
      entry.resolve(value.data);
    }
  }

  _close(code, message) {
    this.child = null;
    this.methods = null;
    this._rejectPending(code, message);
    this.emit("closed", new BridgeError(code, message));
  }

  _rejectPending(code, message) {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new BridgeError(code, message));
    }
    this.pending.clear();
  }
}

module.exports = { BridgeError, JsonlBridge, PROTOCOL, VERSION };
