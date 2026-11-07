// Inline values stay below Core's 64 KiB JSON input bound even when every
// character needs a six-byte JSON escape. Larger values use bounded frames.
export const STORE_INLINE_LENGTH = 8 * 1024
export const STORE_CHUNK_LENGTH = 64 * 1024
// UTF-16 staging budgets: 64 MiB per value, 128 MiB across all senders.
export const STORE_MAX_VALUE_LENGTH = 32 * 1024 * 1024
export const STORE_MAX_PENDING_LENGTH = 64 * 1024 * 1024

export type StoreWriteBridge = {
  set(name: string, key: string, value: string): Promise<void>
  begin(name: string, key: string, length: number): Promise<string>
  chunk(id: string, index: number, value: string): Promise<void>
  commit(id: string): Promise<void>
  abort(id: string): Promise<void>
}
