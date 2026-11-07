import { defineConfig } from "vite"
import { fileURLToPath } from "node:url"
import { createAppPlugin } from "../../../../vite.js"
import { suites } from "./suites"
const fixtures = fileURLToPath(new URL("../../", import.meta.url))
const output = fileURLToPath(new URL("../../../../../../docs/ui-redesign/interaction-audit-v3-20261029/management-broad-production", import.meta.url))
export default defineConfig({
  root: fixtures,
  cacheDir: output + "/.vite-cache",
  build: { outDir: output, emptyOutDir: false, sourcemap: false, rollupOptions: { input: Object.fromEntries(suites.map(suite => [suite, fixtures + "/" + suite + "/index.html"])) } },
  plugins: [{ name: "reviewed-fixture-context", enforce: "pre", transformIndexHtml: { order: "pre", handler(html, context) {
    const filename = context.filename.replaceAll("\\", "/")
    const suite = suites.find(suite => filename.endsWith("/" + suite + "/index.html"))
    if (!suite) throw new Error("Unreviewed HTML fixture: " + filename)
    return html.replace('src="/main.tsx"', 'src="/' + suite + '/main.tsx"')
  } }, transform(code, id) {
    const from = id.replaceAll("\\", "/").split("?")[0]
    if (!suites.some(suite => from.endsWith("/" + suite + "/main.tsx")) || code.includes('import { DialogProvider }')) return
    if (!code.includes("<LanguageProvider") || !code.includes("</LanguageProvider>")) throw new Error("Unreviewed fixture provider layout: " + from)
    return { code: 'import { DialogProvider } from "@arforge-ai/ui/context/dialog"\n' +
      code.replace(/<LanguageProvider([^>]*)>/, "<LanguageProvider$1><DialogProvider>").replace("</LanguageProvider>", "</DialogProvider></LanguageProvider>"), map: null }
  } }, ...createAppPlugin({ solidHot: false })],
})
