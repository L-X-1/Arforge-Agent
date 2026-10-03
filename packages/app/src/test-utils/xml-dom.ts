import { JSDOM } from "jsdom"

// HappyDOM's XML parser drops namespaced attributes when an unqualified
// attribute has the same local name (for example, PPTX id and r:id).
// Keep its HTML DOM intact and use a separate, inert XML parsing realm only.
export function withXmlDOMParser(HTMLParser: typeof DOMParser): typeof DOMParser {
  let xml: JSDOM | undefined

  return class TestDOMParser extends HTMLParser {
    override parseFromString(input: string, type: DOMParserSupportedType): Document {
      if (type === "text/html") return super.parseFromString(input, type)
      // Scripts and resource loading remain disabled. This realm is test-only
      // and is created lazily so HTML-only tests do not create another window.
      xml ??= new JSDOM("")
      return new xml.window.DOMParser().parseFromString(input, type)
    }
  }
}
