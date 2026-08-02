import { expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import {
  KNOWN_ORPHANED_PRELOAD_CHANNELS,
  desktopIpcChannels,
  desktopIpcOwnership,
} from "./ipc-ownership"

const root = resolve(import.meta.dir, "../..")

test("assigns every registered Desktop IPC channel to exactly one Scheme B owner", async () => {
  const preload = await readFile(resolve(root, "src/preload/index.ts"), "utf8")
  const main = await readMainSources()

  const invokes = matches(preload, /ipcRenderer\.invoke\(\s*"([^"]+)"/g)
  const sends = matches(preload, /ipcRenderer\.send\(\s*"([^"]+)"/g)
  const listens = matches(preload, /ipcRenderer\.on\(\s*"([^"]+)"/g)
  const handles = matches(main, /ipcMain\.handle\(\s*"([^"]+)"/g)
  const receives = matches(main, /ipcMain\.on\(\s*"([^"]+)"/g)
  const emits = matches(main, /\.send\(\s*"([^"]+)"/g)

  const orphaned = invokes.filter((channel) => !handles.includes(channel))
  expect(orphaned).toEqual([...KNOWN_ORPHANED_PRELOAD_CHANNELS])
  expect(handles.filter((channel) => !invokes.includes(channel))).toEqual([])
  expect(sends.filter((channel) => !receives.includes(channel))).toEqual([])
  expect(receives.filter((channel) => !sends.includes(channel))).toEqual([])
  expect(listens.filter((channel) => !emits.includes(channel))).toEqual([])
  expect(emits.filter((channel) => !listens.includes(channel))).toEqual([])

  const registered = unique([
    ...invokes.filter((channel) => !orphaned.includes(channel)),
    ...sends,
    ...listens,
  ])
  const mapped = desktopIpcChannels()
  expect(mapped.length).toBe(registered.length)
  expect(new Set(mapped).size).toBe(mapped.length)
  expect(mapped.filter((channel) => !registered.includes(channel))).toEqual([])
  expect(registered.filter((channel) => !desktopIpcOwnership(channel))).toEqual([])
})

async function readMainSources() {
  const glob = new Bun.Glob("src/main/**/*.ts")
  const files = await Array.fromAsync(glob.scan({ cwd: root, absolute: true }))
  return (await Promise.all(files.map((path) => readFile(path, "utf8")))).join("\n")
}

function matches(input: string, pattern: RegExp) {
  return unique(Array.from(input.matchAll(pattern), (match) => match[1]))
}

function unique(values: string[]) {
  return [...new Set(values)].sort()
}
