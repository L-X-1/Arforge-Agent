/**
 * Native capability catalog and system facts — native TS replacement for the
 * retired Python ``capability_registry`` and ``status`` surfaces. The catalog
 * is the same 18-entry product directory the Python registry advertised;
 * the TypeScript core is now the single source of truth.
 */

import { InstallationChannel, InstallationVersion } from "./installation/version"

export interface CatalogEntry {
  readonly name: string
  readonly description: string
  readonly kind: string
  readonly keywords: string[]
  readonly priority: number
  readonly enabled: boolean
}

export const CAPABILITY_CATALOG: CatalogEntry[] = [
  {
    name: "safe_modify",
    description: "Safely modify files with backup, diff, verification, and rollback",
    kind: "security",
    keywords: ["modify file", "safe write", "修改文件", "安全写入", "patch", "apply fix", "修复文件", "correct file"],
    priority: 8,
    enabled: true,
  },
  {
    name: "memory_search",
    description: "Search local memory and knowledge base for relevant context",
    kind: "memory",
    keywords: ["remember", "memory", "记忆", "recall", "history", "past", "之前", "历史"],
    priority: 10,
    enabled: true,
  },
  {
    name: "planning",
    description: "Create structured task plans with steps, risks, and estimates",
    kind: "context",
    keywords: ["plan", "规划", "计划", "roadmap", "steps", "步骤", "architecture", "架构", "design"],
    priority: 10,
    enabled: true,
  },
  {
    name: "security_review",
    description: "Audit code or system configuration for security vulnerabilities",
    kind: "security",
    keywords: ["security", "安全", "vulnerability", "漏洞", "exploit", "injection", "permission", "权限", "audit security"],
    priority: 12,
    enabled: true,
  },
  {
    name: "code_review",
    description: "Review code for bugs, style issues, and potential improvements",
    kind: "tool",
    keywords: ["review", "code review", "审查", "检查代码", "inspect", "audit", "analyze", "analyse", "fix", "fix bug", "修复", "debug"],
    priority: 15,
    enabled: true,
  },
  {
    name: "test_generation",
    description: "Generate unit tests for provided code or module",
    kind: "tool",
    keywords: ["test", "generate test", "测试", "单元测试", "pytest", "unittest", "写测试", "add tests"],
    priority: 18,
    enabled: true,
  },
  {
    name: "code_search",
    description: "Search the local project codebase for symbols, patterns, and references",
    kind: "context",
    keywords: ["search code", "find in code", "代码搜索", "搜索代码", "grep", "symbol", "定义", "definition", "where is", "在哪里"],
    priority: 20,
    enabled: true,
  },
  {
    name: "learning_injection",
    description: "Inject learned patterns, preferences, and error fixes into context",
    kind: "memory",
    keywords: ["learn", "学习", "pattern", "模式", "preference", "偏好", "error pattern", "错误模式", "inject learning"],
    priority: 25,
    enabled: true,
  },
  {
    name: "command_execution",
    description: "Execute whitelisted system commands in a sandboxed environment",
    kind: "tool",
    keywords: ["execute", "run command", "执行命令", "cmd", "terminal", "shell"],
    priority: 30,
    enabled: true,
  },
  {
    name: "multimodal_inspection",
    description: "Inspect images, documents, and other non-text content",
    kind: "multimodal",
    keywords: ["image", "图片", "ocr", "document", "文档", "pdf", "screenshot", "截图", "multimodal", "多模态"],
    priority: 35,
    enabled: true,
  },
  {
    name: "debug_diagnose",
    description: "根据错误信息诊断问题并定位代码",
    kind: "security",
    keywords: ["调试", "debug", "诊断", "diagnose", "错误", "error", "traceback", "堆栈"],
    priority: 60,
    enabled: true,
  },
  {
    name: "diff_apply",
    description: "应用 unified diff 补丁到文件",
    kind: "tool",
    keywords: ["应用补丁", "apply patch", "diff apply", "打补丁", "patch"],
    priority: 65,
    enabled: true,
  },
  {
    name: "web_search",
    description: "搜索网页获取最新信息（DuckDuckGo）",
    kind: "tool",
    keywords: ["搜索", "search", "web", "网页", "查询", "查找在线", "上网查"],
    priority: 70,
    enabled: true,
  },
  {
    name: "refactor_suggest",
    description: "基于 AST 分析给出重构建议",
    kind: "model",
    keywords: ["重构建议", "refactor", "代码优化", "改进代码", "代码坏味道", "code smell"],
    priority: 70,
    enabled: true,
  },
  {
    name: "doc_extraction",
    description: "从 PDF/Word/Excel 提取文本内容",
    kind: "tool",
    keywords: ["提取文档", "读pdf", "读word", "读excel", "doc", "pdf", "文档内容", "extract"],
    priority: 75,
    enabled: true,
  },
  {
    name: "data_analysis",
    description: "加载数据、计算统计、生成可视化建议",
    kind: "tool",
    keywords: ["数据分析", "统计", "图表", "可视化", "data analysis", "chart", "plot"],
    priority: 75,
    enabled: true,
  },
  {
    name: "dependency_check",
    description: "检查项目依赖安全漏洞（pip-audit / npm audit）",
    kind: "tool",
    keywords: ["依赖检查", "dependency", "安全漏洞", "vulnerability", "pip audit", "npm audit", "依赖审计"],
    priority: 80,
    enabled: true,
  },
  {
    name: "git_operation",
    description: "执行 Git 操作（status/diff/log/show）",
    kind: "tool",
    keywords: ["git", "commit", "分支", "branch", "diff", "log", "status", "提交"],
    priority: 85,
    enabled: true,
  },
]

