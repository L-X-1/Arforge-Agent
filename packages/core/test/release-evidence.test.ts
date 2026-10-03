import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { expect, test } from "bun:test"
import { buildReleaseEvidence, verifyReleaseEvidence } from "../../../script/release-evidence"

const root = resolve(import.meta.dir, "../../..")

async function temporaryEvidenceDirectory() {
  return mkdtemp(join(tmpdir(), "arforge-release-evidence-"))
}

test("release evidence is deterministic and verifies its SBOM/provenance hashes", async () => {
  const firstDir = await temporaryEvidenceDirectory()
  const secondDir = await temporaryEvidenceDirectory()
  try {
    const first = await buildReleaseEvidence({ root, outputDir: firstDir, allowDirty: true, sourceDateEpoch: "0" })
    const second = await buildReleaseEvidence({ root, outputDir: secondDir, allowDirty: true, sourceDateEpoch: "0" })

    expect(first.signature.status).toBe("candidate")
    expect(first.manifest).toEqual(second.manifest)
    expect((await verifyReleaseEvidence(firstDir, false, root)).verifiedFiles.length).toBe(4)
    expect(JSON.parse(await readFile(join(firstDir, "sbom.cdx.json"), "utf8")).bomFormat).toBe("CycloneDX")
  } finally {
    await rm(firstDir, { recursive: true, force: true })
    await rm(secondDir, { recursive: true, force: true })
  }
}, 15_000)

test("release evidence rejects tampering and never upgrades a candidate to signed", async () => {
  const outputDir = await temporaryEvidenceDirectory()
  try {
    await buildReleaseEvidence({ root, outputDir, allowDirty: true, sourceDateEpoch: "0" })
    await writeFile(join(outputDir, "provenance.json"), "tampered", "utf8")
    await expect(verifyReleaseEvidence(outputDir, false, root)).rejects.toThrow("hash mismatch")

    await expect(
      buildReleaseEvidence({ root, outputDir, allowDirty: true, sourceDateEpoch: "0", requireSigned: true }),
    ).rejects.toThrow("not signed")
  } finally {
    await rm(outputDir, { recursive: true, force: true })
  }
}, 15_000)

test("signed status requires a digest-bound artifact and protected review metadata", async () => {
  const artifactDir = await mkdtemp(join(root, "artifacts", "release-evidence-test-"))
  const outputDir = await temporaryEvidenceDirectory()
  try {
    const artifactPath = join(artifactDir, "candidate.exe")
    await writeFile(artifactPath, "signed-candidate-fixture", "utf8")
    const digest = createHash("sha256")
      .update(await readFile(artifactPath))
      .digest("hex")
    const artifactName = artifactPath.slice(root.length + 1).replaceAll("\\", "/")
    const signatureEvidencePath = join(artifactDir, "signed-candidate.json")
    await writeFile(
      signatureEvidencePath,
      JSON.stringify({
        schema_version: 2,
        status: "pass",
        private_key_export_blocked: true,
        required_reviewers_approved: true,
        signing_material_removed: true,
        artifacts: [
          {
            name: artifactName,
            sha256: digest,
            signature_status: "Valid",
            timestamped: true,
            signer_subject: "CN=Arforge Test Signer",
          },
        ],
      }),
      "utf8",
    )

    const report = await buildReleaseEvidence({
      root,
      outputDir,
      artifacts: [artifactPath],
      signatureEvidence: signatureEvidencePath,
      allowDirty: true,
      sourceDateEpoch: "0",
      requireSigned: true,
    })
    expect(report.signature.status).toBe("signed")
    expect((await verifyReleaseEvidence(outputDir, true, root)).signature.status).toBe("signed")
  } finally {
    await rm(artifactDir, { recursive: true, force: true })
    await rm(outputDir, { recursive: true, force: true })
  }
})
