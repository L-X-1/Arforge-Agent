[CmdletBinding()]
param(
  [string]$RecoveryKeyFile,
  [string]$KeyFile,
  [switch]$Force
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot "postgres-backup-crypto.ps1")

$target = Get-ArforgeBackupKeyPath $KeyFile
if ((Test-Path -LiteralPath $target -PathType Leaf) -and !$Force) {
  throw "A backup key already exists. Refusing to replace it without -Force."
}

$payloadText = if (![string]::IsNullOrWhiteSpace($RecoveryKeyFile)) {
  Get-Content -Raw -LiteralPath ([IO.Path]::GetFullPath($RecoveryKeyFile))
} else {
  Get-Clipboard -Raw
}
if ([string]::IsNullOrWhiteSpace($payloadText)) {
  throw "No recovery key payload was provided."
}

$payload = $payloadText | ConvertFrom-Json
if (
  $payload.format -ne "Arforge PostgreSQL backup recovery key" -or
  $payload.version -ne 1
) {
  throw "The recovery key payload format is not supported."
}
$masterKey = [Convert]::FromBase64String($payload.keyBase64)
if ($masterKey.Length -ne $script:ArforgeBackupKeyBytes) {
  [Array]::Clear($masterKey, 0, $masterKey.Length)
  throw "The recovery key has an unexpected length."
}

$partial = "$target.partial"
try {
  $protected = [Security.Cryptography.ProtectedData]::Protect(
    $masterKey,
    $script:ArforgeBackupEntropy,
    [Security.Cryptography.DataProtectionScope]::CurrentUser
  )
  New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
  [IO.File]::WriteAllBytes($partial, $protected)
  Move-Item -LiteralPath $partial -Destination $target -Force
  Write-Output "The Arforge PostgreSQL backup key was imported and protected for the current Windows user."
} finally {
  [Array]::Clear($masterKey, 0, $masterKey.Length)
  Remove-Item -LiteralPath $partial -Force -ErrorAction SilentlyContinue
}
