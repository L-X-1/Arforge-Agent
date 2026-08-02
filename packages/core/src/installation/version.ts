declare global {
  const ARFORGE_VERSION: string
  const ARFORGE_CHANNEL: string
}

export const InstallationVersion = typeof ARFORGE_VERSION === "string" ? ARFORGE_VERSION : "local"
export const InstallationChannel = typeof ARFORGE_CHANNEL === "string" ? ARFORGE_CHANNEL : "local"
export const ProductDisplayVersion = "Arforge 测试 1.00.00 版"
export const InstallationLocal = InstallationChannel === "local"
