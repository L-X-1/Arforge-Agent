let module: Promise<typeof import("@/pages/new-session")> | undefined

export function preloadNewSessionRoute() {
  return (module ??= import("@/pages/new-session"))
}
