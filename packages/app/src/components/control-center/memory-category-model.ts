/**
 * Memory category model — groups long-term memories by type for the
 * categorized archive view in the control center. Labels intentionally match
 * the Python `memory digest` document so CLI and desktop show the same names.
 */

export interface MemoryCategoryItem {
  readonly id: string
  readonly content: string
  readonly type: string
  readonly importance: number
  [key: string]: unknown
}

export const MEMORY_CATEGORY_LABELS: Readonly<Record<string, string>> = {
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

const MEMORY_CATEGORY_ORDER = [
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
] as const

export function memoryCategoryLabel(type: string): string {
  return MEMORY_CATEGORY_LABELS[type] ?? type
}

export interface MemoryCategoryGroup<T extends MemoryCategoryItem = MemoryCategoryItem> {
  readonly category: string
  readonly label: string
  readonly count: number
  readonly items: readonly T[]
}

export function groupMemoriesByCategory<T extends MemoryCategoryItem>(
  items: readonly T[],
): Array<MemoryCategoryGroup<T>> {
  const groups = new Map<string, T[]>()
  for (const item of items) {
    const category = MEMORY_CATEGORY_LABELS[item.type] !== undefined ? item.type : "knowledge"
    const bucket = groups.get(category)
    if (bucket) bucket.push(item)
    else groups.set(category, [item])
  }
  const result: Array<MemoryCategoryGroup<T>> = []
  for (const category of MEMORY_CATEGORY_ORDER) {
    const bucket = groups.get(category)
    if (!bucket) continue
    bucket.sort((a, b) => b.importance - a.importance)
    result.push({ category, label: memoryCategoryLabel(category), count: bucket.length, items: bucket })
    groups.delete(category)
  }
  for (const [category, bucket] of groups) {
    bucket.sort((a, b) => b.importance - a.importance)
    result.push({ category, label: memoryCategoryLabel(category), count: bucket.length, items: bucket })
  }
  return result
}
