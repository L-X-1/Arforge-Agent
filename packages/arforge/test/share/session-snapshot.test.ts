import { describe, expect, test } from "bun:test"
import { canonicalHash } from "@arforge-ai/core/util/canonical-hash"
import { SessionID } from "@/session/schema"
import * as SessionShareSnapshot from "@/share/session-snapshot"

const sessionID = SessionID.make("ses_static_share_1234")
const projectID = "prj_static_share"
const location = "C:\\workspace\\project"
const originalPublicationDigest = canonicalHash({ publication: "shr_static_1", generation: 1 })!

function capture(kind: "share" | "unshare" = "share"): SessionShareSnapshot.Capture {
  return {
    version: 1,
    kind,
    requestID: "cpr_static_share_1234",
    sessionID,
    projectID,
    location,
    eventHighWaterMark: 42,
    export: {
      format: SessionShareSnapshot.FORMAT,
      items: [
        {
          key: "session",
          type: "session",
          data: {
            id: sessionID,
            projectID,
            directory: location,
            title: "Approved static export",
          },
        },
        {
          key: "message/msg_approved_1",
          type: "message",
          data: {
            id: "msg_approved_1",
            sessionID,
            role: "user",
            text: "Publish only this approved message.",
          },
        },
        {
          key: "part/msg_approved_1/prt_approved_1",
          type: "part",
          data: {
            id: "prt_approved_1",
            messageID: "msg_approved_1",
            sessionID,
            type: "text",
            text: "Static part",
          },
        },
        { key: "session_diff", type: "session_diff", data: [] },
        { key: "model", type: "model", data: [] },
      ],
    },
    target: {
      baseURL: "https://share.example.com/api/",
      organizationID: "org_static",
      visibility: "organization",
      publication:
        kind === "unshare"
          ? {
              id: "shr_static_1",
              url: "https://share.example.com/s/shr_static_1",
              originalExportDigest: originalPublicationDigest,
            }
          : null,
    },
    heuristicScan: {
      scannerVersion: SessionShareSnapshot.HEURISTIC_SCANNER_VERSION,
      excluded: [
        { path: "/provider/headers/authorization", reason: "authorization-header" },
        { path: "/provider/environment/API_KEY", reason: "provider-secret" },
      ],
    },
  }
}

