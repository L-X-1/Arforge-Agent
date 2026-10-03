import type { WebContents } from "electron"
import {
  createNativeActionRequest,
  type NativeActionCapability,
  type NativeActionKind,
  type NativeActionReceipt,
} from "@arforge-ai/core/runtime/native-action"
import type { createNativeActionRuntime } from "@arforge-ai/core/runtime/native-action"

export type NativeEvent = { readonly sender: WebContents }
export type NativeActionRuntime = ReturnType<typeof createNativeActionRuntime>

export async function executeNative<T>(
  runtime: NativeActionRuntime,
  event: NativeEvent,
  kind: NativeActionKind,
  name: string,
  payload: Record<string, unknown>,
  operation: (capability: NativeActionCapability) => Promise<T> | T,
): Promise<T> {
  const request = createNativeActionRequest({ senderID: event.sender.id, kind, name, payload })
  try {
    const result = await runtime.execute(request, operation)
    emitNativeReceipt(event.sender, result.receipt)
    return result.value
  } catch (error) {
    const receipt = (await runtime.list().catch(() => [])).find((item) => item.actionID === request.actionID)
    if (receipt) emitNativeReceipt(event.sender, receipt)
    throw error
  }
}

export function emitNativeReceipt(sender: WebContents, receipt: NativeActionReceipt) {
  if (!sender.isDestroyed()) sender.send("native-action-receipt", receipt)
}
