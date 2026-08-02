interface ImportMetaEnv {
  readonly ARFORGE_CHANNEL: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

declare module "virtual:arforge-server" {
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
