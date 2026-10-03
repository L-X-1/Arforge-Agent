/**
 * Deterministic rendering for the historical `memory digest` command.
 *
 * The analysis layer owns category normalization, ordering, and the JSON/
 * Markdown projections.  It deliberately accepts already-scoped Memory.Info
 * projections so the CLI cannot open a second database or bypass workspace
 * visibility.
 */

export const CATEGORY_LABELS: Readonly<Record<string, string>> = {
  identity: "用户身份信息",
  preference: "偏好与习惯",
  convention: "项目约定与规范",
  workflow: "工作流",
  constraint: "约束与规则",
  fact: "客观事实",
  error: "错误模式",
  error_pattern: "错误模式",
  pattern: "错误模式",
  project: "项目信息",
  knowledge: "知识",
}

export const CATEGORY_ORDER: ReadonlyArray<string> = [
  "identity",
  "preference",
  "convention",
  "workflow",
  "constraint",
  "fact",
  "error",
  "error_pattern",
  "pattern",
  "project",
  "knowledge",
]

export interface MemoryDigestItem {
  readonly id: string
  readonly content: string
  readonly type: string
  readonly tags: ReadonlyArray<string>
  readonly importance: number
  readonly source: string
  readonly createdAt: string
  readonly projectID?: string
  readonly workspacePath?: string
}

export interface MemoryDigestGroup {
  readonly category: string
  readonly label: string
  readonly items: ReadonlyArray<MemoryDigestItem>
}

export interface MemoryDigestReport {
  readonly schema_version: 1
  readonly generated_at: string
  readonly total: number
  readonly category_count: number
  readonly categories: ReadonlyArray<{
    readonly category: string
    readonly label: string
    readonly count: number
    readonly items: ReadonlyArray<{
      readonly content: string
      readonly mem_type: string
      readonly importance: number
      readonly source: string
      readonly tags: string
      readonly created_at: string
      readonly project_id: string
      readonly workspace_path: string
    }>
  }>
  readonly truncated: boolean
}

export interface MemoryDigestOptions {
  readonly categoryFilter?: string
  readonly generatedAt?: string
  /** Number of rows requested from the scoped Memory API. */
  readonly sourceLimit?: number
}

const DEFAULT_SOURCE_LIMIT = 500

export function categoryOf(type: string): string {
  const normalized = type.trim().toLowerCase()
  return Object.prototype.hasOwnProperty.call(CATEGORY_LABELS, normalized) ? normalized : "knowledge"
}

export function categoryLabel(category: string): string {
  return CATEGORY_LABELS[category] ?? CATEGORY_LABELS.knowledge
}

function categoryName(category: string): string {
  return `${category} · ${categoryLabel(category)}`
}

function orderedCategories(groups: ReadonlyMap<string, ReadonlyArray<MemoryDigestItem>>): ReadonlyArray<string> {
  const known = CATEGORY_ORDER.filter((category) => groups.has(category))
  const unknown = [...groups.keys()].filter((category) => !CATEGORY_ORDER.includes(category)).toSorted()
  return [...known, ...unknown]
}

function filteredGroups(
  items: ReadonlyArray<MemoryDigestItem>,
  categoryFilter: string,
): ReadonlyMap<string, ReadonlyArray<MemoryDigestItem>> {
  const groups = new Map<string, MemoryDigestItem[]>()
  for (const item of items) {
    const category = categoryOf(item.type)
    const group = groups.get(category) ?? []
    group.push(item)
    groups.set(category, group)
  }
  const requested = categoryFilter.trim().toLowerCase()
  const requestedIsKnown = Object.prototype.hasOwnProperty.call(CATEGORY_LABELS, requested)
  const entries = [...groups.entries()]
    .filter(
      ([category]) =>
        !requested ||
        category === requested ||
        (requestedIsKnown && categoryOf(requested) === category),
    )
    .map(([category, group]) => [
      category,
      group.toSorted(
        (left, right) =>
          right.importance - left.importance ||
          right.createdAt.localeCompare(left.createdAt) ||
          right.id.localeCompare(left.id),
      ),
    ] as const)
  return new Map(entries)
}

export function groupMemoryDigest(
  items: ReadonlyArray<MemoryDigestItem>,
  categoryFilter = "",
): ReadonlyArray<MemoryDigestGroup> {
  const groups = filteredGroups(items, categoryFilter)
  return orderedCategories(groups).map((category) => ({
    category,
    label: categoryLabel(category),
    items: groups.get(category) ?? [],
  }))
}

function stars(importance: number): string {
  return "★".repeat(Math.min(Math.max(Math.trunc(importance || 1), 1), 5))
}

function entryLine(item: MemoryDigestItem): string {
  const details = [`重要性 ${stars(item.importance)}`]
  if (item.source) details.push(`来源 ${item.source}`)
  if (item.createdAt) details.push(`记录于 ${item.createdAt}`)
  if (item.tags.length > 0) details.push(`标签 ${item.tags.join(",")}`)
  if (item.workspacePath) details.push(`工作区 ${item.workspacePath}`)
  if (item.projectID) details.push(`项目 ${item.projectID}`)
  return [`- ${item.content.trim()}`, `  (${details.join("; ")})`].join("\n")
}

export function renderMemoryDigest(
  groups: ReadonlyArray<MemoryDigestGroup>,
  generatedAt: string,
  title = "Arforge 长期记忆档案",
): string {
  const total = groups.reduce((sum, group) => sum + group.items.length, 0)
  const lines = [`# ${title}`, "", `> 生成时间：${generatedAt}  ·  共 ${total} 条长期记忆`, ""]
  if (groups.length > 0) {
    lines.push("## 类别概览", "", "| 类别 | 条数 |", "|---|---|")
    for (const group of groups) lines.push(`| ${categoryName(group.category)} | ${group.items.length} |`)
    lines.push("")
  }
  for (const group of groups) {
    lines.push(`## ${categoryName(group.category)}（${group.items.length} 条）`, "")
    for (const item of group.items) lines.push(entryLine(item), "")
  }
  return lines.join("\n")
}

export function buildMemoryDigestReport(
  items: ReadonlyArray<MemoryDigestItem>,
  options: MemoryDigestOptions = {},
): MemoryDigestReport {
  const sourceLimit =
    Number.isInteger(options.sourceLimit) && options.sourceLimit! > 0 ? options.sourceLimit! : DEFAULT_SOURCE_LIMIT
  const groups = groupMemoryDigest(items, options.categoryFilter)
  return {
    schema_version: 1,
    generated_at: options.generatedAt ?? new Date().toISOString(),
    total: groups.reduce((sum, group) => sum + group.items.length, 0),
    category_count: groups.length,
    categories: groups.map((group) => ({
      category: group.category,
      label: group.label,
      count: group.items.length,
      items: group.items.map((item) => ({
        content: item.content,
        mem_type: item.type,
        importance: item.importance,
        source: item.source,
        tags: item.tags.join(","),
        created_at: item.createdAt,
        project_id: item.projectID ?? "",
        workspace_path: item.workspacePath ?? "",
      })),
    })),
    truncated: items.length >= sourceLimit,
  }
}

export const MemoryDigestAnalysis = {
  categoryOf,
  group: groupMemoryDigest,
  render: renderMemoryDigest,
  report: buildMemoryDigestReport,
}
