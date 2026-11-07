import { defineConfig } from "electron-vite"
import { createAppPlugin } from "@arforge-ai/app/vite"
import * as fs from "node:fs/promises"
import { dirname, resolve } from "node:path"

const ARFORGE_SERVER_DIST = process.env.ARFORGE_NODE_OUT || "../arforge/dist/node"
const DESKTOP_OUT = process.env.ARFORGE_DESKTOP_OUT || "out"
const version = process.env.ARFORGE_VERSION || "1.0.0"
const APP_SOURCE = resolve(import.meta.dirname, "../app/src")

const channel = (() => {
  const raw = process.env.ARFORGE_CHANNEL
  if (raw === "dev" || raw === "beta" || raw === "prod") return raw
  if (process.env.ARFORGE_CHANNEL === "latest") return "prod"
  return "dev"
})()

const nodePtyPkg = `@lydell/node-pty-${process.platform}-${process.arch}`

// Workspace packages publish TypeScript source for Bun-based development. Electron's
// embedded Node runtime deliberately refuses to strip types below node_modules, so
// these dependencies must be compiled into the main-process bundle before packaging.
export const bundledMainProcessDependencies = ["@arforge-ai/core"]
export const bundledMainProcessAssets = [
  {
    source: resolve(import.meta.dirname, "../core/assets/models.json"),
    output: resolve(import.meta.dirname, DESKTOP_OUT, "main/assets/models.json"),
  },
] as const

export default defineConfig({
  main: {
    define: {
      "import.meta.env.ARFORGE_CHANNEL": JSON.stringify(channel),
      ARFORGE_VERSION: JSON.stringify(version),
      ARFORGE_CHANNEL: JSON.stringify(channel),
    },
    build: {
      outDir: resolve(import.meta.dirname, DESKTOP_OUT, "main"),
      rollupOptions: {
        input: {
          index: "src/main/index.ts", sidecar: "src/main/sidecar.ts",
          "postgres-maintenance-worker": "src/main/postgres-maintenance-worker.ts",
        },
        // Keep this identical to electron-vite's Node 20.11+ shim. Its regex insertion can
        // corrupt bundled TypeScript, while a Rollup banner places the shim safely.
        output: {
          banner: `
// -- CommonJS Shims --
import __cjs_mod__ from 'node:module';
const __filename = import.meta.filename;
const __dirname = import.meta.dirname;
const require = __cjs_mod__.createRequire(import.meta.url);
`,
        },
      },
      externalizeDeps: {
        include: [nodePtyPkg],
        exclude: bundledMainProcessDependencies,
      },
    },
    plugins: [
      {
        name: "arforge:node-pty-narrower",
        enforce: "pre",
        resolveId(s) {
          if (s === "@lydell/node-pty") return nodePtyPkg
        },
      },
      {
        name: "arforge:virtual-server-module",
        enforce: "pre",
        resolveId(id) {
          if (id === "virtual:arforge-server") return this.resolve(`${ARFORGE_SERVER_DIST}/node.js`)
        },
      },
      {
        name: "arforge:copy-server-assets",
        async writeBundle() {
          for (const l of await fs.readdir(ARFORGE_SERVER_DIST)) {
            if (!l.endsWith(".wasm")) continue
            await fs.mkdir(resolve(import.meta.dirname, DESKTOP_OUT, "main/chunks"), { recursive: true })
            await fs.writeFile(
              resolve(import.meta.dirname, DESKTOP_OUT, "main/chunks", l),
              await fs.readFile(`${ARFORGE_SERVER_DIST}/${l}`),
            )
          }
          for (const asset of bundledMainProcessAssets) {
            await fs.mkdir(dirname(asset.output), { recursive: true })
            await fs.copyFile(asset.source, asset.output)
          }
          await fs.cp(
            resolve(ARFORGE_SERVER_DIST, "plugin-sdk"),
            resolve(import.meta.dirname, DESKTOP_OUT, "main/assets/plugin-sdk"),
            { recursive: true },
          )
        },
      },
    ],
  },
  preload: {
    define: { ARFORGE_VERSION: JSON.stringify(version), ARFORGE_CHANNEL: JSON.stringify(channel) },
    build: {
      outDir: resolve(import.meta.dirname, DESKTOP_OUT, "preload"),
      rollupOptions: {
        input: { index: "src/preload/index.ts" },
        output: {
          format: "cjs",
          entryFileNames: "[name].js",
        },
      },
    },
  },
  renderer: {
    define: { ARFORGE_VERSION: JSON.stringify(version), ARFORGE_CHANNEL: JSON.stringify(channel) },
    // Solid Refresh can re-enter ownership disposal in this long-lived desktop tree
    // and leave `owned` null while cleanNode is still iterating it. A full renderer
    // reload on source changes is slower but deterministic; CSS HMR remains enabled.
    plugins: [createAppPlugin({ solidHot: false })],
    publicDir: "../../../app/public",
    root: "src/renderer",
    server: {
      warmup: {
        clientFiles: [
          resolve(APP_SOURCE, "app.tsx"),
          resolve(APP_SOURCE, "pages/session.tsx"),
          resolve(APP_SOURCE, "pages/session/timeline/message-timeline.tsx"),
          resolve(APP_SOURCE, "pages/new-session.tsx"),
        ],
      },
    },
    build: {
      outDir: resolve(import.meta.dirname, DESKTOP_OUT, "renderer"),
      sourcemap: true,
      rollupOptions: {
        input: {
          main: "src/renderer/index.html",
        },
      },
    },
  },
})
