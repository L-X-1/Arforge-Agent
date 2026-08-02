import { readFileSync } from "node:fs"
import solidPlugin from "vite-plugin-solid"
import tailwindcss from "@tailwindcss/vite"
import { fileURLToPath } from "url"

const theme = fileURLToPath(new URL("./public/arforge-theme-preload.js", import.meta.url))

const channel = (() => {
  const raw = process.env.ARFORGE_CHANNEL
  if (raw === "dev" || raw === "beta" || raw === "prod") return raw
  if (process.env.ARFORGE_CHANNEL === "latest") return "prod"
  return "dev"
})()

/**
 * @param {{ solidHot?: boolean }} [options]
 * @returns {import("vite").PluginOption[]}
 */
export function createAppPlugin(options = {}) {
  return [
    {
      name: "arforge-desktop:config",
      config() {
        return {
          resolve: {
            alias: {
              "@": fileURLToPath(new URL("./src", import.meta.url)),
            },
          },
          define: {
            "import.meta.env.VITE_ARFORGE_CHANNEL": JSON.stringify(channel),
          },
          worker: {
            format: "es",
          },
        }
      },
    },
    {
      name: "arforge-desktop:theme-preload",
      transformIndexHtml(html) {
        return html.replace(
          '<script id="arforge-theme-preload-script" src="/arforge-theme-preload.js"></script>',
          `<script id="arforge-theme-preload-script">${readFileSync(theme, "utf8")}</script>`,
        )
      },
    },
    tailwindcss(),
    solidPlugin({ hot: options.solidHot ?? true }),
  ]
}

export default createAppPlugin()
