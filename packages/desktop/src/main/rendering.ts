const softwareValues = new Set(["1", "true", "software"])
const disabledValues = new Set(["0", "false", "software"])

/**
 * Glass materials and smooth scrolling both depend on Chromium's compositor,
 * so Windows uses hardware acceleration by default. Machines affected by a
 * GPU/driver issue can opt into the conservative software renderer with
 * ARFORGE_DISABLE_HARDWARE_ACCELERATION=1.
 *
 * ARFORGE_ENABLE_HARDWARE_ACCELERATION is retained for compatibility:
 * explicitly setting it to 0/false/software still selects software rendering.
 */
export function shouldDisableHardwareAcceleration(
  platform: NodeJS.Platform = process.platform,
  legacyHardwareSetting: string | undefined = process.env.ARFORGE_ENABLE_HARDWARE_ACCELERATION,
  softwareOptIn: string | undefined = process.env.ARFORGE_DISABLE_HARDWARE_ACCELERATION,
) {
  if (platform !== "win32") return false
  const software = softwareOptIn?.trim().toLowerCase() ?? ""
  if (softwareValues.has(software)) return true

  const legacy = legacyHardwareSetting?.trim().toLowerCase() ?? ""
  if (disabledValues.has(legacy)) return true
  return false
}
