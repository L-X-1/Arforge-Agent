interface ImportMetaEnv {
  readonly ARFORGE_CHANNEL: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

declare module "virtual:arforge-server" {
  // Narrow bundled API: do not pull Bun-only database-driver source types into
  // Electron's Node compilation. The existing Node entry exports this method.
  export const Database: {
    migratePostgresSchema(url: string): import("effect").Effect.Effect<{
      readonly current: string
      readonly applied: readonly string[]
    }, unknown>
  }
  export namespace Server {
    export const listen: typeof import("../../../arforge/dist/types/src/node").Server.listen
    export type Listener = import("../../../arforge/dist/types/src/node").Server.Listener
  }
  export namespace Config {
    export const get: typeof import("../../../arforge/dist/types/src/node").Config.get
    export type Info = import("../../../arforge/dist/types/src/node").Config.Info
  }
  export const bootstrap: typeof import("../../../arforge/dist/types/src/node").bootstrap
}
