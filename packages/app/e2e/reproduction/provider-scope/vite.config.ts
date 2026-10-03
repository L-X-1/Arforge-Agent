import { defineConfig } from "vite"
import appPlugin from "../../../vite.js"

export default defineConfig({
  root: import.meta.dirname,
  plugins: appPlugin,
})
