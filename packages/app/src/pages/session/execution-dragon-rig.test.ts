import { describe, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import { dragonRigAsset, dragonRigParts } from "./execution-dragon-rig"
import type { ExecutionMascotForm } from "./execution-trace-model"

describe("execution dragon rig", () => {
  test("ships the same non-empty part contract for all three forms", async () => {
    for (const form of [1, 2, 3] as const satisfies readonly ExecutionMascotForm[]) {
      for (const part of dragonRigParts) {
        const asset = Bun.file(fileURLToPath(new URL(`../../../public${dragonRigAsset(form, part)}`, import.meta.url)))
        expect(await asset.exists()).toBe(true)
        expect(asset.size).toBeGreaterThan(1_000)
      }
    }
  })

  test("keeps the public URL stable for the renderer", () => {
    expect(dragonRigAsset(2, "eye-left")).toBe("/assets/mascot/form-2-rig/eye-left.png")
    expect(dragonRigAsset(3, "tail")).toBe("/assets/mascot/form-3-rig/tail.png")
  })

  test("keeps complete eye assets locked inside the face", async () => {
    const stylesheet = await Bun.file(new URL("./session-execution-dock.css", import.meta.url)).text()
    const eyeRule = stylesheet.match(/\.execution-dragon-rig__eye\s*\{([\s\S]*?)\}/)?.[1]
    expect(eyeRule).toContain("transform: translate3d(0, 0, 0)")
    expect(eyeRule).not.toContain("--pet-look")
  })
})
