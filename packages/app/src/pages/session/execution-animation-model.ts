import type { ExecutionTraceKind } from "./execution-trace-model"

export type ExecutionAnimationMode = "idle" | "battle" | "victory"
export type PetIdleActivity = "roam" | "observe" | "pose" | "play" | "nap" | "sleep" | "wake"

export const dragonAnimationClips = [
  "idle",
  "walk",
  "look",
  "grabbed",
  "thinking",
  "tool",
  "edit",
  "summon",
  "verify",
  "victory",
  "nap",
  "sleep",
  "wake",
] as const

export type DragonAnimationClip = (typeof dragonAnimationClips)[number]

export type DragonAnimationState = {
  readonly mode: ExecutionAnimationMode
  readonly clip: DragonAnimationClip
  readonly loop: boolean
}

export type PetIdleTask = {
  readonly activity: PetIdleActivity
  readonly durationMs: number
  readonly pose: 0 | 1 | 2
  readonly destination?: { readonly x: number; readonly y: number }
}

const petWidth = 112
const petHeight = 126
const petSafeTop = 36
const petPoses = [0, 1, 2] as const

const idleActivities = [
  { activity: "roam", weight: 0.34, duration: [3_200, 6_500] },
  { activity: "observe", weight: 0.18, duration: [2_800, 6_800] },
  { activity: "pose", weight: 0.16, duration: [2_800, 5_200] },
  { activity: "play", weight: 0.12, duration: [2_400, 4_800] },
  { activity: "nap", weight: 0.12, duration: [5_500, 9_500] },
  { activity: "sleep", weight: 0.08, duration: [9_000, 18_000] },
] as const satisfies readonly {
  readonly activity: PetIdleActivity
  readonly weight: number
  readonly duration: readonly [number, number]
}[]

export function executionAnimationMode(input: {
  readonly running: boolean
  readonly celebrating: boolean
}): ExecutionAnimationMode {
  if (input.running) return "battle"
  if (input.celebrating) return "victory"
  return "idle"
}

export function executionDragonState(input: {
  readonly running: boolean
  readonly celebrating: boolean
  readonly kind?: ExecutionTraceKind
}): DragonAnimationState {
  const mode = executionAnimationMode(input)
  if (mode === "victory") return { mode, clip: "victory", loop: false }
  if (mode === "idle") return { mode, clip: "idle", loop: true }

  const clip = (() => {
    if (input.kind === "edit") return "edit"
    if (input.kind === "agent") return "summon"
    if (input.kind === "verify" || input.kind === "answer") return "verify"
    if (input.kind === "reasoning" || input.kind === "context" || !input.kind) return "thinking"
    return "tool"
  })()
  return { mode, clip, loop: true }
}

export function petDragonClip(activity: PetIdleActivity, dragging: boolean): DragonAnimationClip {
  if (dragging) return "grabbed"
  if (activity === "roam") return "walk"
  if (activity === "observe") return "look"
  if (activity === "nap" || activity === "sleep" || activity === "wake") return activity
  return "idle"
}

function randomUnit(random: () => number) {
  return Math.min(Math.max(random(), 0), 1 - Number.EPSILON)
}

export function nextPetIdleTask(
  input: { readonly width: number; readonly height: number },
  random: () => number = Math.random,
): PetIdleTask {
  const activityRoll = randomUnit(random)
  let cumulative = 0
  const selected =
    idleActivities.find((option) => {
      cumulative += option.weight
      return activityRoll < cumulative
    }) ?? idleActivities.at(-1)!
  const [minimumDuration, maximumDuration] = selected.duration
  const durationMs = Math.round(minimumDuration + (maximumDuration - minimumDuration) * randomUnit(random))
  const pose = petPoses[Math.floor(randomUnit(random) * petPoses.length)] ?? 0
  if (selected.activity !== "roam") return { activity: selected.activity, durationMs, pose }

  const marginX = 20
  const safeTop = 76
  const safeBottom = 112
  const availableX = Math.max(0, input.width - petWidth - marginX * 2)
  const availableY = Math.max(0, input.height - petHeight - safeTop - safeBottom)
  return {
    activity: selected.activity,
    durationMs,
    pose,
    destination: {
      x: Math.round(marginX + availableX * randomUnit(random)),
      y: Math.round(safeTop + availableY * randomUnit(random)),
    },
  }
}

export function clampPetPosition(input: {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}) {
  const maxX = Math.max(0, input.width - petWidth)
  const maxY = Math.max(petSafeTop, input.height - petHeight)
  return {
    x: Math.round(Math.min(Math.max(0, input.x), maxX)),
    y: Math.round(Math.min(Math.max(petSafeTop, input.y), maxY)),
  }
}

export function nextPetFacing(previousX: number, nextX: number): -1 | 1 {
  return nextX < previousX ? -1 : 1
}

export function pointerWakesPet(input: {
  readonly pointerX: number
  readonly pointerY: number
  readonly left: number
  readonly top: number
  readonly right: number
  readonly bottom: number
  readonly margin?: number
}) {
  const margin = input.margin ?? 32
  return (
    input.pointerX >= input.left - margin &&
    input.pointerX <= input.right + margin &&
    input.pointerY >= input.top - margin &&
    input.pointerY <= input.bottom + margin
  )
}

export function parsePetPosition(
  value: string | null,
  viewport: { readonly width: number; readonly height: number },
): { x: number; y: number; facing: -1 | 1 } | undefined {
  if (!value) return
  try {
    const parsed = JSON.parse(value) as { x?: unknown; y?: unknown; facing?: unknown }
    if (typeof parsed.x !== "number" || !Number.isFinite(parsed.x)) return
    if (typeof parsed.y !== "number" || !Number.isFinite(parsed.y)) return
    const point = clampPetPosition({ x: parsed.x, y: parsed.y, ...viewport })
    return { ...point, facing: parsed.facing === -1 ? -1 : 1 }
  } catch {
    return
  }
}

export function parsePetFreeRoam(value: string | null): boolean {
  return value !== "false"
}
