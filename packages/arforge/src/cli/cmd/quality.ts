import { AnalysisQuality } from "@arforge-ai/core/analysis/quality"
import { Effect } from "effect"
import { readFile, stat } from "node:fs/promises"
import { EOL } from "node:os"
import { resolve } from "node:path"
import { effectCmd, fail } from "../effect-cmd"

const MAX_PATCH_CHARS = 500_000

class LegacyQualityPatchError extends Error {
  readonly exitCode = 2
}

function hasPatchExtension(value: string): boolean {
  const normalized = value.trim().toLowerCase()
  return normalized.endsWith(".diff") || normalized.endsWith(".patch")
}

function looksLikeUnifiedDiff(value: string): boolean {
  const lines = value.split(/\r?\n/)
  const hasGitHeader = lines.some((line) => line.startsWith("diff --git "))
  const hasFileHeaders = lines.some((line) => line.startsWith("--- ")) && lines.some((line) => line.startsWith("+++ "))
  const hasHunk = lines.some((line) => line.startsWith("@@"))
  return hasGitHeader || (hasFileHeaders && hasHunk)
}

type PatchInput = {
  readonly files: string[]
  readonly patchText: string | undefined
}

async function resolvePatchInput(workspace: string, files: string[], explicitPatchFile?: string): Promise<PatchInput> {
  const explicit = explicitPatchFile?.trim()
  if (explicit) {
    const value = await readFile(resolve(workspace, explicit), "utf8")
    if (value.length > MAX_PATCH_CHARS) throw new Error(`补丁超过 ${MAX_PATCH_CHARS.toLocaleString("en-US")} 字符限制。`)
    return { files, patchText: value }
  }

  // The Python CLI historically accepted `quality <patch-file>`.  Keep that
  // spelling in the same handler only when there is one positional input and
  // it is unambiguously a patch by extension or by unified-diff structure.
  // Ordinary `quality module.ts` therefore keeps the canonical file-quality
  // behavior, while `.diff`/`.patch` files (including missing ones) fail as
  // patch inputs instead of silently becoming missing source files.
  if (files.length !== 1) return { files, patchText: undefined }
  const candidate = files[0].trim()
  if (!candidate) return { files, patchText: undefined }
  const candidatePath = resolve(workspace, candidate)
  const extensionMatch = hasPatchExtension(candidate)
  let value: string
  try {
    const metadata = await stat(candidatePath)
    if (!metadata.isFile()) {
      if (extensionMatch) throw new LegacyQualityPatchError("目标不是文件。")
      return { files, patchText: undefined }
    }
    // Avoid reading an arbitrary large source file just to classify it. An
    // explicitly named patch still gets the normal size guard below.
    if (!extensionMatch && metadata.size > MAX_PATCH_CHARS) return { files, patchText: undefined }
    value = await readFile(candidatePath, "utf8")
  } catch (error) {
    if (extensionMatch) {
      throw new LegacyQualityPatchError(error instanceof Error ? error.message : String(error))
    }
    return { files, patchText: undefined }
  }

  if (!extensionMatch && !looksLikeUnifiedDiff(value)) return { files, patchText: undefined }
  if (value.length > MAX_PATCH_CHARS) {
    throw new LegacyQualityPatchError(`补丁超过 ${MAX_PATCH_CHARS.toLocaleString("en-US")} 字符限制。`)
  }
  return { files: [], patchText: value }
}

export const QualityCommand = effectCmd({
  command: "quality [files..]",
  describe: "运行 Arforge Agent 的只读交付质量门禁",
  instance: false,
  builder: (yargs) =>
    yargs
      .positional("files", {
        describe: "要检查的工作区相对文件；单个 .diff/.patch 位置参数兼容 Python 旧补丁入口",
        type: "string",
        array: true,
      })
      .option("workspace", {
        describe: "工作区目录，默认为当前目录",
        type: "string",
      })
      .option("patch-file", {
        describe: "可选的 unified diff 文件；也可用单个 .diff/.patch 位置参数",
        type: "string",
      })
      .option("json", {
        describe: "输出机器可读 JSON",
        type: "boolean",
        default: false,
      }),
  handler: Effect.fn("Cli.quality")(function* (args) {
    const workspace = resolve(args.workspace ?? process.cwd())
    const input = yield* Effect.tryPromise({
      try: async () => {
        return await resolvePatchInput(workspace, [...(args.files ?? [])], args.patchFile)
      },
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
    }).pipe(
      Effect.catch((error) =>
        fail(`无法读取补丁：${error.message}`, error instanceof LegacyQualityPatchError ? error.exitCode : 1),
      ),
    )

    const result = AnalysisQuality.assessQualityChange(input.files, {
      patchText: input.patchText,
      root: workspace,
    })

    if (args.json) {
      process.stdout.write(JSON.stringify({ workspace, ...result }, null, 2) + EOL)
      return
    }

    const status = result.passed ? "通过" : "需要复核"
    process.stdout.write(`Arforge 交付质量：${status}（${result.score}/100）${EOL}`)
    process.stdout.write(`工作区：${workspace}${EOL}`)
    process.stdout.write(`${result.summary}${EOL}`)
    if (result.diff_stats) {
      process.stdout.write(
        `变更：${result.diff_stats.files_changed} 个文件，+${result.diff_stats.additions}/-${result.diff_stats.deletions}，${result.diff_stats.hunks} 个区块${EOL}`,
      )
    }
    for (const issue of result.issues) {
      const file = issue.file ? ` ${issue.file}` : ""
      process.stdout.write(`- [${issue.level}] ${issue.code}:${file} ${issue.message}${EOL}`)
    }
  }),
})
