import { describe, expect, test } from "bun:test"

const relationships = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
const strictRelationships = "http://purl.oclc.org/ooxml/officeDocument/relationships"

describe("test XML DOM compatibility", () => {
  test("preserves the numeric slide ID and relationship ID independently", () => {
    const document = new DOMParser().parseFromString(
      `<p:sldId xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="${relationships}" id="256" r:id="rIdsecond" />`,
      "application/xml",
    )
    const slide = document.documentElement
    expect(slide.getAttribute("id")).toBe("256")
    expect(slide.getAttribute("r:id")).toBe("rIdsecond")
    expect(slide.getAttributeNS(relationships, "id")).toBe("rIdsecond")
    expect(slide.getAttributeNS(null, "id")).toBe("256")
  })

  test("resolves relationship attributes by namespace rather than prefix", () => {
    const document = new DOMParser().parseFromString(
      `<slide xmlns:rel="${relationships}" id="257" rel:id="rIdfirst" />`,
      "application/xml",
    )
    expect(document.documentElement.getAttributeNS(relationships, "id")).toBe("rIdfirst")
    expect(document.documentElement.getAttribute("id")).toBe("257")
    expect(document.documentElement.getAttribute("r:id")).toBeNull()
  })

  test("keeps strict OOXML relationship namespaces distinct", () => {
    const document = new DOMParser().parseFromString(
      `<slide xmlns:rel="${strictRelationships}" id="258" rel:id="rIdstrict" />`,
      "application/xml",
    )
    expect(document.documentElement.getAttributeNS(strictRelationships, "id")).toBe("rIdstrict")
    expect(document.documentElement.getAttributeNS(relationships, "id")).toBeNull()
    expect(document.documentElement.getAttribute("id")).toBe("258")
  })

  test("reports malformed XML instead of repairing it as HTML", () => {
    const document = new DOMParser().parseFromString("<root><item></root>", "application/xml")
    expect(document.getElementsByTagName("parsererror").length).toBe(1)
  })

  test("preserves the existing HappyDOM realm for HTML parsing", () => {
    const OriginalParser = Object.getPrototypeOf(DOMParser) as typeof DOMParser
    const source = '<P DATA-ID="html">Hello</P>'
    const original = new OriginalParser().parseFromString(source, "text/html")
    const document = new DOMParser().parseFromString(source, "text/html")
    expect(Object.getPrototypeOf(document)).toBe(Object.getPrototypeOf(original))
    expect(Object.getPrototypeOf(document.querySelector("p"))).toBe(Object.getPrototypeOf(original.querySelector("p")))
    expect(document.documentElement.outerHTML).toBe(original.documentElement.outerHTML)
    expect(document.querySelector("p")?.getAttribute("data-id")).toBe("html")
    expect(document.querySelector("p")?.textContent).toBe("Hello")
  })
})
