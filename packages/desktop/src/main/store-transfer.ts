import { createHash, randomUUID } from "node:crypto"
import { STORE_CHUNK_LENGTH, STORE_MAX_PENDING_LENGTH, STORE_MAX_VALUE_LENGTH } from "../shared/store-transfer"
import { requireNativeStorePart, requireNativeStoreValue } from "./native-input"

type Transfer = {
  sender: number
  name: string
  key: string
  length: number
  received: number
  chunks: string[]
  expires: number
  timer: ReturnType<typeof setTimeout>
  committing: boolean
}

export class StoreTransfers {
  private readonly pending = new Map<string, Transfer>()
  private reserved = 0
  constructor(
    private readonly options: {
      now?: () => number
      maxLength?: number
      maxPendingLength?: number
      ttlMs?: number
    } = {},
  ) {}

  begin(sender: number, name: unknown, key: unknown, length: unknown) {
    for (const [id, item] of this.pending) if (!item.committing && this.now() >= item.expires) this.release(id)
    const checkedName = requireNativeStorePart("store name", name)
    const checkedKey = requireNativeStorePart("store key", key)
    if (
      !Number.isSafeInteger(length) ||
      (length as number) <= 0 ||
      (length as number) > (this.options.maxLength ?? STORE_MAX_VALUE_LENGTH)
    )
      throw new TypeError("Invalid desktop store transfer length")
    const size = length as number
    if (
      this.pending.size >= 8 ||
      [...this.pending.values()].filter((item) => item.sender === sender).length >= 4 ||
      this.reserved + size > (this.options.maxPendingLength ?? STORE_MAX_PENDING_LENGTH)
    )
      throw new TypeError("Desktop store staging quota exceeded")
    const id = randomUUID()
    const ttl = this.options.ttlMs ?? 30_000
    const timer = setTimeout(() => this.release(id), ttl)
    timer.unref()
    this.pending.set(id, {
      sender,
      name: checkedName,
      key: checkedKey,
      length: size,
      received: 0,
      chunks: [],
      expires: this.now() + ttl,
      timer,
      committing: false,
    })
    this.reserved += size
    return id
  }

  append(sender: number, id: unknown, index: unknown, value: unknown) {
    const item = this.require(sender, id)
    const chunk = requireNativeStoreValue(value, STORE_CHUNK_LENGTH)
    if (
      index !== item.chunks.length ||
      chunk.length !== Math.min(STORE_CHUNK_LENGTH, item.length - item.received) ||
      !chunk.length
    )
      throw new TypeError("Invalid desktop store chunk order or length")
    item.chunks.push(chunk)
    item.received += chunk.length
  }

  prepare(sender: number, id: unknown) {
    const item = this.require(sender, id)
    if (item.received !== item.length) throw new TypeError("Incomplete desktop store transfer")
    item.committing = true
    clearTimeout(item.timer)
    const value = item.chunks.join("")
    item.chunks = []
    return {
      name: item.name,
      key: item.key,
      value,
      length: item.length,
      digest: createHash("sha256").update(value).digest("hex"),
      release: () => this.release(id as string),
    }
  }

  abort(sender: number, id: unknown) {
    this.requireID(id)
    if (!this.pending.has(id as string)) return
    this.require(sender, id)
    this.release(id as string)
  }

  close(sender: number) {
    for (const [id, item] of this.pending) if (item.sender === sender && !item.committing) this.release(id)
  }

  private now() {
    return (this.options.now ?? Date.now)()
  }
  private requireID(id: unknown) {
    if (typeof id !== "string" || !/^[a-f0-9-]{36}$/.test(id)) throw new TypeError("Invalid desktop store transfer")
  }
  private require(sender: number, id: unknown) {
    this.requireID(id)
    const item = this.pending.get(id as string)
    if (!item || item.sender !== sender || item.committing)
      throw new TypeError("Invalid desktop store transfer owner or state")
    if (this.now() >= item.expires) {
      this.release(id as string)
      throw new TypeError("Desktop store transfer expired")
    }
    return item
  }
  private release(id: string) {
    const item = this.pending.get(id)
    if (!item) return
    clearTimeout(item.timer)
    this.pending.delete(id)
    this.reserved -= item.length
  }
}
