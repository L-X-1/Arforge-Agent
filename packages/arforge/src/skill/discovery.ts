import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { SkillDiscovery as CoreSkillDiscovery } from "@arforge-ai/core/skill/discovery"
import { Effect, Layer, Context } from "effect"

/**
 * Compatibility seam for the product Skill service.
 *
 * Remote skill discovery has one implementation in Core. Keeping a second
 * downloader here made the CLI `cfg.skills.urls` path bypass the canonical
 * path validation, source-isolated cache and atomic publication rules. The
 * product service only adapts Core's branded paths back to the historical
 * string contract consumed by Skill.index; it does not own another cache,
 * HTTP client, or refresh algorithm.
 */
export interface Interface {
  readonly pull: (url: string) => Effect.Effect<string[]>
}

export class Service extends Context.Service<Service, Interface>()("@arforge/SkillDiscovery") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const discovery = yield* CoreSkillDiscovery.Service
    return Service.of({
      pull: Effect.fn("SkillDiscovery.pull")(function* (url: string) {
        const directories = yield* discovery.pull(url)
        return directories.map((directory) => String(directory))
      }),
    })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [CoreSkillDiscovery.node] })

export * as Discovery from "./discovery"
