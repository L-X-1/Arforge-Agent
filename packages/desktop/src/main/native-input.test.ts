import { describe, expect, test } from "bun:test"
import { compactDefined, requireNativeStoreValue } from "./native-input"

describe("native input normalization", () => {
  test("removes omitted optional fields before native action hashing", () => {
    expect(
      compactDefined({
        multiple: false,
        title: "Choose a folder",
        defaultPath: undefined,
      }),
    ).toEqual({
      multiple: false,
      title: "Choose a folder",
    })
  })

  test("accepts the complete string domain used by AsyncStorage", () => {
    expect(requireNativeStoreValue("")).toBe("")
    expect(requireNativeStoreValue("value")).toBe("value")
  })

  test("rejects non-string and oversized store values", () => {
    expect(() => requireNativeStoreValue(undefined)).toThrow("Invalid store value")
    expect(() => requireNativeStoreValue("123", 2)).toThrow("Invalid store value")
  })
})
