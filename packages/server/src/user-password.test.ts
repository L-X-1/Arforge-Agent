import { describe, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import { hashPassword, verifyPassword } from "./user-password"

const password = "owned-password-兼容-🔐"

async function node(input: { password: string; hash?: string }) {
  const child = Bun.spawn(["node", "--input-type=module", "-e", `
    import { hashPassword, verifyPassword } from ${JSON.stringify(new URL("./user-password.ts", import.meta.url).href)};
    let input = ''; for await (const chunk of process.stdin) input += chunk;
    const data = JSON.parse(input);
    const hash = data.hash ?? await hashPassword(data.password);
    console.log(JSON.stringify({ hash, matches: await verifyPassword(data.password, hash), wrong: await verifyPassword('wrong owned password', hash), bun: typeof globalThis.Bun }));
  `], { cwd: fileURLToPath(new URL("..", import.meta.url)), stdin: "pipe", stdout: "pipe", stderr: "pipe" })
  child.stdin.write(JSON.stringify(input))
  child.stdin.end()
  const [output, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (code !== 0) throw new Error(`Node password owner failed: ${error}`)
  return JSON.parse(output) as { hash: string; matches: boolean; wrong: boolean; bun: string }
}

describe("password runtime compatibility", () => {
  test("Node verifies an existing Bun Argon2id hash without a Bun global", async () => {
    const hash = await Bun.password.hash(password, { algorithm: "argon2id", memoryCost: 19_456, timeCost: 2 })
    const result = await node({ password, hash })
    expect(result).toEqual({ hash, matches: true, wrong: false, bun: "undefined" })
  })

  test("Bun verifies new Node hashes with unchanged cost and independent salts", async () => {
    const first = await node({ password })
    const second = await node({ password })
    expect(first.hash).toStartWith("$argon2id$v=19$m=19456,t=2,p=1$")
    expect(second.hash).not.toBe(first.hash)
    expect(first.matches).toBe(true)
    expect(first.wrong).toBe(false)
    expect(await Bun.password.verify(password, first.hash)).toBe(true)
    expect(await Bun.password.verify("wrong owned password", first.hash)).toBe(false)
  })

  test("Node honors the stored Bun cost and the existing maximum password length", async () => {
    const password = "p".repeat(256)
    const hash = await Bun.password.hash(password, { algorithm: "argon2id", memoryCost: 24_576, timeCost: 3 })
    expect((await node({ password, hash })).matches).toBe(true)
    expect((await node({ password: password.slice(1), hash })).matches).toBe(false)
  })

  test("the existing Bun owner and invalid stored hashes still fail closed", async () => {
    const hash = await hashPassword(password)
    expect(await verifyPassword(password, hash)).toBe(true)
    expect(await verifyPassword("wrong owned password", hash)).toBe(false)
    for (const invalid of ["", "$scrypt$unsupported", "$argon2id$v=16$m=19456,t=2,p=1$bad$bad", "$argon2id$v=19$m=0,t=2,p=1$bad$bad"]) {
      expect((await node({ password, hash: invalid })).matches).toBe(false)
    }
  })
})
