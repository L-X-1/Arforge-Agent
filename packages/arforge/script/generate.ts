import path from "path"
import { fileURLToPath } from "url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const dir = path.resolve(__dirname, "..")
const bundledCatalog = path.resolve(__dirname, "../../core/assets/models.json")

process.chdir(dir)

export const modelsData = process.env.MODELS_DEV_API_JSON
  ? await Bun.file(process.env.MODELS_DEV_API_JSON).text()
  : process.env.ARFORGE_MODELS_URL
    ? await fetch(`${process.env.ARFORGE_MODELS_URL.replace(/\/$/, "")}/api.json`).then((response) => {
        if (!response.ok) throw new Error(`模型目录请求失败：HTTP ${response.status}`)
        return response.text()
      })
    : await Bun.file(bundledCatalog).text()
console.log(process.env.ARFORGE_MODELS_URL ? "已加载自定义模型目录" : "已加载内置离线模型目录")
