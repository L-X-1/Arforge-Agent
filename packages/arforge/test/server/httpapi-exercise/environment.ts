import { Flag } from "@arforge-ai/core/flag/flag"
import { Effect } from "effect"
import os from "node:os"
import path from "path"

const preserveExerciseGlobalRoot = !!process.env.ARFORGE_HTTPAPI_EXERCISE_GLOBAL
export const exerciseGlobalRoot = path.resolve(
  process.env.ARFORGE_HTTPAPI_EXERCISE_GLOBAL ??
    path.join(process.env.TMPDIR ?? os.tmpdir(), `arforge-httpapi-global-${process.pid}`),
)
process.env.XDG_DATA_HOME = path.join(exerciseGlobalRoot, "data")
process.env.XDG_CONFIG_HOME = path.join(exerciseGlobalRoot, "config")
process.env.XDG_STATE_HOME = path.join(exerciseGlobalRoot, "state")
process.env.XDG_CACHE_HOME = path.join(exerciseGlobalRoot, "cache")
process.env.ARFORGE_DISABLE_SHARE = "true"
process.env.ARFORGE_DATABASE_MODE = "local"
process.env.ARFORGE_HOME = path.join(exerciseGlobalRoot, "python")
process.env.ARFORGE_DB_URL = sqliteUrl(path.join(exerciseGlobalRoot, "python", "learning.db"))
process.env.ARFORGE_MULTIAGENT_DB_URL = sqliteUrl(path.join(exerciseGlobalRoot, "python", "multiagent.db"))
export const exerciseConfigDirectory = path.join(exerciseGlobalRoot, "config", "arforge")
export const exerciseDataDirectory = path.join(exerciseGlobalRoot, "data", "arforge")

const preserveExerciseDatabase = !!process.env.ARFORGE_HTTPAPI_EXERCISE_DB
export const exerciseDatabasePath = path.resolve(
  process.env.ARFORGE_HTTPAPI_EXERCISE_DB ??
    path.join(process.env.TMPDIR ?? os.tmpdir(), `arforge-httpapi-exercise-${process.pid}.db`),
)
process.env.ARFORGE_DB = exerciseDatabasePath
Flag.ARFORGE_DB = exerciseDatabasePath

export const original = {
  ARFORGE_SERVER_PASSWORD: Flag.ARFORGE_SERVER_PASSWORD,
  ARFORGE_SERVER_USERNAME: Flag.ARFORGE_SERVER_USERNAME,
}

function sqliteUrl(filename: string) {
  return `sqlite:///${path.resolve(filename).replaceAll("\\", "/")}`
}

export const cleanupExercisePaths = Effect.promise(async () => {
  const fs = await import("fs/promises")
  if (!preserveExerciseDatabase) {
    await Promise.all(
      [exerciseDatabasePath, `${exerciseDatabasePath}-wal`, `${exerciseDatabasePath}-shm`].map((file) =>
        fs.rm(file, { force: true }).catch(() => undefined),
      ),
    )
  }
  if (!preserveExerciseGlobalRoot)
    await fs.rm(exerciseGlobalRoot, { recursive: true, force: true }).catch(() => undefined)
})
