[CmdletBinding()]
param(
  [string]$PrivateEnvPath = (Join-Path $env:USERPROFILE ".arforge\.env")
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$root = (Resolve-Path -LiteralPath (Split-Path $PSScriptRoot -Parent)).Path
$bun = Join-Path $root ".tools\bun-1.3.14\bun.exe"
$core = Join-Path $root "packages\core"
if (!(Test-Path -LiteralPath $bun -PathType Leaf)) {
  throw "Target-owned Bun runtime was not found: $bun"
}

$adminUrl = [Environment]::GetEnvironmentVariable("ARFORGE_DB_ADMIN_URL", "Process")
if ([string]::IsNullOrWhiteSpace($adminUrl)) {
  $adminUrl = [Environment]::GetEnvironmentVariable("ARFORGE_DB_URL", "Process")
}
if ([string]::IsNullOrWhiteSpace($adminUrl) -and (Test-Path -LiteralPath $PrivateEnvPath -PathType Leaf)) {
  $line = Get-Content -LiteralPath $PrivateEnvPath |
    Where-Object { $_ -match '^\s*ARFORGE_DB_URL\s*=' } |
    Select-Object -Last 1
  if ($line) {
    $adminUrl = ($line -split '=', 2)[1].Trim()
  }
}
if ([string]::IsNullOrWhiteSpace($adminUrl)) {
  throw "An administrative PostgreSQL URL is required in ARFORGE_DB_ADMIN_URL or ARFORGE_DB_URL."
}

$adminUri = [Uri]$adminUrl
$database = $adminUri.AbsolutePath.TrimStart("/")
if ([string]::IsNullOrWhiteSpace($database)) {
  throw "The PostgreSQL URL must include a database name."
}

$secretBytes = New-Object byte[] 48
$random = [Security.Cryptography.RandomNumberGenerator]::Create()
try {
  $random.GetBytes($secretBytes)
}
finally {
  $random.Dispose()
}
$appPassword = [Convert]::ToBase64String($secretBytes).TrimEnd("=").Replace("+", "-").Replace("/", "_")
$appUser = "arforge_app"
$encodedUser = [Uri]::EscapeDataString($appUser)
$encodedPassword = [Uri]::EscapeDataString($appPassword)
$port = if ($adminUri.IsDefaultPort) { "" } else { ":$($adminUri.Port)" }
$appUrl = "$($adminUri.Scheme)://${encodedUser}:${encodedPassword}@$($adminUri.Host)$port$($adminUri.PathAndQuery)"

$previousAdmin = $env:ARFORGE_DB_ADMIN_URL
$previousUrl = $env:ARFORGE_DB_URL
$previousPassword = $env:ARFORGE_DB_APP_PASSWORD
try {
  $env:ARFORGE_DB_ADMIN_URL = $adminUrl
  $env:ARFORGE_DB_APP_PASSWORD = $appPassword
  & $bun (Join-Path $core "script\provision-postgres-role.ts")
  if ($LASTEXITCODE -ne 0) {
    throw "PostgreSQL application-role provisioning failed."
  }

  $env:ARFORGE_DB_URL = $appUrl
  & $bun (Join-Path $core "script\audit-postgres-role.ts")
  if ($LASTEXITCODE -ne 0) {
    throw "PostgreSQL application-role audit failed."
  }
}
finally {
  $env:ARFORGE_DB_ADMIN_URL = $previousAdmin
  $env:ARFORGE_DB_URL = $previousUrl
  $env:ARFORGE_DB_APP_PASSWORD = $previousPassword
}

$parent = Split-Path $PrivateEnvPath -Parent
New-Item -ItemType Directory -Path $parent -Force | Out-Null
$lines = if (Test-Path -LiteralPath $PrivateEnvPath -PathType Leaf) {
  @(Get-Content -LiteralPath $PrivateEnvPath)
} else {
  @()
}
$updated = $false
$next = foreach ($line in $lines) {
  if ($line -match '^\s*ARFORGE_DB_URL\s*=') {
    if (!$updated) {
      "ARFORGE_DB_URL=$appUrl"
      $updated = $true
    }
    continue
  }
  $line
}
if (!$updated) {
  $next += "ARFORGE_DB_URL=$appUrl"
}

$temporary = "$PrivateEnvPath.$([Guid]::NewGuid().ToString('N')).tmp"
try {
  [IO.File]::WriteAllLines($temporary, $next, [Text.UTF8Encoding]::new($false))
  Move-Item -LiteralPath $temporary -Destination $PrivateEnvPath -Force
}
finally {
  if (Test-Path -LiteralPath $temporary) {
    Remove-Item -LiteralPath $temporary -Force
  }
}

Write-Output "Private PostgreSQL application role configured: database=$database role=$appUser"
