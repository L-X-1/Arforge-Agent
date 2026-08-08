import { defineConfig } from "astro/config"
import sitemap from "@astrojs/sitemap"
import solid from "@astrojs/solid-js"

export default defineConfig({
  site: "https://arforgeagent.com",
  output: "static",
  trailingSlash: "always",
  integrations: [solid(), sitemap({ filter: (page) => !page.includes("service-unavailable") })],
  build: {
    assets: "_assets",
  },
  vite: {
    build: {
      cssMinify: "lightningcss",
    },
  },
})
