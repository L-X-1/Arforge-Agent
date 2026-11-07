import { isAbsolute, join, resolve } from "node:path"

/** Normal portable configuration; no acceptance mode or profile migration. */
export function desktopProfile(input: {
  appData: string
  appId: string
  commandLineUserData?: string
  environmentUserData?: string
}) {
  const override = input.commandLineUserData?.trim() || input.environmentUserData?.trim()
  if (override && !isAbsolute(override)) throw new Error("Desktop user-data directory must be an absolute path")
  const userData = override ? resolve(override) : join(input.appData, input.appId)
  return {
    userData,
    sessionData: override ? join(userData, "session") : undefined,
    documents: override ? join(userData, "documents") : undefined,
  }
}
