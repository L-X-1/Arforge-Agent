import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { SessionAuth } from "@arforge-ai/server/session-auth"

const password = "correct horse battery staple"
const config = {
  username: "arforge_owner",
  password: Option.some(password),
}

describe("Arforge signed sessions", () => {
  test("issues an HttpOnly, strict, time-limited cookie", () => {
    const session = SessionAuth.issue(config, { now: 1_700_000_000_000, secure: true })

    expect(session).toBeDefined()
    expect(session?.cookie).toContain("arforge_session=")
    expect(session?.cookie).toContain("HttpOnly")
    expect(session?.cookie).toContain("SameSite=Strict")
    expect(session?.cookie).toContain("Max-Age=28800")
    expect(session?.cookie).toContain("Secure")
    expect(session?.cookie).not.toContain(password)
  })

  test("rejects tampering, expiry, and password rotation", () => {
    const now = 1_700_000_000_000
    const session = SessionAuth.issue(config, { now })
    expect(session).toBeDefined()
    const cookie = session?.cookie.split(";")[0]

    expect(Option.isSome(SessionAuth.fromCookie(cookie, config, now + 1_000))).toBe(true)
    expect(Option.isNone(SessionAuth.fromCookie(`${cookie}x`, config, now + 1_000))).toBe(true)
    expect(Option.isNone(SessionAuth.fromCookie(cookie, config, now + SessionAuth.SESSION_TTL_SECONDS * 1_000))).toBe(
      true,
    )
    expect(
      Option.isNone(
        SessionAuth.fromCookie(cookie, { ...config, password: Option.some("rotated password") }, now + 1_000),
      ),
    ).toBe(true)
  })

  test("revokes a copied session token on logout", () => {
    const now = 1_700_000_000_000
    const session = SessionAuth.issue(config, { now })!
    const cookie = session.cookie.split(";")[0]

    expect(Option.isSome(SessionAuth.fromCookie(cookie, config, now + 1_000))).toBe(true)
    expect(SessionAuth.revoke(cookie, config, now + 1_000)).toBe(true)
    expect(Option.isNone(SessionAuth.fromCookie(cookie, config, now + 1_000))).toBe(true)
  })

  test("requires a matching Origin for cookie-authenticated mutations", () => {
    const session = SessionAuth.issue(config, { now: 1_700_000_000_000 })
    const cookie = session?.cookie.split(";")[0]
    const now = 1_700_000_001_000

    expect(
      SessionAuth.requestAuthorized(
        { cookie, host: "private.arforge.example", method: "GET", now },
        config,
      ),
    ).toBe(true)
    expect(
      SessionAuth.requestAuthorized(
        {
          cookie,
          host: "private.arforge.example",
          method: "POST",
          now,
        },
        config,
      ),
    ).toBe(false)

    expect(
      SessionAuth.requestAuthorized(
        {
          cookie,
          host: "private.arforge.example",
          method: "POST",
          now,
          origin: "https://private.arforge.example",
        },
        config,
      ),
    ).toBe(true)
    expect(
      SessionAuth.requestAuthorized(
        {
          cookie,
          host: "private.arforge.example",
          method: "POST",
          now,
          origin: "https://attacker.example",
        },
        config,
      ),
    ).toBe(false)
  })

  test("uses Secure cookies everywhere except explicit loopback hosts", () => {
    expect(SessionAuth.secureForHost("private.arforge.example")).toBe(true)
    expect(SessionAuth.secureForHost("localhost:4096")).toBe(false)
    expect(SessionAuth.secureForHost("127.0.0.1:4096")).toBe(false)
    expect(SessionAuth.secureForHost("[::1]:4096")).toBe(false)
  })
})
