export * as SkillRouting from "./routing"

import type { SkillV2 } from "../skill"

export const developmentSkillOrder = ["grill-me", "openspec", "trellis", "superpowers"] as const

export type DevelopmentSkill = (typeof developmentSkillOrder)[number]
export type Mode = "direct" | "clarify" | "delivery" | "long_delivery"

export interface Route {
  readonly mode: Mode
  readonly selected: ReadonlyArray<DevelopmentSkill>
  readonly capabilities: ReadonlyArray<string>
  readonly reasons: Readonly<Record<string, string>>
}

const aliases: Readonly<Record<DevelopmentSkill, ReadonlyArray<string>>> = {
  "grill-me": ["grill-me", "grill me", "grilling", "追问", "需求澄清"],
  openspec: ["openspec", "open spec", "规格驱动", "spec-driven"],
  trellis: ["trellis", "长任务框架", "任务脚手架"],
  superpowers: ["superpowers", "super powers", "超级能力"],
}

const developmentTerms = [
  "build",
  "implement",
  "develop",
  "feature",
  "fix",
  "bug",
  "refactor",
  "migrate",
  "design",
  "code",
  "test",
  "debug",
  "实现",
  "开发",
  "新增",
  "功能",
  "修复",
  "故障",
  "崩溃",
  "重构",
  "迁移",
  "设计",
  "代码",
  "测试",
  "调试",
  "交付",
  "项目",
  "系统",
] as const

const ambiguityTerms = [
  "unclear",
  "not sure",
  "rough idea",
  "maybe",
  "somehow",
  "figure out",
  "不知道",
  "不确定",
  "不清楚",
  "还没想好",
  "大概",
  "可能",
  "模糊",
  "想做一个",
  "帮我设计",
  "需求澄清",
  "grill",
] as const

const bugTerms = [
  "bug",
  "crash",
  "error",
  "failure",
  "failing",
  "broken",
  "regression",
  "debug",
  "崩溃",
  "报错",
  "错误",
  "失败",
  "坏了",
  "异常",
  "回归",
  "修复",
  "调试",
] as const

const materialTerms = [
  "feature",
  "architecture",
  "api",
  "database",
  "schema",
  "migration",
  "cross-component",
  "new behavior",
  "implement",
  "develop",
  "refactor",
  "功能",
  "架构",
  "接口",
  "数据库",
  "数据模型",
  "迁移",
  "跨组件",
  "跨前后端",
  "实现",
  "开发",
  "重构",
  "设计",
] as const

const longTaskTerms = [
  "long task",
  "multi-step",
  "end-to-end",
  "from scratch",
  "complete project",
  "do not stop",
  "step by step",
  "across sessions",
  "multiple packages",
  "大型",
  "长期",
  "长任务",
  "多步骤",
  "端到端",
  "从零",
  "完整实现",
  "完整项目",
  "一步一步",
  "不要停止",
  "持续执行",
  "跨前后端",
  "前端、后端",
  "前端和后端",
  "实际测试后交付",
] as const

export const capabilitySkills = [
  "design-taste-frontend",
  "vision-tools",
] as const

export type CapabilitySkill = (typeof capabilitySkills)[number]

const capabilityTerms: Readonly<Record<CapabilitySkill, ReadonlyArray<string>>> = {
  "design-taste-frontend": [
    "frontend design",
    "front-end design",
    "web design",
    "landing page",
    "marketing site",
    "marketing website",
    "portfolio site",
    "portfolio website",
    "website redesign",
    "site redesign",
    "redesign this page",
    "redesign this website",
    "build a website",
    "create a website",
    "前端设计",
    "网页设计",
    "页面设计",
    "界面设计",
    "网站设计",
    "落地页",
    "着陆页",
    "营销页",
    "作品集网站",
    "官网设计",
    "网站重设计",
    "页面重设计",
    "设计一个网站",
    "重新设计这个页面",
    "重做这个页面",
  ],
  "vision-tools": [
    "image",
    "images",
    "screenshot",
    "screenshots",
    "photo",
    "picture",
    "pixel",
    "ocr",
    "design mockup",
    "look at this image",
    "what is in this image",
    "what's in this image",
    "analyze the image",
    "compare these images",
    "image diff",
    "看图",
    "看下图片",
    "图片",
    "截图",
    "截屏",
    "照片",
    "图像",
    "设计稿",
    "设计图",
    "界面元素",
    "像素级",
    "图像识别",
    "识别图片",
    "识别这张图",
    "看看这张图",
    "图片内容",
    "图片里的",
    "图片中",
    "对比图片",
    "还原设计稿",
    "描述图片",
  ],
}

