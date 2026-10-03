/*
 * Minimal FlatBuffer encoder for Microsoft's Windows BaseContainer SBOX
 * contract.  The schema is intentionally kept local and small: the launcher
 * needs version, app_container, fs_read_write, fs_read_only and network_policy for the
 * workspace-write profile.  Keeping the encoder dependency-free avoids a
 * second runtime package and makes the exact bytes easy to audit in tests.
 *
 * Schema source (Microsoft MXC):
 *   SandboxSpec { version, app_container, ..., fs_read_write, fs_read_only,
 *                 network_policy }
 *   NetworkPolicy { proxy, egress, allowed_appcontainer_peer }
 *   endpoint_policy { default_action, allow, deny }
 *   file_identifier "SBOX"
 */

export type WindowsSandboxSpecInput = {
  readonly roots: ReadonlyArray<string>
  readonly readOnlyRoots?: ReadonlyArray<string>
  readonly network: "none" | "inherit"
}

const FILE_IDENTIFIER = new Uint8Array([0x53, 0x42, 0x4f, 0x58]) // SBOX
const SPEC_VERSION = "0.1.0"

class FlatBufferWriter {
  private bytes = new Uint8Array(512)
  private length = 0

  get size() {
    return this.length
  }

  private ensure(extra: number) {
    const required = this.length + extra
    if (required <= this.bytes.length) return
    let size = this.bytes.length
    while (size < required) size *= 2
    const next = new Uint8Array(size)
    next.set(this.bytes.subarray(0, this.length))
    this.bytes = next
  }

  align(alignment: number) {
    while (this.length % alignment !== 0) this.pushU8(0)
  }

  pushU8(value: number) {
    this.ensure(1)
    this.bytes[this.length++] = value & 0xff
  }

  pushU16(value: number) {
    this.ensure(2)
    new DataView(this.bytes.buffer).setUint16(this.length, value, true)
    this.length += 2
  }

  pushU32(value: number) {
    this.ensure(4)
    new DataView(this.bytes.buffer).setUint32(this.length, value, true)
    this.length += 4
  }

  pushI32(value: number) {
    this.ensure(4)
    new DataView(this.bytes.buffer).setInt32(this.length, value, true)
    this.length += 4
  }

  pushBytes(value: Uint8Array) {
    this.ensure(value.length)
    this.bytes.set(value, this.length)
    this.length += value.length
  }

  patchU32(offset: number, value: number) {
    if (offset < 0 || offset + 4 > this.length) throw new Error("FlatBuffer patch offset is out of bounds")
    new DataView(this.bytes.buffer).setUint32(offset, value, true)
  }

  patchU8(offset: number, value: number) {
    if (offset < 0 || offset >= this.length) throw new Error("FlatBuffer byte patch offset is out of bounds")
    this.bytes[offset] = value & 0xff
  }

  finish() {
    return this.bytes.slice(0, this.length)
  }
}

type Table = {
  readonly position: number
  readonly field: (offset: number) => number
}

const table = (writer: FlatBufferWriter, fieldOffsets: ReadonlyArray<number>, objectSize: number): Table => {
  writer.align(2)
  const vtablePosition = writer.size
  writer.pushU16(4 + fieldOffsets.length * 2)
  writer.pushU16(objectSize)
  for (const offset of fieldOffsets) writer.pushU16(offset)

  writer.align(4)
  const position = writer.size
  writer.pushI32(position - vtablePosition)
  for (let index = 4; index < objectSize; index++) writer.pushU8(0)

  return { position, field: (offset) => position + offset }
}

const string = (writer: FlatBufferWriter, value: string) => {
  writer.align(4)
  const position = writer.size
  const encoded = new TextEncoder().encode(value)
  writer.pushU32(encoded.length)
  writer.pushBytes(encoded)
  writer.pushU8(0)
  writer.align(4)
  return position
}

const stringVector = (writer: FlatBufferWriter, values: ReadonlyArray<string>) => {
  writer.align(4)
  const position = writer.size
  writer.pushU32(values.length)
  const slots = values.map(() => {
    const slot = writer.size
    writer.pushU32(0)
    return slot
  })
  values.forEach((value, index) => {
    const target = string(writer, value)
    const slot = slots[index]
    if (slot === undefined) throw new Error("FlatBuffer vector slot is missing")
    writer.patchU32(slot, target - slot)
  })
  return position
}

const setOffset = (writer: FlatBufferWriter, field: number, target: number) => {
  if (target <= field) throw new Error("FlatBuffer offsets must point forward")
  writer.patchU32(field, target - field)
}

/** Build an SBOX FlatBuffer for the Windows workspace-write policy. */
export const buildWindowsSandboxSpec = (input: WindowsSandboxSpecInput): Uint8Array => {
  const roots = [...new Set(input.roots.map((root) => root.trim()).filter((root) => root.length > 0))]
  const readOnlyRoots = [
    ...new Set((input.readOnlyRoots ?? []).map((root) => root.trim()).filter((root) => root.length > 0)),
  ]
  if (roots.length === 0) throw new Error("Windows SBOX workspace-write requires at least one approved root")
  if ([...roots, ...readOnlyRoots].some((root) => root.includes("\0")))
    throw new Error("Windows SBOX roots cannot contain NUL")

  const writer = new FlatBufferWriter()
  // FlatBuffers finish() writes the root offset followed by the four-byte file
  // identifier.  All tables/objects are built forward so every uoffset can be
  // patched with a positive relative distance.
  writer.pushU32(0)
  writer.pushBytes(FILE_IDENTIFIER)

  // SandboxSpec fields: version=+8, app_container=+4,
  // fs_read_write=+12, network_policy=+16, optional fs_read_only=+20. The deprecated
  // `integrity_level` schema slot is retained as a zero vtable entry, so the
  // generated constants put fs_read_write at vtable offset 18 and
  // network_policy at 22.
  const spec = table(
    writer,
    [8, 4, 0, 0, 0, 0, 0, 12, readOnlyRoots.length ? 20 : 0, 16, 0, 0],
    readOnlyRoots.length ? 24 : 20,
  )
  writer.patchU8(spec.field(4), 1) // app_container=true

  // NetworkPolicy has only the egress field in this slice.
  const network = table(writer, [0, 4, 0], 8)
  const endpoint = table(writer, [4, 0, 0], 8)
  writer.patchU8(endpoint.field(4), input.network === "inherit" ? 1 : 0) // FilterAction: allow=1, deny=0
  setOffset(writer, network.field(4), endpoint.position)

  const writableRoots = stringVector(writer, roots)
  setOffset(writer, spec.field(12), writableRoots)
  if (readOnlyRoots.length) setOffset(writer, spec.field(20), stringVector(writer, readOnlyRoots))

  const version = string(writer, SPEC_VERSION)
  setOffset(writer, spec.field(8), version)
  setOffset(writer, spec.field(16), network.position)
  writer.patchU32(0, spec.position)
  return writer.finish()
}

export * as WindowsSandboxSpec from "./windows-sandbox-spec"
