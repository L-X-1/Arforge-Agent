export const SOUND_OPTIONS = [
  { id: "soft-glass-complete.wav", label: "sound.option.softGlassComplete" },
  { id: "soft-glass-permission.wav", label: "sound.option.softGlassPermission" },
  { id: "soft-glass-error.wav", label: "sound.option.softGlassError" },
  { id: "warm-wood-complete.wav", label: "sound.option.warmWoodComplete" },
  { id: "warm-wood-permission.wav", label: "sound.option.warmWoodPermission" },
  { id: "warm-wood-error.wav", label: "sound.option.warmWoodError" },
  { id: "minimal-electronic-complete.wav", label: "sound.option.minimalElectronicComplete" },
  { id: "minimal-electronic-permission.wav", label: "sound.option.minimalElectronicPermission" },
  { id: "minimal-electronic-error.wav", label: "sound.option.minimalElectronicError" },
  { id: "soft-piano-complete.wav", label: "sound.option.softPianoComplete" },
  { id: "soft-piano-permission.wav", label: "sound.option.softPianoPermission" },
  { id: "soft-piano-error.wav", label: "sound.option.softPianoError" },
] as const

export type SoundOption = (typeof SOUND_OPTIONS)[number]
export type SoundID = SoundOption["id"]

const legacySoundID = /^(?:(?:alert|bip-bop)-(?:0[1-9]|10)|staplebops-0[1-7]|nope-(?:0[1-9]|1[0-2])|yup-0[1-6])$/

function isSoundID(id: unknown): id is SoundID {
  return SOUND_OPTIONS.some((option) => option.id === id)
}

export function resolveSoundPreference(id: unknown, fallback: SoundID): SoundID | "none" {
  if (id == null || (typeof id === "string" && legacySoundID.test(id))) return fallback
  return isSoundID(id) ? id : "none"
}

let files: Record<string, () => Promise<string>> | undefined

function getFiles() {
  return (files ??= import.meta.glob<string>("../../../ui/src/assets/audio/*.wav", {
    import: "default",
    query: "?url",
  }))
}

const cache = new Map<SoundID, Promise<string | undefined>>()

export function soundSrc(id: string | undefined) {
  if (!isSoundID(id)) return Promise.resolve(undefined)
  const hit = cache.get(id)
  if (hit) return hit
  const load = getFiles()[`../../../ui/src/assets/audio/${id}`]
  if (!load) return Promise.resolve(undefined)
  const next = load().catch(() => undefined)
  cache.set(id, next)
  return next
}

export function playSound(src: string | undefined) {
  if (typeof Audio === "undefined") return
  if (!src) return
  const audio = new Audio(src)
  audio.play().catch(() => undefined)
  return () => {
    audio.pause()
    audio.currentTime = 0
  }
}

export function playSoundById(id: string | undefined) {
  return soundSrc(id).then((src) => playSound(src))
}
