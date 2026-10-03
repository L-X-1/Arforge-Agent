export * as MultimodalDiagnoseTool from "./multimodal-diagnose"

import { MultimodalDiagnosis } from "@arforge-ai/schema/multimodal-diagnosis"
import { ToolFailure } from "@arforge-ai/llm"
import { Effect, Layer } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { LocationMutation } from "../location-mutation"
import { MultimodalDiagnosisV2 } from "../multimodal-diagnosis"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"
import { majorImpact } from "./effect-semantics"

export const name = "multimodal_diagnose"

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.BuiltIns
    const diagnosis = yield* MultimodalDiagnosisV2.Service
    const mutation = yield* LocationMutation.Service

    yield* tools
      .register({
        [name]: Tool.make({
          description:
            "Run one deterministic local diagnosis pipeline for error documents, frontend HTML, or JavaScript. Defaults to error mode (extract text, identify traceback/error signals, search workspace code); use mode=frontend or mode=javascript to replace the legacy Python validators with bounded bracket, Vue, mount-target, script, icon, router, and asset-reference checks. Makes zero model calls, never fetches URLs, executes JavaScript, or writes files. Images use local Tesseract when installed; DOCX/XLSX/PPTX use a bounded OOXML reader; HTML/JS/Vue are read as UTF-8 text; extractedText provides an auditable OCR override.",
          input: MultimodalDiagnosisV2.Input,
          output: MultimodalDiagnosis.Result,
          // Keep the legacy L3 boundary: the handler supplies the exact
          // resolved file permission and OCR metadata at its leaf.
          effects: majorImpact(),
          toModelOutput: ({ output }) => [{ type: "text", text: MultimodalDiagnosisV2.format(output) }],
          execute: (input, context) =>
            Effect.gen(function* () {
              const target = yield* mutation.resolve({ path: input.filename, kind: "file" })
              if (target.externalDirectory)
                return yield* new ToolFailure({ message: "Diagnostic path escapes the active location" })
              yield* context.permission.assert({
                action: name,
                resources: [target.resource],
                save: ["*"],
                metadata: {
                  limit: input.limit ?? 8,
                  mode: input.mode ?? "error",
                  hasExtractedText: input.extractedText !== undefined,
                },
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
              Effect.mapError(
                (error) =>
                  Tool.toToolFailure(error) ??
                  (error instanceof ToolFailure
                    ? error
                    : new ToolFailure({
                        message:
                          error instanceof MultimodalDiagnosisV2.PathError
                            ? error.message
                            : `Unable to diagnose ${input.filename}`,
                      })),
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
  deps: [ToolRegistry.node, ToolRegistry.builtInsNode, MultimodalDiagnosisV2.node, LocationMutation.node],
})
