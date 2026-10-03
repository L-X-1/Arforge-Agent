export type OfficeFormat = "docx" | "xlsx" | "pptx"

const types: Readonly<Record<string, OfficeFormat>> = {
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
}

export function officeFormat(path: string, mime = ""): OfficeFormat | undefined {
  const extension = path.replaceAll("\\", "/").split("/").at(-1)?.split(".").at(-1)?.toLowerCase()
  const type = mime.split(";", 1)[0].trim().toLowerCase()
  if (type.includes("macroenabled") || ["docm", "xlsm", "pptm", "doc", "xls", "ppt"].includes(extension ?? "")) return
  return types[type] ?? (extension === "docx" || extension === "xlsx" || extension === "pptx" ? extension : undefined)
}
