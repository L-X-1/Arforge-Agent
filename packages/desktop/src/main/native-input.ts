export function compactDefined<T extends Record<string, unknown>>(input: T): Partial<T> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as Partial<T>
}

export function requireNativeStoreValue(value: unknown, max = 512 * 1024): string {
  if (typeof value !== "string" || value.length > max) throw new TypeError("Invalid store value")
  return value
}

export function requireNativeStorePart(name: "store name" | "store key", value: unknown): string {
  if (typeof value !== "string" || !value.length || value.length > 256) throw new TypeError(`Invalid ${name}`)
  // File names cannot contain drive/ADS separators or traverse directories.
  // Keys retain the existing scope:key namespace and literal dot semantics.
  const pattern = name === "store name" ? /^[A-Za-z0-9][A-Za-z0-9._-]*$/ : /^[A-Za-z0-9._:-]+$/
  if (!pattern.test(value)) throw new TypeError(`Invalid ${name}`)
  if (name === "store name" && (value.endsWith(".") || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)))
    throw new TypeError("Invalid store name")
  return value
}
