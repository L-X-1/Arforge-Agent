import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Database as SQLiteDatabase } from "bun:sqlite"

export const verifyInterruptedControlRecovery = async (
  databasePath: string,
  workspace: string,
  sourceRunID: string,
) => {
  for (const phase of ["prepare-periodic", "prepare", "prepare-settled"]) {
    const ready = join(workspace, `control-crash-${crypto.randomUUID()}.json`)
    let workerDatabasePath = databasePath
    const spawn = (runID: string, mode: string, barrier = ready) => {
      const processHandle = Bun.spawn(
        [
          process.execPath,
          join(import.meta.dir, "subagent-control-access-worker.ts"),
          workerDatabasePath,
          workspace,
          runID,
          mode,
          barrier,
        ],
        {
          env: { ...process.env },
          stdout: "pipe",
          stderr: "pipe",
        },
      )
      return {
        processHandle,
        stdout: new Response(processHandle.stdout).text(),
        stderr: new Response(processHandle.stderr).text(),
      }
    }
    const preparing = spawn(sourceRunID, phase)
    let pendingID: string
    let expiresAt: number
    const deadline = setTimeout(() => preparing.processHandle.kill(), 15_000)
    try {
      while (!existsSync(ready)) {
        if (preparing.processHandle.exitCode !== null)
          throw new Error(`Control crash worker exited early: ${await preparing.stderr}`)
        await Bun.sleep(10)
      }
      const marker = JSON.parse(readFileSync(ready, "utf8"))
      if (typeof marker.runID !== "string" || !Number.isFinite(marker.expiresAt))
        throw new Error("invalid control crash readiness")
      pendingID = marker.runID
      expiresAt = marker.expiresAt
      preparing.processHandle.kill("SIGKILL")
      if ((await preparing.processHandle.exited) === 0) throw new Error("control crash worker exited normally")
    } finally {
      clearTimeout(deadline)
      preparing.processHandle.kill()
      await preparing.processHandle.exited
      await Promise.all([preparing.stdout, preparing.stderr])
    }
    // Honor the original durable lease; never rewrite a persisted expiry.
    if (phase === "prepare-settled") {
      const source = new SQLiteDatabase(databasePath, { readonly: true })
      try {
        writeFileSync(`${ready}.running.sqlite`, source.serialize())
      } finally {
        source.close()
      }
    }
    if (phase === "prepare-periodic") {
      // A coherent SQLite snapshot excludes the HTTP host's independent scanner.
      // Plain copying would miss committed WAL pages.
      const source = new SQLiteDatabase(databasePath, { readonly: true })
      try {
        workerDatabasePath = `${ready}.sqlite`
        writeFileSync(workerDatabasePath, source.serialize())
      } finally {
        source.close()
      }
    }
    if (phase !== "prepare-periodic") await Bun.sleep(Math.max(0, expiresAt - Date.now() + 50))
    const recoveryMode =
      phase === "prepare-periodic"
        ? "recover-scan-periodic"
        : phase === "prepare-settled"
          ? "recover-scan-settled"
          : "recover-scan"
    for (const mode of [recoveryMode, "replay"]) {
      const workers = Array.from({ length: mode === "replay" ? 1 : 2 }, () => spawn(pendingID, mode))
      const timer = setTimeout(
        () => workers.forEach((worker) => worker.processHandle.kill()),
        mode === "recover-scan-periodic" ? 45_000 : 15_000,
      )
      try {
        if (mode !== "replay") {
          while (!workers.every((worker) => existsSync(`${ready}.scan-${worker.processHandle.pid}`))) {
            if (workers.some((worker) => worker.processHandle.exitCode !== null))
              throw new Error("scan worker exited before both processes reached the recovery barrier")
            await Bun.sleep(10)
          }
          writeFileSync(`${ready}.scan-release`, "release", "utf8")
        }
        const results = await Promise.all(
          workers.map(async (worker) => ({
            code: await worker.processHandle.exited,
            output: await worker.stdout,
            error: await worker.stderr,
          })),
        )
        for (const { code, output, error } of results)
          if (code !== 0 || !output.split(/\r?\n/).includes("SUBAGENT_ACCESS=allowed"))
            throw new Error(`Interrupted control ${mode} failed (${code}): ${error}\n${output}`)
      } finally {
        clearTimeout(timer)
        workers.forEach((worker) => worker.processHandle.kill())
        await Promise.all(
          workers.map(async (worker) => {
            await worker.processHandle.exited
            await Promise.all([worker.stdout, worker.stderr])
          }),
        )
      }
    }
    if (phase === "prepare-settled")
      for (const revokeMode of ["replay-revoke", "recover-revoke"]) {
        const source = new SQLiteDatabase(databasePath, { readonly: true })
        try {
          workerDatabasePath = `${ready}.revoke.sqlite`
          writeFileSync(workerDatabasePath, source.serialize())
        } finally {
          source.close()
        }
        if (revokeMode === "recover-revoke") workerDatabasePath = `${ready}.running.sqlite`
        const revokeReady = `${ready}.${revokeMode}`
        const worker = spawn(pendingID, revokeMode, revokeReady)
        const timer = setTimeout(() => worker.processHandle.kill(), 15_000)
        let restore: { sessionID: string; tenantID: string } | undefined
        try {
          while (!existsSync(`${revokeReady}.revoke-ready`)) {
            if (worker.processHandle.exitCode !== null)
              throw new Error(`revocation worker exited before Gateway barrier: ${await worker.stderr}`)
            await Bun.sleep(10)
          }
          const marker = JSON.parse(readFileSync(`${revokeReady}.revoke-ready`, "utf8"))
          if (typeof marker.sessionID !== "string") throw new Error("invalid revocation session marker")
          const writer = new SQLiteDatabase(workerDatabasePath)
          try {
            const original = writer
              .query<{ tenant_id: string }, [string]>("SELECT tenant_id FROM session WHERE id = ?")
              .get(marker.sessionID)
            if (!original) throw new Error("revocation target session is missing")
            restore = { sessionID: marker.sessionID, tenantID: original.tenant_id }
            const changed = writer
              .query(
                `UPDATE session SET tenant_id = (
            SELECT id FROM identity_tenant WHERE id <> session.tenant_id ORDER BY id LIMIT 1
          ) WHERE id = ?`,
              )
              .run(marker.sessionID)
            if (changed.changes !== 1) throw new Error("revocation did not update exactly the target session")
          } finally {
            writer.close()
          }
          writeFileSync(`${revokeReady}.revoke-release`, "release", "utf8")
          const code = await worker.processHandle.exited
          const output = await worker.stdout
          const error = await worker.stderr
          if (code !== 0 || !output.split(/\r?\n/).includes("SUBAGENT_ACCESS=denied"))
            throw new Error(`cross-process result revocation failed (${code}): ${error}\n${output}`)
        } finally {
          clearTimeout(timer)
          worker.processHandle.kill()
          await worker.processHandle.exited
          await Promise.all([worker.stdout, worker.stderr])
        }
        if (!restore) throw new Error("missing original ownership for reauthorization")
        const restoring = new SQLiteDatabase(workerDatabasePath)
        try {
          if (
            restoring.query("UPDATE session SET tenant_id = ? WHERE id = ?").run(restore.tenantID, restore.sessionID)
              .changes !== 1
          )
            throw new Error("reauthorization did not restore exactly the original session")
        } finally {
          restoring.close()
        }
        for (const resumeMode of revokeMode === "recover-revoke" ? ["recover-settled", "replay"] : ["replay"]) {
          const resumed = spawn(pendingID, resumeMode)
          const resumeTimer = setTimeout(() => resumed.processHandle.kill(), 15_000)
          try {
            const code = await resumed.processHandle.exited
            const output = await resumed.stdout
            const error = await resumed.stderr
            if (code !== 0 || !output.split(/\r?\n/).includes("SUBAGENT_ACCESS=allowed"))
              throw new Error(`reauthorized ${resumeMode} failed (${code}): ${error}\n${output}`)
          } finally {
            clearTimeout(resumeTimer)
            resumed.processHandle.kill()
            await resumed.processHandle.exited
            await Promise.all([resumed.stdout, resumed.stderr])
          }
        }
      }
  }
}
