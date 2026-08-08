import { defineConfig } from "electron-vite"
import { createAppPlugin } from "@arforge-ai/app/vite"
import * as fs from "node:fs/promises"
import { dirname, resolve } from "node:path"

const ARFORGE_SERVER_DIST = "../arforge/dist/node"
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
    output: resolve(import.meta.dirname, "out/main/assets/models.json"),
  },
] as const

export default defineConfig({
  main: {
    define: {
      "import.meta.env.ARFORGE_CHANNEL": JSON.stringify(channel),
    },
    build: {
      rollupOptions: {
        input: { index: "src/main/index.ts", sidecar: "src/main/sidecar.ts" },
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
            await fs.writeFile(`./out/main/chunks/${l}`, await fs.readFile(`${ARFORGE_SERVER_DIST}/${l}`))
          }
          for (const asset of bundledMainProcessAssets) {
            await fs.mkdir(dirname(asset.output), { recursive: true })
            await fs.copyFile(asset.source, asset.output)
          }
        },
      },
    ],
  },
  preload: {
    build: {
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
      sourcemap: true,
      rollupOptions: {
        input: {
          main: "src/renderer/index.html",
        },
      },
    },
  },
})
