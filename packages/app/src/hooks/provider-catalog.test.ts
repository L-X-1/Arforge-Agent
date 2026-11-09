import { expect, test } from "bun:test"
import type { NormalizedProviderListResponse } from "@arforge-ai/session-ui/context"
import { providerConnectionChoices, selectProviderCatalog } from "./provider-catalog"

const catalog = (id: string): NormalizedProviderListResponse => ({
  all: new Map([[id, { id, name: id, source: "api", env: [], options: {}, models: {} }]]),
  connected: [id],
  default: { [id]: `${id}-model` },
})

test("omits legacy catalog promotions and preserves configured connections", () => {
  const result = catalog("external")
  const external = result.all.get("external")!
  result.all.set("external", { ...external, source: "custom" })
  result.all.set("opencode", { ...external, id: "opencode", source: "custom" })
  result.all.set("arforge", { ...external, id: "arforge", source: "custom" })

  const choices = () => providerConnectionChoices(result).map((provider) => provider.id)
  expect(choices()).toEqual(["external"])
  expect([...result.all.keys()]).toEqual(["external", "opencode", "arforge"])

  result.connected.push("opencode")
  result.all.set("arforge", { ...external, id: "arforge", source: "config" })
  expect(choices()).toEqual(["external", "opencode", "arforge"])
})

test("selects the ready catalog for an explicit directory", () => {
  const directory = catalog("directory")

  expect(
    selectProviderCatalog({
      explicit: true,
      directory: "/repo",
      catalog: { ready: true, providers: directory },
    }),
  ).toBe(directory)
})

test("returns an empty catalog while an explicit directory is unresolved", () => {
  expect(selectProviderCatalog({ explicit: true })).toEqual({ all: new Map(), connected: [], default: {} })
  expect(
    selectProviderCatalog({
      explicit: true,
      directory: "/repo",
      catalog: { ready: false, providers: catalog("directory") },
    }),
  ).toEqual({ all: new Map(), connected: [], default: {} })
})

test("uses the route catalog when it is ready", () => {
  const directory = catalog("directory")

  expect(
    selectProviderCatalog({
      explicit: false,
      directory: "/repo",
      catalog: { ready: true, providers: directory },
      global: catalog("global"),
    }),
  ).toBe(directory)
})

test("falls back to the global catalog for route consumers", () => {
  const global = catalog("global")

  expect(selectProviderCatalog({ explicit: false, global })).toBe(global)
  expect(
    selectProviderCatalog({
      explicit: false,
      directory: "/repo",
      catalog: { ready: false, providers: catalog("directory") },
      global,
    }),
  ).toBe(global)
})
