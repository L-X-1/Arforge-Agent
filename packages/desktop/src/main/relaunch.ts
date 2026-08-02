import type { RelaunchOptions } from "electron"

export function resolveRelaunchOptions(input: {
  isPackaged: boolean
  execPath: string
  appPath: string
  argv: string[]
  devHostExecPath?: string
}): RelaunchOptions | undefined {
  if (input.isPackaged) return

  if (input.devHostExecPath) {
    return {
      execPath: input.devHostExecPath,
      args: ["run", "--cwd", input.appPath, "dev"],
    }
  }

  return {
    execPath: input.execPath,
    args: [input.appPath, ...input.argv.slice(2)],
  }
}
