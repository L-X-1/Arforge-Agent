import { describe, expect, test } from "bun:test"
import { resolveRelaunchOptions } from "./relaunch"

describe("resolveRelaunchOptions", () => {
  test("restarts the complete development host when its executable is available", () => {
    expect(
      resolveRelaunchOptions({
        isPackaged: false,
        execPath: "E:\\repo\\node_modules\\electron\\electron.exe",
        appPath: "E:\\repo\\packages\\desktop",
        argv: ["electron.exe", "."],
        devHostExecPath: "E:\\repo\\.tools\\bun\\bun.exe",
      }),
    ).toEqual({
      execPath: "E:\\repo\\.tools\\bun\\bun.exe",
      args: ["run", "--cwd", "E:\\repo\\packages\\desktop", "dev"],
    })
  })

  test("uses the absolute app path when relaunching a development build", () => {
    expect(
      resolveRelaunchOptions({
        isPackaged: false,
        execPath: "E:\\repo\\node_modules\\electron\\electron.exe",
        appPath: "E:\\repo\\packages\\desktop",
        argv: ["electron.exe", ".", "--inspect=9222"],
      }),
    ).toEqual({
      execPath: "E:\\repo\\node_modules\\electron\\electron.exe",
      args: ["E:\\repo\\packages\\desktop", "--inspect=9222"],
    })
  })

  test("keeps Electron's default relaunch behavior for packaged builds", () => {
    expect(
      resolveRelaunchOptions({
        isPackaged: true,
        execPath: "C:\\Program Files\\Arforge\\Arforge.exe",
        appPath: "C:\\Program Files\\Arforge\\resources\\app.asar",
        argv: ["Arforge.exe", "--flag"],
        devHostExecPath: "E:\\repo\\.tools\\bun\\bun.exe",
      }),
    ).toBeUndefined()
  })
})
