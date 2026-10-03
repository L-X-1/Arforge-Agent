import "../../../src/index.css"
import { render } from "solid-js/web"
import { LanguageProvider } from "../../../src/context/language"
import { PlatformProvider } from "../../../src/context/platform"
import { DiagnosticsWorkbench } from "../../../src/components/control-center/capability-workbench"
import type { OperationsApi } from "../../../src/utils/server"

const directory = "C:/Arforge/DiagnosticsPreviewFixture"
const discoveryDigest = "f".repeat(64)

const api = {
  diagnostics: {
    diagnose: async () => ({
      schemaVersion: 1 as const,
      localOnly: true as const,
      mode: "frontend" as const,
      path: "src/index.html",
      success: true,
      textChars: 146,
      lineCount: 8,
      truncated: false,
      modelCalls: 0,
      source: { type: "file" as const, path: "src/index.html" },
      signals: [],
      searchTerms: [],
      matches: [],
      suggestions: ["Review the preview before requesting an explicit approval."],
      warnings: [],
      summary: { textChars: 146, signals: 0, searchTerms: 0, matches: 0 },
      frontend: {
        schemaVersion: 1 as const,
        localOnly: true as const,
        mode: "frontend" as const,
        path: "src/index.html",
        success: true,
        textChars: 146,
        lineCount: 8,
        truncated: false,
        script: { tags: 1, inline: 0, external: 1, blocking: 0 },
        framework: "none" as const,
        externalAssets: [
          { kind: "script" as const, url: "https://cdn.example.test/app.js?token=%5BREDACTED%5D", local: false },
        ],
        assetLocalizationPreview: {
          status: "ready" as const,
          execution: "preview_only" as const,
          htmlResource: "src/index.html",
          assetRoot: "vendor",
          discoveryDigest,
          references: [{ kind: "script" as const, url: "https://cdn.example.test/app.js?token=%5BREDACTED%5D" }],
          networkScopeCount: 1,
        },
        issues: [],
      },
    }),
  },
} as unknown as OperationsApi

render(
  () => (
    <PlatformProvider
      value={{
        platform: "web",
        openLink: () => undefined,
        restart: async () => undefined,
        back: () => undefined,
        forward: () => undefined,
        notify: async () => undefined,
      }}
    >
      <LanguageProvider locale="en">
        <DiagnosticsWorkbench api={() => api} location={() => ({ location: { directory } })} ready={() => true} />
      </LanguageProvider>
    </PlatformProvider>
  ),
  document.getElementById("root")!,
)
