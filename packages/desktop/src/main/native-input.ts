export function compactDefined<T extends Record<string, unknown>>(input: T): Partial<T> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as Partial<T>
}

export function requireNativeStoreValue(value: unknown, max = 512 * 1024): string {
  if (typeof value !== "string" || value.length > max) throw new TypeError("Invalid store value")
  return value
}
