import { describe, expect, test } from "bun:test"
import { compactDefined, requireNativeStorePart, requireNativeStoreValue } from "./native-input"

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

  test("bounds file names without rejecting scoped storage keys", () => {
    expect(requireNativeStorePart("store name", "arforge.global.dat")).toBe("arforge.global.dat")
    expect(requireNativeStorePart("store key", "session:fixture:prompt")).toBe("session:fixture:prompt")
    for (const value of ["../outside", "C:drive", ".", "..", "NUL", "con.dat", "trailing.", "a".repeat(257)]) {
      expect(() => requireNativeStorePart("store name", value)).toThrow("Invalid store name")
    }
  })
})
