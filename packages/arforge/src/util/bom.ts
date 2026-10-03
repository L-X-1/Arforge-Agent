import { Effect } from "effect"
import { FSUtil } from "@arforge-ai/core/fs-util"

const BOM_CODE = 0xfeff
const BOM = String.fromCharCode(BOM_CODE)

export function split(text: string) {
  if (text.charCodeAt(0) !== BOM_CODE) return { bom: false, text }
  return { bom: true, text: text.slice(1) }
}

export function join(text: string, bom: boolean) {
  const stripped = split(text).text
  if (!bom) return stripped
  return BOM + stripped
}

export const readFile = Effect.fn("Bom.readFile")(function* (fs: FSUtil.Interface, filePath: string) {
  return split(new TextDecoder("utf-8", { ignoreBOM: true }).decode(yield* fs.readFile(filePath)))
})

export const syncFile = Effect.fn("Bom.syncFile")(function* (
  fs: Pick<FSUtil.Interface, "readFile" | "writeIfUnchanged">,
  filePath: string,
  bom: boolean,
) {
  const raw = yield* fs.readFile(filePath)
  const current = split(new TextDecoder("utf-8", { ignoreBOM: true }).decode(raw))
  if (current.bom === bom) return current.text
  if (!fs.writeIfUnchanged)
    return yield* Effect.fail(
      new FSUtil.FileSystemError({
        method: "writeIfUnchanged",
        cause: new Error("BOM synchronization requires conditional atomic write support"),
      }),
    )
  yield* fs.writeIfUnchanged(filePath, raw, join(current.text, bom))
  return current.text
})
