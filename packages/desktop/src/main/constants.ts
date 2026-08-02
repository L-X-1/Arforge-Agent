type Channel = "dev" | "beta" | "prod"
const raw = import.meta.env.ARFORGE_CHANNEL
export const CHANNEL: Channel = raw === "dev" || raw === "beta" || raw === "prod" ? raw : "dev"

export const APP_NAMES: Record<Channel, string> = {
  dev: "Arforge Dev",
  beta: "Arforge Beta",
  prod: "Arforge",
}

export const APP_IDS: Record<Channel, string> = {
  dev: "ai.arforge.desktop.dev",
  beta: "ai.arforge.desktop.beta",
  prod: "ai.arforge.desktop",
}