describe("SessionShareSnapshot", () => {
  test("round-trips one immutable, request-bound static export", () => {
    const snapshot = SessionShareSnapshot.encode(capture())
    const claim = SessionShareSnapshot.claimMaterial(snapshot)
    const decoded = SessionShareSnapshot.decode(JSON.parse(JSON.stringify(snapshot)), claim.input)

    expect(decoded.snapshot).toEqual(snapshot)
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.export.items)).toBe(true)
    expect(snapshot.export.contentDigest).toBe(
      canonicalHash({ format: SessionShareSnapshot.FORMAT, items: snapshot.export.items })!,
    )
    expect(snapshot.heuristicScanEvidence.excludedCount).toBe(2)
    expect(snapshot.heuristicScanEvidence.scannedValueCount).toBeGreaterThan(0)
    expect("sensitiveData" in snapshot).toBe(false)
    expect(SessionShareSnapshot.executionInput(snapshot).requestID).toBe("cpr_static_share_1234")
    expect("requestID" in claim.input).toBe(false)

    const material = SessionShareSnapshot.actionMaterial(snapshot)
    expect(material.name).toBe("session.share")
    expect(material.semantics.riskTier).toBe("L3")
    expect(material.semantics.authority).toBe("human")
    expect(material.semantics.idempotency).toBe("non_idempotent")
    expect(material.semantics.retryability).toBe("never")
    expect(material.requiresFreshHumanConfirmation).toBe(true)
    expect(SessionShareSnapshot.authorizationPlan(snapshot).metadata).toMatchObject({ fresh: true })
  })

  test("rejects unknown fields, checksum tampering, and approved scope drift", () => {
    expect(() =>
      SessionShareSnapshot.encode({
        ...capture(),
        unexpected: true,
      } as SessionShareSnapshot.Capture),
    ).toThrow(/capture schema is invalid/)

    const snapshot = SessionShareSnapshot.encode(capture())
    const withUnknownTarget = structuredClone(snapshot) as typeof snapshot & { target: { unexpected?: boolean } }
    withUnknownTarget.target.unexpected = true
    expect(() => SessionShareSnapshot.executionInput(withUnknownTarget)).toThrow(/snapshot schema is invalid/)

    const tampered = structuredClone(snapshot)
    const message = tampered.export.items.find((item) => item.type === "message")!
    ;(message.data as { text: string }).text = "Changed after approval"
    expect(() => SessionShareSnapshot.executionInput(tampered)).toThrow(/digest does not match|evidence does not match/)

    const claim = structuredClone(SessionShareSnapshot.claimMaterial(snapshot).input) as {
      location: string
    } & SessionShareSnapshot.ClaimInput
    claim.location = "C:\\workspace\\different"
    expect(() => SessionShareSnapshot.decode(snapshot, claim)).toThrow(/does not match location|scope drifted/)
  })

  test("later messages and appended secrets cannot enter an already sealed export", () => {
    const source = capture()
    const snapshot = SessionShareSnapshot.encode(source)
    const originalDigest = snapshot.export.contentDigest
    const originalLength = snapshot.export.items.length

    ;(source.export.items as Array<SessionShareSnapshot.ExportItem>).push({
      key: "message/msg_later_secret",
      type: "message",
      data: {
        id: "msg_later_secret",
        sessionID,
        role: "user",
        authorization: "Bearer later-secret-value",
      },
    })

    expect(snapshot.export.items).toHaveLength(originalLength)
    expect(snapshot.export.contentDigest).toBe(originalDigest)
    expect(() =>
      SessionShareSnapshot.decode(snapshot, SessionShareSnapshot.claimMaterial(snapshot).input),
    ).not.toThrow()

    const appended = structuredClone(snapshot)
    ;(appended.export.items as Array<SessionShareSnapshot.ExportItem>).push(source.export.items.at(-1)!)
    expect(() => SessionShareSnapshot.executionInput(appended)).toThrow(/sensitive-key heuristic|secret-looking/)
  })

  test("requires HTTPS for every endpoint, including loopback", () => {
    const payloadSelectedPolicy = capture() as SessionShareSnapshot.Capture & {
      target: { transportPolicy?: string }
    }
    payloadSelectedPolicy.target.transportPolicy = "allow-http-loopback"
    expect(() => SessionShareSnapshot.encode(payloadSelectedPolicy)).toThrow(/capture schema is invalid/)

    const userinfo = capture()
    ;(userinfo.target as { baseURL: string }).baseURL = "https://user:password@share.example.com"
    expect(() => SessionShareSnapshot.encode(userinfo)).toThrow(/userinfo/)

    const insecure = capture()
    ;(insecure.target as { baseURL: string }).baseURL = "http://share.example.com"
    expect(() => SessionShareSnapshot.encode(insecure)).toThrow(/must use HTTPS/)

    const localHttp = capture()
    ;(localHttp.target as { baseURL: string }).baseURL = "http://127.0.0.1:8787"
    expect(() => SessionShareSnapshot.encode(localHttp)).toThrow(/must use HTTPS/)

    const localHttps = capture()
    ;(localHttps.target as { baseURL: string }).baseURL = "https://127.0.0.1:8787/"
    expect(SessionShareSnapshot.encode(localHttps).target).toMatchObject({
      baseURL: "https://127.0.0.1:8787",
      transportPolicy: "https-only",
    })

    const tokenInPath = capture()
    ;(tokenInPath.target as { baseURL: string }).baseURL =
      "https://share.example.com/api/sk_example_secret_token_123456"
    expect(() => SessionShareSnapshot.encode(tokenInPath)).toThrow(/path contains a secret-looking token/)
  })

  test("rejects secret-looking fields, token values, and oversized export content", () => {
    const header = capture()
    ;(header.export.items[0]!.data as Record<string, unknown>).headers = {
      authorization: "Bearer abcdefghijklmnop",
    }
    expect(() => SessionShareSnapshot.encode(header)).toThrow(/sensitive-key heuristic/)

    for (const field of ["tokenValue", "authSession", "sessionState", "cookieJar"]) {
      const keyFamily = capture()
      ;(keyFamily.export.items[1]!.data as Record<string, unknown>)[field] = "not-even-token-shaped"
      expect(() => SessionShareSnapshot.encode(keyFamily)).toThrow(/sensitive-key heuristic/)
    }

    const token = capture()
    ;(token.export.items[1]!.data as Record<string, unknown>).text = "sk_example_secret_token_123456"
    expect(() => SessionShareSnapshot.encode(token)).toThrow(/secret-looking token/)

    const connectionString = capture()
    ;(connectionString.export.items[1]!.data as Record<string, unknown>).text =
      "postgresql://db_user:db_password@db.example.com/app"
    expect(() => SessionShareSnapshot.encode(connectionString)).toThrow(/secret-looking token/)

    const jwt = capture()
    ;(jwt.export.items[1]!.data as Record<string, unknown>).text =
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEyMzQifQ.signature_value_1234"
    expect(() => SessionShareSnapshot.encode(jwt)).toThrow(/secret-looking token/)

    const oversized = capture()
    ;(oversized.export.items[1]!.data as Record<string, unknown>).text = "x".repeat(
      SessionShareSnapshot.MAX_STRING_BYTES + 1,
    )
    expect(() => SessionShareSnapshot.encode(oversized)).toThrow(/oversized (?:raw )?string/)
  })

  test("bounds heuristic exclusions and the complete canonical envelope", () => {
    let arrayGetterCalled = false
    const accessorItems: unknown[] = []
    Object.defineProperty(accessorItems, "0", {
      enumerable: true,
      configurable: true,
      get: () => {
        arrayGetterCalled = true
        return capture().export.items[0]
      },
    })
    expect(() =>
      SessionShareSnapshot.encode({
        ...capture(),
        export: {
          format: SessionShareSnapshot.FORMAT,
          items: accessorItems as SessionShareSnapshot.Capture["export"]["items"],
        },
      }),
    ).toThrow(/accessor property/)
    expect(arrayGetterCalled).toBe(false)

    let proxyTrapCalled = false
    const proxied = new Proxy(capture(), {
      getPrototypeOf: () => {
        proxyTrapCalled = true
        return Object.prototype
      },
    })
    expect(() => SessionShareSnapshot.encode(proxied)).toThrow(/cannot be a Proxy/)
    expect(proxyTrapCalled).toBe(false)

    const tooDeep = capture()
    let cursor = tooDeep.export.items[1]!.data as Record<string, unknown>
    for (let depth = 0; depth <= SessionShareSnapshot.MAX_RAW_DEPTH; depth++) {
      const child: Record<string, unknown> = {}
      cursor.child = child
      cursor = child
    }
    expect(() => SessionShareSnapshot.encode(tooDeep)).toThrow(/raw depth limit/)

    const tooManyExclusions = capture()
    ;(tooManyExclusions.heuristicScan.excluded as Array<SessionShareSnapshot.Exclusion>).push(
      ...Array.from({ length: SessionShareSnapshot.MAX_EXCLUSIONS }, (_, index) => ({
        path: `/extra/${index}`,
        reason: "user-marked" as const,
      })),
    )
    expect(() => SessionShareSnapshot.encode(tooManyExclusions)).toThrow(/exclusions exceed/)

    const oversizedEnvelope = capture()
    const blob = "x".repeat(SessionShareSnapshot.MAX_STRING_BYTES - 16 * 1024)
    ;(oversizedEnvelope.export.items[0]!.data as Record<string, unknown>).blob = blob
    ;(oversizedEnvelope.export.items[1]!.data as Record<string, unknown>).blob = blob
    ;(oversizedEnvelope.export.items[2]!.data as Record<string, unknown>).blob = blob
    ;(oversizedEnvelope.export.items[4] as { data: unknown }).data = [blob]
    ;(oversizedEnvelope.heuristicScan.excluded as Array<SessionShareSnapshot.Exclusion>).splice(
      0,
      oversizedEnvelope.heuristicScan.excluded.length,
      ...Array.from({ length: SessionShareSnapshot.MAX_EXCLUSIONS }, (_, index) => ({
        path: `/excluded/${index}/${"x".repeat(880)}`,
        reason: "user-marked" as const,
      })),
    )
    expect(() => SessionShareSnapshot.encode(oversizedEnvelope)).toThrow(/complete canonical bytes|capture exceeds/)
  })

  test("freezes unshare publication identity and also requires fresh L3 human approval", () => {
    const snapshot = SessionShareSnapshot.encode(capture("unshare"))
    const material = SessionShareSnapshot.actionMaterial(snapshot)

    expect(snapshot.target.publication).toMatchObject({
      id: "shr_static_1",
      exportDigest: originalPublicationDigest,
    })
    expect(material.name).toBe("session.unshare")
    expect(material.semantics.riskTier).toBe("L3")
    expect(material.semantics.authority).toBe("human")
    expect(material.semantics.retryability).toBe("never")
    expect(material.requiresFreshHumanConfirmation).toBe(true)

    const changedSession = capture("unshare")
    ;(changedSession.export.items[0]!.data as Record<string, unknown>).title = "Changed after original publication"
    const changedSnapshot = SessionShareSnapshot.encode(changedSession)
    expect(changedSnapshot.export.contentDigest).not.toBe(snapshot.export.contentDigest)
    expect(changedSnapshot.target.publication?.exportDigest).toBe(originalPublicationDigest)

    const invalidHistory = capture("unshare")
    ;(invalidHistory.target.publication as { originalExportDigest: string }).originalExportDigest = "not-a-digest"
    expect(() => SessionShareSnapshot.encode(invalidHistory)).toThrow(/originalExportDigest must be a sha256/)
  })
})
