export * as SystemContextBuiltIns from "./builtins"

import { makeLocationNode } from "../effect/app-node"
import { DateTime, Effect, Layer, Schema } from "effect"
import { Location } from "../location"
import { SystemContext } from "./index"
import { InstructionContext } from "../instruction-context"
import { SystemContextRegistry } from "./registry"
import { FSUtil } from "../fs-util"
import { Global } from "../global"

export const DEFAULT_VISIBLE_LANGUAGE_GUIDANCE = [
  "<output_language>",
  "所有用户可见内容默认使用简体中文。",
  "推理过程和思考摘要必须使用简体中文；即使系统模板、工具结果或上下文是英文，也要用简体中文叙述。",
  "代码、命令、文件路径、API、协议名和无法准确翻译的专业术语保留原文。",
  "不要展示隐藏思维链；需要解释判断时，只给出简洁、面向结论且可验证的中文推理摘要。",
  "输出采用清晰的短段落与必要的列表，避免重复问题、冗长前言和无意义的状态播报。",
  "</output_language>",
].join("\n")

const builtIns = Layer.effectDiscard(
  Effect.gen(function* () {
    const location = yield* Location.Service
    const registry = yield* SystemContextRegistry.Service
    const environment = [
      "<env>",
      `  Working directory: ${location.directory}`,
      `  Workspace root folder: ${location.project.directory}`,
      `  Is directory a git repo: ${location.vcs?.type === "git" ? "yes" : "no"}`,
      `  Platform: ${process.platform}`,
      "</env>",
    ].join("\n")
    const context = SystemContext.combine([
      SystemContext.make({
        key: SystemContext.Key.make("core/environment"),
        codec: Schema.toCodecJson(Schema.String),
        load: Effect.succeed(environment),
        baseline: (environment) =>
          ["Here is some useful information about the environment you are running in:", environment].join("\n"),
        update: (_previous, environment) => ["The environment you are running in is now:", environment].join("\n"),
      }),
      SystemContext.make({
        key: SystemContext.Key.make("core/date"),
        codec: Schema.toCodecJson(Schema.String),
        load: DateTime.nowAsDate.pipe(Effect.map((date) => date.toDateString())),
        baseline: (date) => `Today's date: ${date}`,
        update: (_previous, date) => `Today's date is now: ${date}`,
      }),
      SystemContext.make({
        key: SystemContext.Key.make("core/output-language"),
        codec: Schema.toCodecJson(Schema.String),
        load: Effect.succeed("zh-CN"),
        baseline: () => DEFAULT_VISIBLE_LANGUAGE_GUIDANCE,
        update: () => "用户可见的默认输出语言仍为简体中文；专业术语保留准确原文。",
      }),
    ])

    yield* registry.register({ key: SystemContext.Key.make("core/builtins"), load: Effect.succeed(context) })
  }),
)

export const node = makeLocationNode({
  name: "system-context-builtins",
  layer: builtIns,
  deps: [Location.node, SystemContextRegistry.node, InstructionContext.node, FSUtil.node, Global.node],
})
