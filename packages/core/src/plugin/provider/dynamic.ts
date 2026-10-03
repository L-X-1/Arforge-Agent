import { Effect } from "effect"
import { define } from "../definition"
import { Npm } from "../../npm"
import {
  createDynamicProviderSDK,
  dynamicProviderEntrypoint,
  dynamicProviderOptions,
  selectDynamicProviderFactory,
  validateDynamicProviderPackage,
} from "./dynamic-contract"

export * from "./dynamic-contract"

export const DynamicProviderPlugin = define({
  id: "dynamic-provider",
  effect: Effect.fn(function* (ctx) {
    const npm = yield* Npm.Service
    yield* ctx.aisdk.sdk(
      Effect.fn(function* (evt) {
        if (evt.sdk) return

        const packageSpec = validateDynamicProviderPackage(evt.package)
        const installedPath = packageSpec.startsWith("file://")
          ? packageSpec
          : (yield* npm.add(packageSpec).pipe(Effect.orDie)).entrypoint
        if (!installedPath) throw new Error("Dynamic provider package has no import entrypoint")
        const importURL = dynamicProviderEntrypoint(installedPath)

        const mod = yield* Effect.promise(async () => {
          return (await import(importURL)) as Record<string, unknown>
        }).pipe(Effect.orDie)
        const { factory } = selectDynamicProviderFactory(mod)
        evt.sdk = createDynamicProviderSDK(factory, dynamicProviderOptions(evt.options))
      }),
    )
  }),
})
