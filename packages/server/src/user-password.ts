import * as crypto from "node:crypto"

// Retain the existing Argon2id PHC contract in both product runtimes. Node's
// asynchronous Argon2 (24.7+) uses KiB and passes, matching Bun's cost options.
const memory = 19_456
const passes = 2
const parallelism = 1

function derive(password: string, nonce: Buffer, tagLength: number, cost = { memory, passes, parallelism }) {
  if (typeof crypto.argon2 !== "function") {
    throw new Error("Password authentication requires Bun.password or Node.js 24.7+ Argon2 support")
  }
  return new Promise<Buffer>((resolve, reject) => {
    crypto.argon2("argon2id", { message: password, nonce, tagLength, ...cost }, (error, key) => {
      if (error) reject(error)
      else resolve(key)
    })
  })
}

const encode = (value: Buffer) => value.toString("base64").replace(/=+$/, "")

export async function hashPassword(password: string) {
  if (typeof Bun !== "undefined" && Bun.password) {
    return Bun.password.hash(password, { algorithm: "argon2id", memoryCost: memory, timeCost: passes })
  }
  const salt = crypto.randomBytes(16)
  const key = await derive(password, salt, 32)
  return `$argon2id$v=19$m=${memory},t=${passes},p=${parallelism}$${encode(salt)}$${encode(key)}`
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  if (typeof Bun !== "undefined" && Bun.password) return Bun.password.verify(password, hash)
  const match = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/.exec(hash)
  if (!match) return false
  const cost = { memory: Number(match[1]), passes: Number(match[2]), parallelism: Number(match[3]) }
  const salt = Buffer.from(match[4], "base64")
  const expected = Buffer.from(match[5], "base64")
  if (
    !Object.values(cost).every((value) => Number.isSafeInteger(value) && value > 0) ||
    cost.memory < 8 * cost.parallelism || salt.length < 8 || expected.length < 4 ||
    encode(salt) !== match[4] || encode(expected) !== match[5]
  ) return false
  const actual = await derive(password, salt, expected.length, cost)
  return crypto.timingSafeEqual(actual, expected)
}
