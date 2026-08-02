import { readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { createRequire } from "node:module"

const require = createRequire(import.meta.url)
const electronPackage = require.resolve("electron/package.json")
const electronDirectory = dirname(electronPackage)
const executableName = (await readFile(join(electronDirectory, "path.txt"), "utf8")).trim()

if (!executableName) {
  throw new Error(`Electron executable metadata is empty: ${join(electronDirectory, "path.txt")}`)
}

const electronExecutable = join(electronDirectory, "dist", executableName)
const child = Bun.spawn([process.execPath, "x", "electron-vite", "dev"], {
  cwd: join(import.meta.dir, ".."),
  env: {
    ...process.env,
    // The Electron process cannot relaunch only itself in development because
    // electron-vite owns the renderer dev server. Preserve Bun's absolute path
    // so the main process can restart this complete development command.
    ARFORGE_DESKTOP_DEV_HOST_EXEC_PATH: process.execPath,
    ELECTRON_EXEC_PATH: electronExecutable,
  },
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
})

const exitCode = await child.exited
process.exit(exitCode)
