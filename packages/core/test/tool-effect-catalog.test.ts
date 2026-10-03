import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { Schema } from "effect"
import { AppNodeBuilder } from "@arforge-ai/core/effect/app-node-builder"
import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { LocationServiceMap } from "@arforge-ai/core/location-services"
import { Location } from "@arforge-ai/core/location"
import { AbsolutePath } from "@arforge-ai/core/schema"
import { ToolRegistry } from "@arforge-ai/core/tool/registry"
import { Tool } from "@arforge-ai/core/tool/tool"
import { automaticRead } from "@arforge-ai/core/tool/effect-semantics"
import {
  auditBuiltInToolCatalog,
  auditToolExitGate,
  auditToolManifestContract,
  BuiltInToolManifest,
} from "@arforge-ai/core/tool/effect-catalog"
import { ApplicationTools } from "../src/tool/application-tools"
import { Database } from "../src/database/database"
import { EventV2 } from "../src/event"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([ApplicationTools.node, Database.node, EventV2.node, LocationServiceMap.node])),
)

describe("Tool effect catalog", () => {
  it.live("audits every registered built-in against the canonical manifest", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (directory) => Effect.promise(() => directory[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((directory) =>
        Effect.scoped(
          Effect.gen(function* () {
            const registry = yield* ToolRegistry.Service
            const entries = yield* registry.catalog()
            const builtIns = entries.filter((entry) => entry.name in BuiltInToolManifest)
            expect(auditBuiltInToolCatalog(builtIns)).toEqual({
              expected: 36,
              observed: 36,
              missing: [],
              undeclaredEffects: [],
              invalidDeadlines: [],
            })
            for (const manifest of Object.values(BuiltInToolManifest))
              expect(auditToolManifestContract(manifest)).toEqual({
                valid: true,
                missingFields: [],
                invalidFields: [],
              })
            expect(
              Object.values(BuiltInToolManifest).every(
                (manifest) =>
                  auditToolExitGate(manifest, {
                    observerRegistered: true,
                    verifierRegistered: true,
                    recoveryContractRegistered: true,
                  }).valid,
              ),
            ).toBe(true)
            expect(
              auditToolExitGate(BuiltInToolManifest.bash, {
                observerRegistered: true,
                verifierRegistered: false,
                recoveryContractRegistered: true,
              }),
            ).toMatchObject({ valid: false, missingContracts: ["verifier"] })
            expect(builtIns.every((entry) => entry.schemaDigest !== "manifest:" + entry.name + ":v1")).toBe(true)

            // A user/plugin tool is visible through the same catalog and can
            // declare the execution policy without creating a parallel
            // registry. Dynamic resource keys are intentionally omitted from
            // the static catalog and are resolved at call preflight.
            yield* registry.register({
              catalog_metadata: Tool.make({
                description: "catalog metadata fixture",
                effects: automaticRead(),
                metadata: {
                  concurrency: "safe",
                  resourceKey: "catalog:fixture",
                  sideEffect: "read",
                  idempotency: "idempotent",
                  timeoutMode: "inherited",
                  outputPolicy: "model",
                },
                input: Schema.Struct({ value: Schema.String }),
                output: Schema.String,
                execute: ({ value }) => Effect.succeed(value),
              }),
            })
            const custom = (yield* registry.catalog()).find((entry) => entry.name === "catalog_metadata")
            expect(custom).toMatchObject({
              concurrency: "safe",
              resourceKey: "catalog:fixture",
              sideEffect: "read",
              idempotency: "idempotent",
              timeoutMode: "inherited",
              outputPolicy: "model",
            })
          }).pipe(
            Effect.provide(
              LocationServiceMap.Service.get(Location.Ref.make({ directory: AbsolutePath.make(directory.path) })),
            ),
          ),
        ),
      ),
    ),
  )
})
