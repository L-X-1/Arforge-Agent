export * as MultimodalDiagnoseTool from "./multimodal-diagnose"

import { MultimodalDiagnosis } from "@arforge-ai/schema/multimodal-diagnosis"
import { ToolFailure } from "@arforge-ai/llm"
import { Effect, Layer } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { LocationMutation } from "../location-mutation"
import { MultimodalDiagnosisV2 } from "../multimodal-diagnosis"
import { PermissionV2 } from "../permission"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "multimodal_diagnose"

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const diagnosis = yield* MultimodalDiagnosisV2.Service
    const mutation = yield* LocationMutation.Service
    const permission = yield* PermissionV2.Service

    yield* tools
      .register({
        [name]: Tool.make({
          description:
            "Run a deterministic local diagnosis of an error screenshot or document: extract or accept text, identify traceback/error signals, search workspace code, and return repair-oriented suggestions. Makes zero model calls and never writes files. Images use local Tesseract when installed; extractedText provides an auditable OCR override.",
          input: MultimodalDiagnosisV2.Input,
          output: MultimodalDiagnosis.Result,
          toModelOutput: ({ output }) => [{ type: "text", text: MultimodalDiagnosisV2.format(output) }],
          execute: (input, context) =>
            Effect.gen(function* () {
              const target = yield* mutation.resolve({ path: input.filename, kind: "file" })
              if (target.externalDirectory)
                return yield* new ToolFailure({ message: "Diagnostic path escapes the active location" })
              yield* permission.assert({
                action: name,
                resources: [target.resource],
                save: ["*"],
                metadata: { limit: input.limit ?? 8, hasExtractedText: input.extractedText !== undefined },
                sessionID: context.sessionID,
                agent: context.agent,
                source: {
                  type: "tool",
                  messageID: context.assistantMessageID,
                  callID: context.toolCallID,
                },
              })
              return yield* diagnosis.diagnose(input)
            }).pipe(
              Effect.mapError((error) =>
                error instanceof ToolFailure
                  ? error
                  : new ToolFailure({
                      message:
                        error instanceof MultimodalDiagnosisV2.PathError
                          ? error.message
                          : `Unable to diagnose ${input.filename}`,
                    }),
              ),
            ),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/multimodal-diagnose",
  layer,
  deps: [ToolRegistry.node, MultimodalDiagnosisV2.node, LocationMutation.node, PermissionV2.node],
})