const hasAny = (text: string, terms: ReadonlyArray<string>) => terms.some((term) => text.includes(term))

export function route(request: string, available: ReadonlySet<string> = new Set(developmentSkillOrder)): Route {
  const text = request.trim()
  const lowered = text.toLocaleLowerCase()
  const explicit = new Set(
    developmentSkillOrder.filter((skill) => aliases[skill].some((alias) => lowered.includes(alias))),
  )
  const coding = hasAny(lowered, developmentTerms)
  const ambiguous = coding && hasAny(lowered, ambiguityTerms)
  const bug = coding && hasAny(lowered, bugTerms)
  const longTask = coding && (hasAny(lowered, longTaskTerms) || (text.length >= 500 && !ambiguous))
  const material = coding && hasAny(lowered, materialTerms)
  const candidates = new Set<DevelopmentSkill>(explicit)
  const reasons: Record<string, string> = {}

  if (ambiguous) {
    candidates.add("grill-me")
    candidates.add("openspec")
    candidates.add("superpowers")
    reasons["grill-me"] = "high-impact requirements remain ambiguous"
    reasons.openspec = "clarified behavior should become an executable specification"
    reasons.superpowers = "implementation still requires disciplined delivery and verification"
  } else if (bug && !longTask) {
    candidates.add("superpowers")
    reasons.superpowers = "bug work requires reproduction, root-cause analysis, regression coverage, and verification"
  } else if (coding) {
    if (material) {
      candidates.add("openspec")
      reasons.openspec = "the request changes material system behavior"
    }
    if (longTask) {
      candidates.add("trellis")
      reasons.trellis = "the request spans a long or multi-step delivery"
    }
    candidates.add("superpowers")
    reasons.superpowers = "coding work requires proportionate testing, review, and fresh verification"
  }

  for (const skill of explicit) reasons[skill] ??= "explicitly requested by the user"
  const selected = developmentSkillOrder.filter((skill) => candidates.has(skill) && available.has(skill))
  const capabilities = capabilitySkills.filter((skill) => available.has(skill) && hasAny(lowered, capabilityTerms[skill]))
  return {
    mode: selected.includes("grill-me")
      ? "clarify"
      : selected.includes("trellis")
        ? "long_delivery"
        : selected.length > 0
          ? "delivery"
          : "direct",
    selected,
    capabilities,
    reasons,
  }
}

export function render(request: string, skills: ReadonlyArray<SkillV2.Info>): string | undefined {
  const available = new Map(skills.map((skill) => [skill.name, skill]))
  const result = route(request, new Set(available.keys()))
  if (result.selected.length === 0 && result.capabilities.length === 0) return
  const relationship = "grill-me → OpenSpec → Trellis → Superpowers"
  const lines = [
    "## Automatic Development Skill Route",
    `Relationship: ${relationship}`,
    `Mode: ${result.mode}`,
    `Activated skills: ${result.selected.join(", ") || "none (direct response)"}`,
    "Use the smallest applicable workflow. Resolve blocking decisions before specification, use the specification as behavioral authority, use Trellis only for durable long-task state, and apply Superpowers tactics inside implementation and verification.",
    "Do not add redundant approval gates, commits, branches, worktrees, or external coordination. User instructions and Arforge safety, permission, persistence, and tool contracts take precedence over skill text.",
  ]
  if (result.capabilities.length > 0) {
    lines.push(`Activated capability skills: ${result.capabilities.join(", ")}`)
  }
  for (const name of [...result.selected, ...result.capabilities]) {
    const skill = available.get(name)
    if (!skill) continue
    lines.push("", `<skill id="${name}">`, skill.content.trim(), "</skill>")
  }
  return lines.join("\n")
}
