/// <reference path="../markdown.d.ts" />

export * as SkillPlugin from "./skill"

import { define } from "./definition"
import { Effect } from "effect"
import { existsSync } from "node:fs"
import path from "node:path"
import { AbsolutePath } from "../schema"
import { SkillV2 } from "../skill"
import { findDevelopmentRuntimeRoot } from "../skill/runtime-root"
import customizeArforgeContent from "./skill/customize-arforge.md" with { type: "text" }
import grillMeContent from "./skill/grill-me.md" with { type: "text" }
import openspecContent from "./skill/openspec.md" with { type: "text" }
import trellisContent from "./skill/trellis.md" with { type: "text" }
import superpowersContent from "./skill/superpowers.md" with { type: "text" }

export const CustomizeArforgeContent = customizeArforgeContent

// Capability skills ship with the Python runtime bundle (dev checkout or the
// packaged desktop resources). Registering them as a directory source keeps a
// single upstream copy while making them routable by SkillGuidance.
function bundledAgentSkillsRoot(): string | undefined {
  const runtimeRoot = process.env.ARFORGE_AGENT_RUNTIME_ROOT || findDevelopmentRuntimeRoot(process.cwd())
  if (!runtimeRoot) return
  for (const candidate of [
    path.join(runtimeRoot, "arforge", "bundled_skills", "agent_skills", "skills"),
    path.join(runtimeRoot, "_internal", "arforge", "bundled_skills", "agent_skills", "skills"),
  ]) {
    if (existsSync(candidate)) return candidate
  }
}

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
      // Full-capability skills (design-taste-frontend and friends) are kept in
      // the Python bundle; directory-source loading reuses the same copy and
      // silently no-ops when the runtime root is unavailable.
      const bundledRoot = bundledAgentSkillsRoot()
      if (bundledRoot) {
        draft.source(
          SkillV2.DirectorySource.make({
            type: "directory",
            path: AbsolutePath.make(path.join(bundledRoot, "design-taste-frontend")),
          }),
        )
      }
    })
  }),
})