export interface NativeHealth {
  readonly status: "ok"
  readonly brand: string
  readonly version: string
  readonly python: string
  readonly python_supported: boolean
}

export function nativeHealth(): NativeHealth {
  return {
    status: "ok",
    brand: "Arforge Agent",
    version: InstallationVersion,
    python: "ts-core",
    python_supported: true,
  }
}

export interface NativeStatus {
  readonly schema_version: number
  readonly brand: string
  readonly version: string
  readonly channel: string
  readonly status: string
  readonly capabilities: number
}

export function nativeStatus(): NativeStatus {
  return {
    schema_version: 1,
    brand: "Arforge Agent",
    version: InstallationVersion,
    channel: InstallationChannel,
    status: "ok",
    capabilities: CAPABILITY_CATALOG.filter((entry) => entry.enabled).length,
  }
}

export interface NativeFeature {
  readonly flag_id: string
  readonly default: boolean
  readonly description: string
  readonly enabled: boolean
  readonly source: string
  readonly environment_variable: string
}

/**
 * TS-native feature policy. These are the runtime switches the TypeScript
 * core actually honors; the retired Python ``feature_flags.json`` is no
 * longer authoritative.
 */
export function nativeFeatures(): { schema_version: number; source: string; items: NativeFeature[] } {
  const items: NativeFeature[] = [
    {
      flag_id: "file_history",
      default: true,
      description: "Session-scoped file revision history and diff re-review.",
      enabled: true,
      source: "typescript-core",
      environment_variable: "",
    },
    {
      flag_id: "session_export",
      default: true,
      description: "Safe export of visible session content and artifact metadata.",
      enabled: true,
      source: "typescript-core",
      environment_variable: "",
    },
    {
      flag_id: "multimodal_diagnosis",
      default: true,
      description: "Local OCR/PDF/text signals matched against the workspace.",
      enabled: true,
      source: "typescript-core",
      environment_variable: "",
    },
    {
      flag_id: "governed_evolution",
      default: true,
      description: "Governed, evidence-driven evolution of bounded runtime strategy overlays.",
      enabled: true,
      source: "typescript-core",
      environment_variable: "",
    },
    {
      flag_id: "skill_routing",
      default: true,
      description: "Deterministic development skill routing (grill-me → OpenSpec → Trellis → Superpowers).",
      enabled: true,
      source: "typescript-core",
      environment_variable: "",
    },
    {
      flag_id: "references",
      default: true,
      description: "External local and Git reference directories as supporting context.",
      enabled: true,
      source: "typescript-core",
      environment_variable: "",
    },
  ]
  return { schema_version: 1, source: "typescript-core", items }
}

export * as CapabilityCatalog from "./capability-catalog"
