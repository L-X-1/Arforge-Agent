import { describe, expect, test } from "bun:test"
import {
  clampPetPosition,
  dragonAnimationClips,
  executionDragonState,
  executionAnimationMode,
  nextPetFacing,
  nextPetIdleTask,
  parsePetFreeRoam,
  parsePetPosition,
  petDragonClip,
  pointerWakesPet,
} from "./execution-animation-model"

describe("execution animation model", () => {
  test("moves between idle, real task battle, and completion pose", () => {
    expect(executionAnimationMode({ running: false, celebrating: false })).toBe("idle")
    expect(executionAnimationMode({ running: true, celebrating: false })).toBe("battle")
    expect(executionAnimationMode({ running: false, celebrating: true })).toBe("victory")
    expect(executionAnimationMode({ running: true, celebrating: true })).toBe("battle")
  })

  test("chooses weighted random activities instead of following fixed waypoints", () => {
    const activityAt = (roll: number) => nextPetIdleTask({ width: 1280, height: 800 }, values(roll, 0, 0))
    expect(activityAt(0).activity).toBe("roam")
    expect(activityAt(0.34).activity).toBe("observe")
    expect(activityAt(0.52).activity).toBe("pose")
    expect(activityAt(0.68).activity).toBe("play")
    expect(activityAt(0.8).activity).toBe("nap")
    expect(activityAt(0.92).activity).toBe("sleep")
  })

  test("randomizes roaming destinations, duration and pose inside the safe viewport", () => {
    const first = nextPetIdleTask({ width: 1280, height: 800 }, values(0.1, 0, 0, 0, 0))
    const second = nextPetIdleTask({ width: 1280, height: 800 }, values(0.1, 0.999, 0.999, 0.999, 0.999))
    expect(first).toEqual({ activity: "roam", durationMs: 3_200, pose: 0, destination: { x: 20, y: 76 } })
    expect(second).toEqual({ activity: "roam", durationMs: 6_497, pose: 2, destination: { x: 1147, y: 562 } })
  })

  test("faces the direction of travel", () => {
    expect(nextPetFacing(20, 80)).toBe(1)
    expect(nextPetFacing(80, 20)).toBe(-1)
  })

  test("clamps a dragged pet to the visible viewport", () => {
    expect(clampPetPosition({ x: -90, y: -40, width: 1280, height: 800 })).toEqual({ x: 0, y: 36 })
    expect(clampPetPosition({ x: 2_000, y: 1_400, width: 1280, height: 800 })).toEqual({ x: 1168, y: 674 })
    expect(clampPetPosition({ x: 60, y: 80, width: 80, height: 100 })).toEqual({ x: 0, y: 36 })
  })

  test("publishes the complete first animation batch", () => {
    expect(dragonAnimationClips).toEqual([
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
    ])
  })

  test("maps real execution events onto explicit animation states", () => {
    expect(executionDragonState({ running: true, celebrating: false, kind: "reasoning" })).toEqual({
      mode: "battle",
      clip: "thinking",
      loop: true,
    })
    expect(executionDragonState({ running: true, celebrating: false, kind: "edit" }).clip).toBe("edit")
    expect(executionDragonState({ running: true, celebrating: false, kind: "agent" }).clip).toBe("summon")
    expect(executionDragonState({ running: true, celebrating: false, kind: "verify" }).clip).toBe("verify")
    expect(executionDragonState({ running: false, celebrating: true })).toEqual({
      mode: "victory",
      clip: "victory",
      loop: false,
    })
  })

  test("maps pet interaction states onto the same animation protocol", () => {
    expect(petDragonClip("roam", false)).toBe("walk")
    expect(petDragonClip("observe", false)).toBe("look")
    expect(petDragonClip("sleep", false)).toBe("sleep")
    expect(petDragonClip("wake", false)).toBe("wake")
    expect(petDragonClip("observe", true)).toBe("grabbed")
  })

  test("only wakes a sleeping pet when the pointer approaches it", () => {
    const pet = { left: 100, top: 120, right: 212, bottom: 246 }
    expect(pointerWakesPet({ ...pet, pointerX: 82, pointerY: 150 })).toBe(true)
    expect(pointerWakesPet({ ...pet, pointerX: 20, pointerY: 150 })).toBe(false)
  })

  test("restores a persisted pet position safely inside the current window", () => {
    expect(parsePetPosition('{"x":240,"y":180,"facing":-1}', { width: 1280, height: 800 })).toEqual({
      x: 240,
      y: 180,
      facing: -1,
    })
    expect(parsePetPosition('{"x":9000,"y":-2,"facing":7}', { width: 1280, height: 800 })).toEqual({
      x: 1168,
      y: 36,
      facing: 1,
    })
    expect(parsePetPosition("broken", { width: 1280, height: 800 })).toBeUndefined()
  })

  test("keeps free roaming enabled by default and restores an explicit disabled preference", () => {
    expect(parsePetFreeRoam(null)).toBe(true)
    expect(parsePetFreeRoam("true")).toBe(true)
    expect(parsePetFreeRoam("false")).toBe(false)
    expect(parsePetFreeRoam("broken")).toBe(true)
  })
})

function values(...items: number[]) {
  let index = 0
  return () => items[index++] ?? items.at(-1) ?? 0
}
