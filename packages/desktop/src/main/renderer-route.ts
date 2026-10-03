import { extname } from "node:path"

export function shouldServeRendererShell(input: {
  method: string
  pathname: string
  range: string | null
}) {
  if (input.method.toUpperCase() !== "GET" || input.range) return false
  try {
    return extname(decodeURIComponent(input.pathname)) === ""
  } catch {
    return false
  }
}
