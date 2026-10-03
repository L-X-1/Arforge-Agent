import path from "path"
import { afterAll } from "bun:test"
import { tmpdir } from "./fixture/tmpdir"

// Database isolation alone is insufficient: Gateway result retention, artifact
// catalogues and locks also write through Global. Keep the whole test process
// (and its inherited child workers) off the user's real profile.
const profile = await tmpdir()
process.env.ARFORGE_HOME = profile.path
process.env.ARFORGE_TEST_HOME = path.join(profile.path, "home")
process.env.ARFORGE_CONFIG_DIR = path.join(profile.path, "config")
process.env.ARFORGE_TEST_MANAGED_CONFIG_DIR = path.join(profile.path, "managed")
afterAll(() => profile[Symbol.asyncDispose]())

process.env.ARFORGE_DB = ":memory:"
process.env.ARFORGE_MODELS_PATH = path.join(import.meta.dir, "plugin", "fixtures", "models-dev.json")
process.env.ARFORGE_DISABLE_MODELS_FETCH = "true"
