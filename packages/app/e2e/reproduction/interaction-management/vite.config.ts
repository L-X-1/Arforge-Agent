import { defineConfig } from "vite"
import { fileURLToPath } from "node:url"
import { createAppPlugin } from "../../../vite.js"

export default defineConfig({
  root: import.meta.dirname,
  cacheDir: fileURLToPath(new URL("../../../../../docs/ui-redesign/interaction-audit-v3-20261029/management-vite-cache", import.meta.url)),
  plugins: [{ name: "isolated-session-source", enforce: "pre", resolveId(id, importer) {
    const from = importer?.replaceAll("\\", "/").split("?")[0]
    if (from?.endsWith("/src/context/control-approval.tsx") && id === "./global")
      return fileURLToPath(new URL("./approval-global.ts", import.meta.url))
    const target = id.replaceAll("\\", "/").replace(/\.tsx?$/, "")
    if (from?.endsWith("/src/components/settings-v2/dialog-settings-v2.tsx") &&
      ["general", "models", "providers", "servers", "settings-keybinds", "control-center", "session-operations-dialog"].some(name => target.endsWith("/" + name)))
      return fileURLToPath(new URL("./navigation-panels.tsx", import.meta.url))
    if (from?.endsWith("/src/components/settings-v2/general.tsx") && (["@/context/server-sdk", "@/context/server-sync"].includes(target) || /\/src\/context\/server-(?:sdk|sync)$/.test(target)))
      return fileURLToPath(new URL("./general-source.ts", import.meta.url))
    if (!from?.endsWith("/src/context/server-sdk.tsx")) return
    if (id === "./global" || id === "./server") return fileURLToPath(new URL("../ui-v2-automation-acceptance/boundary-fixture.ts", import.meta.url))
  } }, ...createAppPlugin({ solidHot: false })],
})
