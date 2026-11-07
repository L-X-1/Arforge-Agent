import { expect, test } from "bun:test"
import type { ModelPreset } from "@arforge-ai/schema/model-preset"
import { matchModelPreset, modelPresetKey } from "./model-preset-match"

const preset = (vendorID: string, modelID: string, name: string, aliases: string[] = []): ModelPreset.Preset => ({
  origin: { vendorID, modelID },
  name,
  aliases,
  status: "active",
  provenance: [{ source: "bundled", sourceID: "unit" }],
})
const first = preset("vendor-a", "model-v2-20260101", "Official Model V2", [
  "vendor-a/model-v2-20260101",
  "explicit-alias",
])
const second = preset("vendor-b", "other-model", "Other Official Model", ["explicit-alias"])
const catalog = (items: readonly ModelPreset.Preset[]): ModelPreset.Catalog => ({
  revision: "unit-revision",
  vendors: [],
  items,
})

test("exact canonical ID wins and preserves the caller's original wire spelling", () => {
  const wire = "  MODEL-V2-20260101  "
  const result = matchModelPreset(wire, catalog([first, second]))
  expect(result.status).toBe("matched")
  if (result.status === "matched") expect(result.via).toBe("id")
  expect(wire).toBe("  MODEL-V2-20260101  ")
})

test("colliding exact IDs, aliases or display names remain ambiguous across origins", () => {
  expect(matchModelPreset("explicit-alias", catalog([first, second])).status).toBe("ambiguous")
  expect(
    matchModelPreset(
      first.origin.modelID,
      catalog([first, { ...second, origin: { ...second.origin, modelID: first.origin.modelID } }]),
    ).status,
  ).toBe("ambiguous")
  expect(matchModelPreset(first.name, catalog([first, { ...second, name: first.name }])).status).toBe("ambiguous")
})

test("only full explicit manifest aliases authorize namespace forms; unknown prefixes/dates/suffixes are never stripped", () => {
  expect(matchModelPreset("vendor-a/model-v2-20260101", catalog([first])).status).toBe("matched")
  for (const wire of [
    "relay/model-v2-20260101",
    "unknown/vendor-a/model-v2-20260101",
    "model-v2",
    "model-v2-20260102",
    "model-v2-20260101-preview",
  ])
    expect(matchModelPreset(wire, catalog([first])).status).not.toBe("matched")
})

test("full unique display names may match; family and in-progress prefixes remain candidates without autofill", () => {
  expect(matchModelPreset("official model v2", catalog([first])).status).toBe("matched")
  const prefix = matchModelPreset("Official Model", catalog([first]))
  expect(prefix.status).toBe("unknown")
  if (prefix.status !== "matched") expect(prefix.candidates).toEqual([first])
  expect(matchModelPreset("", catalog([first])).status).toBe("unknown")
})

test("origin reference identity never becomes a configured connection identity", () => {
  expect(modelPresetKey(first)).toBe(JSON.stringify(["vendor-a", "model-v2-20260101"]))
  const relay = { providerID: "my-relay", id: "relay-wire-name", baseURL: "https://relay.invalid/v1" }
  matchModelPreset(first.name, catalog([first]))
  expect(relay).toEqual({ providerID: "my-relay", id: "relay-wire-name", baseURL: "https://relay.invalid/v1" })
})
