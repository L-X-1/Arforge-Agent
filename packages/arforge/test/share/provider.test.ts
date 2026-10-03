import { describe, expect, test } from "bun:test"
import { Effect, Exit } from "effect"
import { SessionID } from "@/session/schema"
import * as SessionShareSnapshot from "@/share/session-snapshot"
import * as SessionShareProvider from "@/share/provider"

const sessionID = SessionID.make("ses_provider_contract_1234")
const snapshot = SessionShareSnapshot.encode({
  version: 1,
  kind: "share",
  requestID: "cpr_provider_contract_1234",
  sessionID,
  projectID: "prj_provider_contract",
  location: "C:\\workspace\\provider",
  eventHighWaterMark: 7,
  export: {
    format: SessionShareSnapshot.FORMAT,
    items: [
      {
        key: "session",
        type: "session",
        data: { id: sessionID, projectID: "prj_provider_contract", directory: "C:\\workspace\\provider" },
      },
    ],
  },
  target: {
    baseURL: "https://share.example.com/api",
    organizationID: null,
    visibility: "private",
    publication: null,
  },
  heuristicScan: {
    scannerVersion: SessionShareSnapshot.HEURISTIC_SCANNER_VERSION,
    excluded: [],
  },
})

const publishInput: SessionShareProvider.PublishInput = {
  operationID: "act_provider_contract_1234",
  frozenExport: snapshot.export,
  exportDigest: snapshot.export.contentDigest,
  target: snapshot.target,
}

const publication: SessionShareProvider.PublicationReceipt = {
  providerReceiptID: "rcpt_provider_contract_1",
  publicationID: "shr_provider_contract_1",
  publicationURL: "https://share.example.com/s/shr_provider_contract_1",
  storedDigest: snapshot.export.contentDigest,
  visibility: "private",
  organizationID: null,
}

describe("SessionShareProvider", () => {
  test("verifies publish receipt identity, digest, target, and endpoint origin", () => {
    const result = SessionShareProvider.verifyPublishResult(publishInput, {
      operationID: publishInput.operationID,
      status: "settled",
      publication,
    })
    expect(result.publication).toEqual(publication)

    expect(() =>
      SessionShareProvider.verifyPublishResult(publishInput, {
        operationID: publishInput.operationID,
        status: "settled",
        publication: { ...publication, storedDigest: "f".repeat(64) },
      }),
    ).toThrow(/does not match/)
    expect(() =>
      SessionShareProvider.verifyPublishResult(publishInput, {
        operationID: publishInput.operationID,
        status: "settled",
        publication: { ...publication, publicationURL: "https://other.example.com/s/1" },
      }),
    ).toThrow(/outside the approved endpoint/)
  })

  test("requires lookup reconciliation and rejects provider conflicts", () => {
    expect(
      SessionShareProvider.verifyPublishLookup(publishInput, {
        operationID: publishInput.operationID,
        status: "pending",
      }),
    ).toMatchObject({ status: "pending" })
    expect(() =>
      SessionShareProvider.verifyPublishLookup(publishInput, {
        operationID: publishInput.operationID,
        status: "conflict",
        conflictingDigest: "e".repeat(64),
      }),
    ).toThrow(/conflicts/)
    expect(() =>
      SessionShareProvider.verifyPublishLookup(publishInput, {
        operationID: publishInput.operationID,
        status: "settled",
      }),
    ).toThrow(/omitted its publication receipt/)
  })

  test("binds revoke receipt and lookup to original publication identity", () => {
    const input: SessionShareProvider.RevokeInput = {
      operationID: "act_provider_unshare_1234",
      publicationID: publication.publicationID,
      originalDigest: publication.storedDigest,
      target: {
        ...snapshot.target,
        publication: {
          id: publication.publicationID,
          url: publication.publicationURL,
          exportDigest: publication.storedDigest,
        },
      },
    }
    expect(
      SessionShareProvider.verifyRevokeResult(input, {
        operationID: input.operationID,
        status: "settled",
        publicationID: input.publicationID,
        removedDigest: input.originalDigest,
        visibility: "private",
        organizationID: null,
      }),
    ).toMatchObject({ status: "settled" })
    const reconciled = SessionShareProvider.verifyRevokeLookup(input, {
      operationID: input.operationID,
      status: "settled",
      publicationID: input.publicationID,
      removedDigest: input.originalDigest,
    })
    expect(reconciled).toEqual({
      operationID: input.operationID,
      status: "settled",
      publicationID: input.publicationID,
      removedDigest: input.originalDigest,
      visibility: "private",
      organizationID: null,
    })
    expect(() =>
      SessionShareProvider.verifyRevokeLookup(input, {
        operationID: input.operationID,
        status: "settled",
        publicationID: "shr_other",
        removedDigest: input.originalDigest,
      }),
    ).toThrow(/does not match/)
    expect(() =>
      SessionShareProvider.verifyRevokeResult(
        {
          ...input,
          target: {
            ...input.target,
            publication: { ...input.target.publication!, url: "https://other.example.com/s/shr_static_1" },
          },
        },
        {
          operationID: input.operationID,
          status: "settled",
          publicationID: input.publicationID,
          removedDigest: input.originalDigest,
          visibility: "private",
          organizationID: null,
        },
      ),
    ).toThrow(/outside the approved endpoint/)
  })

  test("disabled production adapter never guesses a remote outcome", async () => {
    expect(await Effect.runPromise(SessionShareProvider.disabled.availability())).toBe("unavailable")
    const exit = await Effect.runPromiseExit(SessionShareProvider.disabled.publish(publishInput))
    expect(Exit.isFailure(exit)).toBe(true)
  })
})
