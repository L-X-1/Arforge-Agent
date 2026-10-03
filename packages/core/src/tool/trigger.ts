export * as TriggerTools from "./trigger"

import { ToolFailure } from "@arforge-ai/llm"
import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { TriggerV2 } from "../trigger"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"
import { automaticRead, majorImpact } from "./effect-semantics"

export const ProfilesInput = Schema.Struct({})
export const ManageInput = Schema.Struct({
  action: TriggerV2.Action.annotate({ description: "Trigger operation" }),
  profile: TriggerV2.ProfileName.pipe(Schema.optional).annotate({
    description: "Host-configured profile name; defaults to local",
  }),
  trigger_id: Schema.String.pipe(Schema.optional).annotate({
    description: "Required for get, update, and run",
  }),
  body: Schema.Record(Schema.String, Schema.Unknown).pipe(Schema.optional).annotate({
    description: "Configuration body required for create and update",
  }),
})

const ManageError = Schema.Struct({
  ok: Schema.Literal(false),
  code: Schema.String,
  message: Schema.String,
})
const ManageOutput = Schema.Union([TriggerV2.Result, ManageError])

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.BuiltIns
    const triggers = yield* TriggerV2.Service

    const source = (context: Tool.Context) => ({
      type: "tool" as const,
      messageID: context.assistantMessageID,
      callID: context.toolCallID,
    })

    const profiles = Tool.make({
      description: "List host-configured local and HTTP trigger profiles without returning authentication values.",
      input: ProfilesInput,
      output: TriggerV2.Profiles,
      effects: automaticRead({
        externalServices: ["host-configured-trigger-profiles"],
        expectedArtifacts: ["trigger profiles without credentials"],
        successCriteria: ["configured trigger profiles are listed without authentication values"],
      }),
      toModelOutput: ({ output }) => [{ type: "text", text: JSON.stringify(output, null, 2) }],
      execute: (_input, context) =>
        context.permission
          .assert({
            action: "trigger_profiles",
            resources: ["*"],
            save: ["*"],
            sessionID: context.sessionID,
            agent: context.agent,
            source: source(context),
          })
          .pipe(
            Effect.andThen(Effect.sync(() => triggers.profiles())),
            Effect.mapError(
              (error) => Tool.toToolFailure(error) ?? new ToolFailure({ message: "Unable to list trigger profiles" }),
            ),
          ),
    })

    const manage = Tool.withPermission(
      Tool.make({
        description:
          "Manage local or authenticated HTTP agent triggers through a host-configured profile. Supports list, get, create, update, and run. URLs and credentials are host-owned and never accepted as tool parameters.",
        input: ManageInput,
        output: ManageOutput,
        effects: (input) => {
          const profile = input.profile ?? "local"
          const common = {
            externalServices: [`trigger-profile:${profile}`],
            networkScope: [`trigger-profile:${profile}`],
            secretScope: ["host-managed trigger credentials"],
            successCriteria: [`trigger ${input.action} completes against host profile ${profile}`],
          }
          return input.action === "list" || input.action === "get"
            ? automaticRead({ ...common, expectedArtifacts: ["bounded trigger result"] })
            : majorImpact({ ...common, expectedArtifacts: ["trigger mutation result"] })
        },
        toModelOutput: ({ output }) => [{ type: "text", text: JSON.stringify(output, null, 2) }],
        execute: (input, context) =>
          Effect.gen(function* () {
            const profile = input.profile ?? TriggerV2.ProfileName.make("local")
            yield* context.permission.assert({
              action: "trigger_manage",
              resources: [profile],
              save: ["*"],
              sessionID: context.sessionID,
              agent: context.agent,
              source: source(context),
            })
            const result = yield* triggers
              .execute({
                action: input.action,
                profile,
                sessionID: context.sessionID,
                triggerID: input.trigger_id,
                body: input.body,
              })
              .pipe(
                Effect.catchTag("Trigger.RuntimeError", (error) =>
                  Effect.succeed({ ok: false as const, code: error.code, message: error.message }),
                ),
              )
            if ("kind" in result && result.ok && result.kind === "local" && result.action === "run") {
              return {
                ...result,
                data: {
                  ...(result.data as Readonly<Record<string, TriggerV2.JsonValue>>),
                  instruction:
                    "The user approved running this trigger now. Execute its prompt in the current session turn.",
                },
              }
            }
            return result
          }).pipe(
            Effect.mapError(
              (error) =>
                Tool.toToolFailure(error) ?? new ToolFailure({ message: "Trigger operation was not approved" }),
            ),
          ),
      }),
      "trigger_manage",
    )

    yield* tools.register({ trigger_profiles: profiles, trigger_manage: manage }).pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/trigger",
  layer,
  deps: [ToolRegistry.node, ToolRegistry.builtInsNode, TriggerV2.node],
})
