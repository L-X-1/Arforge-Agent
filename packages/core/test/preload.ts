import path from "path"

process.env.ARFORGE_DB = ":memory:"
process.env.ARFORGE_MODELS_PATH = path.join(import.meta.dir, "plugin", "fixtures", "models-dev.json")
process.env.ARFORGE_DISABLE_MODELS_FETCH = "true"
