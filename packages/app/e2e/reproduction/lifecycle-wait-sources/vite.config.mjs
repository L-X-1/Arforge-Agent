import { resolve } from "node:path"
import { createAppPlugin } from '../../../vite.js'

const root = import.meta.dirname
export default {
  root,
  envDir: false,
  publicDir: false,
  server: { hmr: false, fs: { allow: [resolve(root, "../../../../..")] } },
  plugins: createAppPlugin({ solidHot: false }),
}
