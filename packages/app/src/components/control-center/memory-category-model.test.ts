import { describe, expect, test } from "bun:test"
import {
  groupMemoriesByCategory,
  memoryCategoryLabel,
  MEMORY_CATEGORY_LABELS,
} from "./memory-category-model"

const item = (id: string, type: string, importance = 1) => ({
  id,
  content: `content-${id}`,
  type,
  importance,
  scope: "global",
  tags: [],
})

describe("memory category model", () => {
  test("groups items by type with Chinese labels", () => {
    const groups = groupMemoriesByCategory([
      item("a", "identity", 3),
      item("b", "preference"),
      item("c", "identity"),
    ])
    expect(groups.map((group) => group.category)).toEqual(["identity", "preference"])
    expect(groups[0].label).toBe("用户身份信息")
    expect(groups[0].count).toBe(2)
    expect(groups[1].label).toBe("偏好与习惯")
  })

  test("sorts items inside a group by importance descending", () => {
    const groups = groupMemoriesByCategory([
      item("low", "identity", 1),
      item("high", "identity", 5),
      item("mid", "identity", 3),
    ])
    expect(groups[0].items.map((entry) => entry.id)).toEqual(["high", "mid", "low"])
  })

  test("falls unknown types back to knowledge group", () => {
    const groups = groupMemoriesByCategory([item("x", "weird_type")])
    expect(groups[0].category).toBe("knowledge")
    expect(groups[0].label).toBe("知识")
  })

  test("orders identity and preference groups first", () => {
    const groups = groupMemoriesByCategory([
      item("a", "fact"),
      item("b", "identity"),
      item("c", "preference"),
    ])
    expect(groups.map((group) => group.category)).toEqual([
      "identity",
      "preference",
      "fact",
    ])
  })

  test("empty input yields empty groups", () => {
    expect(groupMemoriesByCategory([])).toEqual([])
  })

  test("labels cover every known category", () => {
    for (const category of [
      "identity",
      "preference",
      "convention",
      "workflow",
      "constraint",
      "fact",
      "error",
      "project",
      "knowledge",
    ]) {
      expect(MEMORY_CATEGORY_LABELS[category]).toBeTruthy()
      expect(memoryCategoryLabel(category)).toBe(MEMORY_CATEGORY_LABELS[category])
    }
  })

  test("unknown type label falls back to the type itself", () => {
    expect(memoryCategoryLabel("mystery")).toBe("mystery")
  })
})
