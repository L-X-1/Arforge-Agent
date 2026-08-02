"use strict"

const { execFileSync } = require("node:child_process")

exports.default = async function signWithKeyLocker(configuration) {
  const target = String(configuration && configuration.path ? configuration.path : "").trim()
  const keypairAlias = String(process.env.ARFORGE_WINDOWS_KEYPAIR_ALIAS || "").trim()

  if (!target) throw new Error("Electron Builder did not provide a signing target path")
  if (!keypairAlias) throw new Error("ARFORGE_WINDOWS_KEYPAIR_ALIAS is required")

  execFileSync(
    "smctl",
    [
      "sign",
      "--keypair-alias",
      keypairAlias,
      "--input",
      target,
      "--tool",
      "signtool",
      "--timestamp",
    ],
    { stdio: "inherit", windowsHide: true },
  )
}
