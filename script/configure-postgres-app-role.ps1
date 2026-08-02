[CmdletBinding()]
param(
  [string]$WorkspaceRoot = (Split-Path $PSScriptRoot -Parent),
  [string[]]$EnvironmentFiles,
  [string]$BunExecutable,
  [switch]$SkipUserEnvironment
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

if ($null -eq $EnvironmentFiles -or $EnvironmentFiles.Count -eq 0) {
  $EnvironmentFiles = @(
    (Join-Path $env:USERPROFILE ".arforge\.env"),
    (Join-Path $WorkspaceRoot ".env")
  )
}
if ([string]::IsNullOrWhiteSpace($BunExecutable)) {
  $BunExecutable = Join-Path $WorkspaceRoot ".tools\bun-1.3.14\bun.exe"
}
if (!(Test-Path -LiteralPath $BunExecutable -PathType Leaf)) {
  throw "The target-owned Bun executable was not found: $BunExecutable"
}

function Get-EnvironmentValue([string]$Path, [string]$Key) {
  if (!(Test-Path -LiteralPath $Path -PathType Leaf)) {
    return $null
  }
  foreach ($line in Get-Content -LiteralPath $Path) {
    if ($line -match "^\s*$([Regex]::Escape($Key))\s*=(.*)$") {
      $value = $Matches[1].Trim()
      if (
        $value.Length -ge 2 -and
        (($value.StartsWith('"') -and $value.EndsWith('"')) -or
         ($value.StartsWith("'") -and $value.EndsWith("'")))
      ) {
        return $value.Substring(1, $value.Length - 2)
      }
      return $value
    }
  }
  return $null
}

function Set-EnvironmentValue([string]$Path, [string]$Key, [string]$Value) {
  $directory = Split-Path $Path -Parent
  New-Item -ItemType Directory -Force -Path $directory | Out-Null
  $content = if (Test-Path -LiteralPath $Path -PathType Leaf) {
    [IO.File]::ReadAllText($Path)
  } else {
    ""
  }
  $line = "$Key=$Value"
  $pattern = "(?m)^\s*$([Regex]::Escape($Key))\s*=.*$"
  $next = if ([Regex]::IsMatch($content, $pattern)) {
    [Regex]::Replace($content, $pattern, $line)
  } elseif ([string]::IsNullOrEmpty($content)) {
    "$line$([Environment]::NewLine)"
  } else {
    "$($content.TrimEnd())$([Environment]::NewLine)$line$([Environment]::NewLine)"
  }

  $temporary = Join-Path $directory ".$([IO.Path]::GetFileName($Path)).$PID.tmp"
  try {
    [IO.File]::WriteAllText($temporary, $next, [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $temporary -Destination $Path -Force
  } finally {
    Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
  }
}

$adminUrl = $null
foreach ($path in $EnvironmentFiles) {
  $candidate = Get-EnvironmentValue $path "ARFORGE_DB_URL"
  if (![string]::IsNullOrWhiteSpace($candidate)) {
    $adminUrl = $candidate
    break
  }
}
if ([string]::IsNullOrWhiteSpace($adminUrl)) {
  throw "No ARFORGE_DB_URL was found in the selected private environment files."
}

$adminUri = [Uri]$adminUrl
$adminUser = [Uri]::UnescapeDataString($adminUri.UserInfo.Split(":", 2)[0])
if ($adminUser -eq "arforge_app") {
  throw "The configured URL already uses arforge_app. Supply an administrative URL temporarily before rotating the role."
}

$bytes = [byte[]]::new(48)
[Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
$appPassword = [Convert]::ToBase64String($bytes).TrimEnd("=").Replace("+", "-").Replace("/", "_")
$builder = [UriBuilder]::new($adminUri)
$builder.UserName = "arforge_app"
$builder.Password = $appPassword
$appUrl = $builder.Uri.AbsoluteUri

$previousAdmin = $env:ARFORGE_DB_ADMIN_URL
$previousAppPassword = $env:ARFORGE_DB_APP_PASSWORD
$previousDatabase = $env:ARFORGE_DB_URL
try {
  $env:ARFORGE_DB_ADMIN_URL = $adminUrl
  $env:ARFORGE_DB_APP_PASSWORD = $appPassword
  $provision = & $BunExecutable run packages/core/script/provision-postgres-role.ts
  if ($LASTEXITCODE -ne 0) {
    throw "PostgreSQL application role provisioning failed."
  }

  $env:ARFORGE_DB_URL = $appUrl
  $audit = & $BunExecutable run packages/core/script/audit-postgres-role.ts
  if ($LASTEXITCODE -ne 0) {
    throw "PostgreSQL least-privilege audit failed."
  }

  foreach ($path in $EnvironmentFiles) {
    Set-EnvironmentValue $path "ARFORGE_DB_URL" $appUrl
  }
  if (!$SkipUserEnvironment) {
    [Environment]::SetEnvironmentVariable("ARFORGE_DB_URL", $appUrl, "User")
  }

  [pscustomobject]@{
    Database = [Uri]::UnescapeDataString($builder.Path.TrimStart("/"))
    Role = "arforge_app"
    EnvironmentFiles = @($EnvironmentFiles)
    UserEnvironmentUpdated = !$SkipUserEnvironment
    Provision = $provision | ConvertFrom-Json
    Audit = $audit | ConvertFrom-Json
    SecretPrinted = $false
  } | ConvertTo-Json -Depth 8
} finally {
  if ($null -eq $previousAdmin) {
    Remove-Item Env:ARFORGE_DB_ADMIN_URL -ErrorAction SilentlyContinue
  } else {
    $env:ARFORGE_DB_ADMIN_URL = $previousAdmin
  }
  if ($null -eq $previousAppPassword) {
    Remove-Item Env:ARFORGE_DB_APP_PASSWORD -ErrorAction SilentlyContinue
  } else {
    $env:ARFORGE_DB_APP_PASSWORD = $previousAppPassword
  }
  if ($null -eq $previousDatabase) {
    Remove-Item Env:ARFORGE_DB_URL -ErrorAction SilentlyContinue
  } else {
    $env:ARFORGE_DB_URL = $previousDatabase
  }
  $appPassword = $null
  $appUrl = $null
}
