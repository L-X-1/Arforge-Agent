/**
 * L0-L7 context layering compiler.
 *
 * The blueprint's context stack:
 *   L0 宪法与安全约束 / L1 Agent 身份与能力边界 / L2 用户长期偏好
 *   L3 项目稳定事实 / L4 任务状态与推理策略 / L5 检索到的相关记忆
 *   L6 最近交互 / L7 工具定义
 *
 * `compileContext` orders inputs by layer, reports per-layer token usage, and
 * optionally prunes high layers under a token budget (L0-L2 are protected).
 */

import type { ContextLayerReport } from "./insight"
import { ContextContract } from "../context-contract"

export const CONTEXT_LAYER_ORDER = ["L0", "L1", "L2", "L3", "L4", "L5", "L6", "L7"] as const

export const CONTEXT_LAYER_NAMES: Readonly<Record<string, string>> = {
  L0: "宪法与安全约束",
  L1: "Agent 身份与能力边界",
  L2: "用户长期偏好",
  L3: "项目稳定事实",
  L4: "任务状态与推理策略",
  L5: "检索到的相关记忆",
  L6: "最近交互",
  L7: "工具定义",
}

export interface LayerInput {
  readonly layer: string
  readonly name: string
  readonly text: string
  /** Canonical Context OS metadata; legacy callers are normalized below. */
  readonly origin?: ContextContract.Origin
  readonly contextLayer?: ContextContract.ContextLayer
  readonly authority?: ContextContract.Authority
  readonly trust?: ContextContract.Trust
  readonly mandatory?: boolean
  readonly priority?: number
  readonly unitID?: string
  readonly sourceDigest?: string
  readonly instructionAllowed?: boolean
}

export interface CompiledContext {
  readonly parts: ReadonlyArray<string>
  readonly layers: ReadonlyArray<ContextLayerReport>
  readonly totalTokens: number
}

const CHARS_PER_TOKEN = 4

export function estimateTokens(text: string): number {
  return Math.max(0, Math.round(text.length / CHARS_PER_TOKEN))
}

function layerIndex(layer: string): number {
  const index = CONTEXT_LAYER_ORDER.indexOf(layer as (typeof CONTEXT_LAYER_ORDER)[number])
  return index === -1 ? CONTEXT_LAYER_ORDER.length : index
}

const PROTECTED_LAYERS = new Set(["L0", "L1", "L2"])

type MutableLayerReport = {
  layer: string
  name: string
  source: string
  unitID: string
  origin: ContextContract.Origin
  contextLayer: ContextContract.ContextLayer
  authority: ContextContract.Authority
  trust: ContextContract.Trust
  mandatory: boolean
  priority: number
  sourceDigest?: string
  instructionAllowed?: boolean
  tokens: number
  chars: number
  kept: boolean
}

export function compileContext(inputs: ReadonlyArray<LayerInput>, maxTokens: number | null = null): CompiledContext {
  // Keep the caller's order verbatim: layering is an annotation, not a reorder.
  const ordered = [...inputs]
  const layers: MutableLayerReport[] = ordered.map((input) => {
    const origin = input.origin ?? ContextContract.originForLegacy(input.layer, input.name)
    const contextLayer = input.contextLayer ?? ContextContract.contextLayerForLegacy(input.layer)
    const authority = input.authority ?? ContextContract.authorityForOrigin(origin)
    const trust = input.trust ?? ContextContract.trustForOrigin(origin)
    const chars = input.text.length
    return {
      layer: input.layer,
      name: input.name,
      source: CONTEXT_LAYER_NAMES[input.layer] ?? input.layer,
      unitID: input.unitID ?? `${origin}:${input.name}`,
      origin,
      contextLayer,
      authority,
      trust,
      mandatory: input.mandatory ?? false,
      priority: input.priority ?? 0,
      ...(input.sourceDigest === undefined ? {} : { sourceDigest: input.sourceDigest }),
      ...(input.instructionAllowed === undefined ? {} : { instructionAllowed: input.instructionAllowed }),
      tokens: estimateTokens(input.text),
      chars,
      kept: true,
    }
  })
  const total = layers.reduce((sum, layer) => sum + layer.tokens, 0)
  const keptInputs = ordered.map((input) => input.text)

  if (maxTokens !== null && total > maxTokens) {
    let deficit = total - maxTokens
    // Prune by layer priority (highest number first) without reordering.
    const indices = ordered
      .map((input, index) => ({ index, priority: layerIndex(input.layer) }))
      .toSorted((a, b) => b.priority - a.priority)
    for (const { index, priority } of indices) {
      if (deficit <= 0) break
      if (layers[index].mandatory || PROTECTED_LAYERS.has(ordered[index].layer)) continue
      if (layers[index].tokens <= deficit) {
        deficit -= layers[index].tokens
        layers[index].kept = false
        layers[index].tokens = 0
        layers[index].chars = 0
        keptInputs[index] = ""
      } else {
        const keepChars = Math.max(0, ordered[index].text.length - Math.ceil(deficit * CHARS_PER_TOKEN))
        keptInputs[index] = ordered[index].text.slice(0, keepChars)
        layers[index].tokens = estimateTokens(keptInputs[index])
        layers[index].chars = keptInputs[index].length
        deficit = 0
      }
      void priority
    }
  }

  const parts = keptInputs.filter((part) => part.length > 0)
  return {
    parts,
    layers,
    totalTokens: layers.filter((layer) => layer.kept).reduce((sum, layer) => sum + layer.tokens, 0),
  }
}

export function isLayer(value: string): value is (typeof CONTEXT_LAYER_ORDER)[number] {
  return CONTEXT_LAYER_ORDER.includes(value as (typeof CONTEXT_LAYER_ORDER)[number])
}
