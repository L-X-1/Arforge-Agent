[CmdletBinding()]
param(
  [string]$DatabaseUrl,
  [string]$BackupDirectory = (Join-Path $env:LOCALAPPDATA "Arforge\backups\postgresql"),
  [ValidateRange(1, 3650)]
  [int]$RetentionDays = 30,
  [string]$KeyFile,
  [string]$PostgresBin = "C:\Program Files\PostgreSQL\17\bin"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot "postgres-backup-crypto.ps1")

function Get-DatabaseConnection([string]$Value) {
  if ([string]::IsNullOrWhiteSpace($Value)) {
    throw "ARFORGE_DB_URL is not configured."
  }

  $uri = [Uri]$Value
  if ($uri.Scheme -notin @("postgres", "postgresql")) {
    throw "ARFORGE_DB_URL must use the postgres or postgresql scheme."
  }

  $userInfo = $uri.UserInfo.Split(":", 2)
  if ($userInfo.Count -ne 2) {
    throw "ARFORGE_DB_URL must include a username and password."
  }

  [pscustomobject]@{
    Host = $uri.Host
    Port = if ($uri.IsDefaultPort) { 5432 } else { $uri.Port }
    Database = [Uri]::UnescapeDataString($uri.AbsolutePath.TrimStart("/"))
    Username = [Uri]::UnescapeDataString($userInfo[0])
    Password = [Uri]::UnescapeDataString($userInfo[1])
  }
}

function Invoke-PostgresTool(
  [string]$Executable,
  [object]$Connection,
  [string[]]$Arguments
) {
  $previous = $env:PGPASSWORD
  try {
    $env:PGPASSWORD = $Connection.Password
    $output = & $Executable @Arguments 2>&1
    if ($LASTEXITCODE -ne 0) {
      throw "$([IO.Path]::GetFileName($Executable)) failed: $($output -join [Environment]::NewLine)"
    }
    return $output
  } finally {
    if ($null -eq $previous) {
      Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue
    } else {
      $env:PGPASSWORD = $previous
    }
  }
}

function Get-Sha256([string]$Path) {
  $stream = [IO.File]::OpenRead($Path)
  try {
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try {
      return ([BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace("-", "")
    } finally {
      $algorithm.Dispose()
    }
  } finally {
    $stream.Dispose()
  }
}

$configuredUrl = if ([string]::IsNullOrWhiteSpace($DatabaseUrl)) {
  $processUrl = [Environment]::GetEnvironmentVariable("ARFORGE_DB_URL", "Process")
  if ([string]::IsNullOrWhiteSpace($processUrl)) {
    [Environment]::GetEnvironmentVariable("ARFORGE_DB_URL", "User")
  } else {
    $processUrl
  }
} else {
  $DatabaseUrl
}
$connection = Get-DatabaseConnection $configuredUrl
$backupRoot = [IO.Path]::GetFullPath($BackupDirectory)
$rootOnly = [IO.Path]::GetPathRoot($backupRoot).TrimEnd("\", "/")
if ($backupRoot.TrimEnd("\", "/") -eq $rootOnly) {
  throw "The backup directory cannot be a filesystem root."
}

$pgDump = Join-Path $PostgresBin "pg_dump.exe"
$pgRestore = Join-Path $PostgresBin "pg_restore.exe"
if (!(Test-Path -LiteralPath $pgDump -PathType Leaf) -or !(Test-Path -LiteralPath $pgRestore -PathType Leaf)) {
  throw "PostgreSQL backup tools were not found in $PostgresBin."
}

New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null
$timestamp = (Get-Date).ToUniversalTime().ToString("yyyyMMdd-HHmmss")
$stem = "arforge-$timestamp"
$plainDump = Join-Path $backupRoot "$stem.dump.partial"
$encryptedPartial = Join-Path $backupRoot "$stem.dump.enc.partial"
$encryptedDump = Join-Path $backupRoot "$stem.dump.enc"
$manifestPath = Join-Path $backupRoot "$stem.manifest.json"
$checksumPath = Join-Path $backupRoot "$stem.sha256"

try {
  $null = Invoke-PostgresTool $pgDump $connection @(
    "--host", $connection.Host,
    "--port", "$($connection.Port)",
    "--username", $connection.Username,
    "--dbname", $connection.Database,
    "--format", "custom",
    "--compress", "9",
    "--no-owner",
    "--no-privileges",
    "--file", $plainDump
  )
  $null = Invoke-PostgresTool $pgRestore $connection @("--list", $plainDump)

  $plainHash = Get-Sha256 $plainDump
  $plainBytes = (Get-Item -LiteralPath $plainDump).Length
  $encryption = Protect-ArforgeBackup $plainDump $encryptedPartial $KeyFile
  Move-Item -LiteralPath $encryptedPartial -Destination $encryptedDump
  $encryptedHash = Get-Sha256 $encryptedDump
  $toolVersion = (& $pgDump --version).Trim()
  $manifest = [ordered]@{
    formatVersion = 2
    product = "Arforge"
    createdAtUtc = (Get-Date).ToUniversalTime().ToString("o")
    database = $connection.Database
    host = $connection.Host
    port = $connection.Port
    backupRole = $connection.Username
    backupFile = [IO.Path]::GetFileName($encryptedDump)
    encrypted = [ordered]@{
      bytes = (Get-Item -LiteralPath $encryptedDump).Length
      sha256 = $encryptedHash
    }
    plaintext = [ordered]@{
      format = "PostgreSQL custom"
      bytes = $plainBytes
      sha256 = $plainHash
    }
    encryption = [ordered]@{
      algorithm = "AES-256-CBC"
      authentication = "HMAC-SHA256"
      hmacScope = "IV || ciphertext"
      ivBase64 = $encryption.IvBase64
      hmacSha256 = $encryption.HmacSha256
      keyProtection = "Windows DPAPI CurrentUser"
      keyFile = [IO.Path]::GetFileName((Get-ArforgeBackupKeyPath $KeyFile))
    }
    tool = $toolVersion
    retentionDays = $RetentionDays
    restoreListVerified = $true
  }
  $manifest | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $manifestPath -Encoding utf8
  "$encryptedHash  $([IO.Path]::GetFileName($encryptedDump))" | Set-Content -LiteralPath $checksumPath -Encoding ascii

  $cutoff = (Get-Date).ToUniversalTime().AddDays(-$RetentionDays)
  Get-ChildItem -LiteralPath $backupRoot -File |
    Where-Object {
      $_.LastWriteTimeUtc -lt $cutoff -and
      ($_.Name -match "^arforge-\d{8}-\d{6}\.(dump\.enc|manifest\.json|sha256)$")
    } |
    ForEach-Object { Remove-Item -LiteralPath $_.FullName -Force }

  [pscustomobject]@{
    Backup = $encryptedDump
    Manifest = $manifestPath
    Sha256 = $encryptedHash
    Bytes = $manifest.encrypted.bytes
    Encryption = $manifest.encryption.algorithm
    Authentication = $manifest.encryption.authentication
    RestoreListVerified = $true
  } | ConvertTo-Json -Depth 3
} catch {
  Remove-Item -LiteralPath $encryptedDump -Force -ErrorAction SilentlyContinue
  throw
} finally {
  Remove-Item -LiteralPath $plainDump -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $encryptedPartial -Force -ErrorAction SilentlyContinue
}
