import { Effect, Layer } from "effect"
import { Skill } from "../../src/skill"

export const empty = Layer.mock(Skill.Service)({
  dirs: () => Effect.succeed([]),
  reload: () => Effect.die("unused skill.reload"),
  snapshot: () => Effect.die("unused skill.snapshot"),
})

export * as SkillTest from "./skill"
