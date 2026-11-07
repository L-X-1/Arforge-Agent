declare global {
  const ARFORGE_VERSION: string
  const ARFORGE_CHANNEL: string
}

export const InstallationVersion = typeof ARFORGE_VERSION === "string" ? ARFORGE_VERSION : "local"
export const InstallationChannel = typeof ARFORGE_CHANNEL === "string" ? ARFORGE_CHANNEL : "local"
export const ProductDisplayVersion = `Arforge ${InstallationVersion === "local" ? "1.0.0" : InstallationVersion}`
export const InstallationLocal = InstallationChannel === "local"
