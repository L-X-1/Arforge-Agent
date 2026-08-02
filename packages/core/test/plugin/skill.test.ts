import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { AppNodeBuilder } from "@arforge-ai/core/effect/app-node-builder"
import { SkillPlugin } from "@arforge-ai/core/plugin/skill"
import { SkillV2 } from "@arforge-ai/core/skill"
import { testEffect } from "../lib/effect"
import { host } from "./host"

const it = testEffect(AppNodeBuilder.build(SkillV2.node))

describe("SkillPlugin.Plugin", () => {
  it.effect("registers the built-in customization and Arforge development skills", () =>
    Effect.gen(function* () {
      const skill = yield* SkillV2.Service
      yield* SkillPlugin.Plugin.effect(host({ skill: { ...skill, reload: skill.reload } }))

      expect(yield* skill.list()).toContainEqual(
        expect.objectContaining({
          name: "customize-arforge",
          description: expect.stringContaining("Arforge's own configuration"),
        }),
      )
      expect((yield* skill.list()).map((item) => item.name)).toEqual(
        expect.arrayContaining(["grill-me", "openspec", "trellis", "superpowers"]),
      )
    }),
  )
})
