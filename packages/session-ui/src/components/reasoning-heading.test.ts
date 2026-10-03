import { describe, expect, test } from "bun:test"
import { reasoningHeading } from "./reasoning-heading"

describe("reasoning heading", () => {
  test("extracts a markdown heading and removes inline formatting", () => {
    expect(reasoningHeading("## **Inspecting** `stability` ##\nDetails" )).toBe("Inspecting stability")
  })

  test("supports HTML and setext headings", () => {
    expect(reasoningHeading("<h3>Check <em>permissions</em></h3>")).toBe("Check permissions")
    expect(reasoningHeading("Recovering state\n---\nMore")).toBe("Recovering state")
  })

  test("fails closed for unheaded or blank reasoning", () => {
    expect(reasoningHeading("plain internal details")).toBeUndefined()
    expect(reasoningHeading("   ")).toBeUndefined()
    expect(reasoningHeading(undefined)).toBeUndefined()
  })
})
