import { seedDesktopVerifiedExperience } from "./desktop-verified-experience-fixture"

const [databasePath, workspace] = Bun.argv.slice(2)
if (!databasePath || !workspace) throw new Error("database path and workspace are required")

const experienceIDs = await seedDesktopVerifiedExperience({ databasePath, workspace })
process.stdout.write(JSON.stringify(experienceIDs))
