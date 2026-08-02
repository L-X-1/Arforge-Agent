[CmdletBinding()]
param(
  [string]$KeyFile
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot "postgres-backup-crypto.ps1")

$masterKey = Get-ArforgeBackupMasterKey $KeyFile
try {
  $payload = [ordered]@{
    format = "Arforge PostgreSQL backup recovery key"
    version = 1
    keyBase64 = [Convert]::ToBase64String($masterKey)
  } | ConvertTo-Json -Compress
  Set-Clipboard -Value $payload
  Write-Output "The Arforge PostgreSQL recovery key was copied to the clipboard. Store it in an offline password manager, then clear the clipboard."
} finally {
  [Array]::Clear($masterKey, 0, $masterKey.Length)
}
