/// <reference path="../markdown.d.ts" />

export * as SkillPlugin from "./skill"

import { define } from "./definition"
import { Effect } from "effect"
import { AbsolutePath } from "../schema"
import { SkillV2 } from "../skill"
import customizeArforgeContent from "./skill/customize-arforge.md" with { type: "text" }
import grillMeContent from "./skill/grill-me.md" with { type: "text" }
import openspecContent from "./skill/openspec.md" with { type: "text" }
import trellisContent from "./skill/trellis.md" with { type: "text" }
import superpowersContent from "./skill/superpowers.md" with { type: "text" }

export const CustomizeArforgeContent = customizeArforgeContent

const developmentSkills = [
  {
    name: "grill-me",
    description:
      "Clarifies ambiguous, high-impact requirements by inspecting discoverable facts first and asking one user-owned decision at a time with a recommendation.",
    content: grillMeContent,
  },
  {
    name: "openspec",
    description:
      "Turns material behavior changes into explicit requirements, scenarios, design constraints, ordered tasks, and verification evidence.",
    content: openspecContent,
  },
  {
    name: "trellis",
    description:
      "Manages long, multi-step development through durable task artifacts, checkpoints, implementation context, quality checks, and resume state.",
    content: trellisContent,
  },
  {
    name: "superpowers",
    description:
      "Applies disciplined software delivery methods: proportionate design, test-first implementation, systematic debugging, code review, and fresh verification.",
    content: superpowersContent,
  },
] as const

export const Plugin = define({
  id: "skill",
  effect: Effect.fn(function* (ctx) {
    yield* ctx.skill.transform((draft) => {
      draft.source(
        SkillV2.EmbeddedSource.make({
          type: "embedded",
          skill: SkillV2.Info.make({
            name: "customize-arforge",
            description:
              "Use ONLY when the user is editing or creating Arforge's own configuration: arforge.json, arforge.jsonc, files under .arforge/, or files under ~/.config/arforge/. Also use when creating or fixing Arforge agents, subagents, commands, skills, plugins, MCP servers, or permission rules. Do not use for the user's own application code, or for any project that is not configuring Arforge itself.",
            location: AbsolutePath.make("/builtin/customize-arforge.md"),
            content: CustomizeArforgeContent,
          }),
        }),
      )
      for (const skill of developmentSkills) {
        draft.source(
          SkillV2.EmbeddedSource.make({
            type: "embedded",
            skill: SkillV2.Info.make({
              name: skill.name,
              description: skill.description,
              location: AbsolutePath.make(`/builtin/${skill.name}.md`),
              content: skill.content,
            }),
          }),
        )
      }
    })
  }),
})
