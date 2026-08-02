/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_ARFORGE_SERVER_HOST: string
  readonly VITE_ARFORGE_SERVER_PORT: string
  readonly VITE_ARFORGE_CHANNEL?: "dev" | "beta" | "prod"
  readonly VITE_ARFORGE_DEBUG_TOOLS?: "1"
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

declare module "*.png" {
  const src: string
  export default src
}

declare module "*.mp4" {
  const src: string
  export default src
}

export declare module "solid-js" {
  namespace JSX {
    interface Directives {
      sortable: true
    }
  }
}
