export * as PrimaryDeliveryTool from "./primary-delivery"

import { PrimaryDelivery } from "@arforge-ai/schema/primary-delivery"
import { ToolFailure } from "@arforge-ai/llm"
import { DateTime, Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { PrimaryDeliveryV2 } from "../primary-delivery"
import { NonNegativeInt } from "../schema"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "deliver_user_message"

export const Input = Schema.Struct({
  message: Schema.String.check(
    Schema.isTrimmed(),
    Schema.isNonEmpty(),
    Schema.isMaxLength(PrimaryDeliveryV2.MAX_MESSAGE_CHARS),
  ).annotate({ description: "The primary user-visible Markdown message" }),
  status: PrimaryDelivery.Status.annotate({
    description: "normal for a direct response; proactive only for an unsolicited important update",
  }),
  attachments: Schema.Array(Schema.String)
    .check(Schema.isMaxLength(PrimaryDeliveryV2.MAX_ATTACHMENTS))
    .pipe(Schema.optional),
})

export const Output = Schema.Struct({
  delivered: Schema.Literal(true),
  status: PrimaryDelivery.Status,
  attachmentCount: NonNegativeInt,
  sentAt: Schema.String,
  localOnly: Schema.Literal(true),
  uploaded: Schema.Literal(false),
})

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const deliveries = yield* PrimaryDeliveryV2.Service
    yield* tools
      .register({
        [name]: Tool.withPermission(
          Tool.make({
            description:
              "Deliver the primary message the user should see. Use proactive only for an unsolicited completion, blocker, or important background update. Optional attachments must be existing approved local files and are never uploaded.",
            input: Input,
            output: Output,
            toModelOutput: ({ output }) => [
              {
                type: "text",
                text: `Primary message delivered (${output.status}, ${output.attachmentCount} local attachment(s)). Do not emit a duplicate answer.`,
              },
            ],
            execute: (input, context) =>
              deliveries
                .deliver({
                  sessionID: context.sessionID,
                  agent: context.agent,
                  assistantMessageID: context.assistantMessageID,
                  callID: context.toolCallID,
                  message: input.message,
                  status: input.status,
                  attachments: input.attachments ?? [],
                })
                .pipe(
                  Effect.map((delivery) => ({
                    delivered: true as const,
                    status: delivery.status,
                    attachmentCount: delivery.attachmentCount,
                    sentAt: DateTime.formatIso(delivery.sentAt),
                    localOnly: true as const,
                    uploaded: false as const,
                  })),
                  Effect.mapError((error) => new ToolFailure({ message: error.message })),
                ),
          }),
          name,
        ),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/primary-delivery",
  layer,
  deps: [ToolRegistry.node, PrimaryDeliveryV2.node],
})
