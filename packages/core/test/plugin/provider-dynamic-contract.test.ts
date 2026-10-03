import { describe, expect, test } from "bun:test"
import path from "node:path"
import {
  DynamicProviderContractError,
  createDynamicProviderSDK,
  dynamicProviderEntrypoint,
  dynamicProviderOptions,
  selectDynamicProviderFactory,
  validateDynamicProviderPackage,
} from "@arforge-ai/core/plugin/provider/dynamic"

describe("dynamic provider typed contract", () => {
  test("accepts local file and registry coordinates but rejects remote protocols and cwd paths", () => {
    expect(validateDynamicProviderPackage("file:///tmp/provider.mjs")).toBe("file:///tmp/provider.mjs")
    expect(validateDynamicProviderPackage("@ai-sdk/openai@3.0.84")).toBe("@ai-sdk/openai@3.0.84")
    expect(validateDynamicProviderPackage("npm:fixture-provider@1.0.0")).toBe("npm:fixture-provider@1.0.0")
    for (const value of ["https://example.invalid/provider.mjs", "git+ssh://example.invalid/provider", "./provider.mjs", " "]) {
      expect(() => validateDynamicProviderPackage(value)).toThrow(DynamicProviderContractError)
    }
  })

  test("only imports local absolute entrypoints", () => {
    expect(dynamicProviderEntrypoint("file:///tmp/provider.mjs")).toBe("file:///tmp/provider.mjs")
    const absolutePath = process.platform === "win32" ? "C:\\tmp\\provider.mjs" : path.resolve("tmp", "provider.mjs")
    expect(dynamicProviderEntrypoint(absolutePath)).toMatch(/^file:\/\//u)
    expect(() => dynamicProviderEntrypoint("https://example.invalid/provider.mjs")).toThrow(
      DynamicProviderContractError,
    )
    expect(() => dynamicProviderEntrypoint("provider.mjs")).toThrow(DynamicProviderContractError)
  })

  test("freezes bounded options without rejecting the AISDK fetch function", () => {
    const fetch = () => Promise.resolve(new Response())
    const options = dynamicProviderOptions({ name: "fixture", fetch })
    expect(options).toMatchObject({ name: "fixture", fetch })
    expect(Object.isFrozen(options)).toBe(true)
    expect(() => dynamicProviderOptions([])).toThrow(DynamicProviderContractError)
  })

  test("selects the explicit factory and rejects ambiguous or non-factory exports", () => {
    const explicit = () => ({ languageModel: () => ({}) })
    expect(selectDynamicProviderFactory({ createProvider: explicit, createOther: () => ({}) }).name).toBe(
      "createProvider",
    )
    expect(selectDynamicProviderFactory({ createFixtureProvider: explicit }).name).toBe("createFixtureProvider")
    expect(() => selectDynamicProviderFactory({ createA: explicit, createB: explicit })).toThrow(
      DynamicProviderContractError,
    )
    expect(() => selectDynamicProviderFactory({ createProvider: true })).toThrow(DynamicProviderContractError)
    expect(() => selectDynamicProviderFactory({ notAFactory: true })).toThrow(DynamicProviderContractError)
  })

  test("requires the provider SDK selector and converts factory throws to a typed failure", () => {
    const options = dynamicProviderOptions({ marker: "fixture" })
    const sdk = createDynamicProviderSDK(() => ({ languageModel: (id: string) => ({ id }) }), options)
    expect(sdk.languageModel("test")).toEqual({ id: "test" })
    expect(() => createDynamicProviderSDK(() => ({}), options)).toThrow(DynamicProviderContractError)
    expect(() => createDynamicProviderSDK(() => {
      throw new Error("secret should not escape")
    }, options)).toThrow(DynamicProviderContractError)
  })
})
