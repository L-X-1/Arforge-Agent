export type ConflictDisposition = "chosen" | "retired"

export function conflictDisposition(
  conflict: {
    readonly status: string
    readonly chosenMemoryID?: string
    readonly retiredMemoryID?: string
  },
  memoryID: string,
): ConflictDisposition | undefined {
  if (conflict.status !== "resolved") return
  if (conflict.chosenMemoryID === memoryID) return "chosen"
  if (conflict.retiredMemoryID === memoryID) return "retired"
}
