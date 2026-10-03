import { describe, expect, test } from "bun:test"
import * as MemoryClass from "@arforge-ai/schema/memory-class"

describe("Memory Kernel V1 classes", () => {
  test("freezes exactly the five planned classes", () => {
    expect(MemoryClass.MemoryClass.literals).toEqual(["working", "episodic", "semantic", "user", "project"])
    expect(MemoryClass.LongTermMemoryClass.literals).toEqual(["episodic", "semantic", "user", "project"])
  })

  test("keeps working state out of the long-term class boundary", () => {
    expect(MemoryClass.isLongTerm("working")).toBe(false)
    expect(MemoryClass.isLongTerm("episodic")).toBe(true)
    expect(MemoryClass.Definitions.working.durable).toBe(false)
    expect(MemoryClass.Definitions.episodic.durable).toBe(true)
  })

  test("keeps Experience and Skill outside Memory", () => {
    expect(MemoryClass.NonMemoryArtifact.literals).toEqual(["experience", "skill"])
    expect(MemoryClass.isMemoryClass("experience")).toBe(false)
    expect(MemoryClass.isMemoryClass("skill")).toBe(false)
  })

  test("requires explicit class semantics instead of accepting legacy type strings", () => {
    expect(MemoryClass.isMemoryClass("fact")).toBe(false)
    expect(MemoryClass.isMemoryClass("workflow")).toBe(false)
    expect(MemoryClass.Definitions.semantic.provenance).toBe("evidence")
    expect(MemoryClass.Definitions.user.provenance).toBe("user-authority")
  })
})
