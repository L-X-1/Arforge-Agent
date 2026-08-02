import { describe, expect, test } from "bun:test"
import {
  containsExternalRoot,
  manifestFailures,
  relativeArforgeReferences,
  type FusionPolicy,
} from "../../../script/fusion-audit"

const policy = {
  canonicalRootName: "Arforge-Agent",
  canonicalVersion: "1.0.0-test.1",
  canonicalPackageScope: "@arforge-ai/",
  externalReferenceRoots: ["E:/Arforge"],
  excludeDirectories: [],
  externalReferenceDocumentation: [],
  compatibleVendoredPackages: ["ghostty-web", "gitlab-ai-provider"],
  versionedManifests: ["package.json"],
  defaultScripts: {},
  requiredEntrypoints: [],
} satisfies FusionPolicy

describe("fusion audit boundaries", () => {
  test("distinguishes the external reference root from the fused repository", () => {
    expect(containsExternalRoot("E:\\Arforge\\packages\\app", "E:/Arforge")).toBe(true)
    expect(containsExternalRoot("source E:/Arforge", "E:/Arforge")).toBe(true)
    expect(containsExternalRoot("E:\\Arforge-Agent\\packages\\app", "E:/Arforge")).toBe(false)
  })

  test("extracts relative reference candidates for resolution by the repository audit", () => {
    expect(relativeArforgeReferences('path.resolve(import.meta.dir, "../arforge/dist/node")')).toEqual([
      "../arforge/dist/node",
    ])
    expect(relativeArforgeReferences("ordinary arforge product text")).toEqual([])
  })

  test("accepts private scoped and compatibility packages", () => {
    expect(
      manifestFailures(
        "packages/ui/package.json",
        { name: "@arforge-ai/ui", private: true, license: "UNLICENSED" },
        policy,
      ),
    ).toEqual([])
    expect(
      manifestFailures(
        "packages/ghostty-web/package.json",
        { name: "ghostty-web", private: true, license: "UNLICENSED" },
        policy,
      ),
    ).toEqual([])
  })

  test("rejects public metadata and wrong canonical versions", () => {
    const findings = manifestFailures(
      "package.json",
      {
        name: "foreign",
        version: "0.1.0",
        private: false,
        license: "MIT",
        repository: "https://example.invalid/repository",
      },
      policy,
    )
    expect(findings.map((finding) => finding.rule)).toEqual([
      "manifest",
      "manifest",
      "manifest",
      "package-name",
      "package-version",
    ])
  })
})
