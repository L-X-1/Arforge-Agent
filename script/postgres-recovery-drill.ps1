[CmdletBinding()]
param(
  [string]$BackupFile,
  [string]$DatabaseUrl,
  [string]$AdminDatabaseUrl,
  [string]$BackupDirectory = (Join-Path $env:LOCALAPPDATA "Arforge\backups\postgresql"),
  [string]$ReportDirectory,
  [string]$KeyFile,
  [string]$PostgresBin = "C:\Program Files\PostgreSQL\17\bin"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot "postgres-backup-crypto.ps1")
if ([string]::IsNullOrWhiteSpace($ReportDirectory)) {
  $ReportDirectory = Join-Path $PSScriptRoot "..\artifacts\recovery-drills"
}

function Get-DatabaseConnection([string]$Value) {
  if ([string]::IsNullOrWhiteSpace($Value)) {
    throw "A PostgreSQL connection URL is required."
  }

  $uri = [Uri]$Value
  if ($uri.Scheme -notin @("postgres", "postgresql")) {
    throw "The database URL must use the postgres or postgresql scheme."
  }

  $userInfo = $uri.UserInfo.Split(":", 2)
  if ($userInfo.Count -ne 2) {
    throw "The database URL must include a username and password."
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
    return @($output)
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

function Get-TableCounts([string]$Psql, [object]$Connection) {
  $baseArguments = @(
    "--host", $Connection.Host,
    "--port", "$($Connection.Port)",
    "--username", $Connection.Username,
    "--dbname", $Connection.Database,
    "--no-psqlrc",
    "--tuples-only",
    "--no-align",
    "--set", "ON_ERROR_STOP=1"
  )
  $tables = Invoke-PostgresTool $Psql $Connection ($baseArguments + @(
    "--command",
    "SELECT table_schema || '.' || table_name FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema') AND table_type='BASE TABLE' ORDER BY 1;"
  ))

  $counts = [ordered]@{}
  foreach ($table in $tables) {
    $name = "$table".Trim()
    if ([string]::IsNullOrWhiteSpace($name)) {
      continue
    }
    $parts = $name.Split(".", 2)
    $schema = $parts[0].Replace('"', '""')
    $relation = $parts[1].Replace('"', '""')
    $count = Invoke-PostgresTool $Psql $Connection ($baseArguments + @(
      "--command",
      "SELECT count(*) FROM `"$schema`".`"$relation`";"
    ))
    $counts[$name] = [long]("$($count[0])".Trim())
  }
  return $counts
}

$appUrl = if ([string]::IsNullOrWhiteSpace($DatabaseUrl)) {
  [Environment]::GetEnvironmentVariable("ARFORGE_DB_URL", "User")
} else {
  $DatabaseUrl
}
$adminUrl = if (![string]::IsNullOrWhiteSpace($AdminDatabaseUrl)) {
  $AdminDatabaseUrl
} elseif (![string]::IsNullOrWhiteSpace($env:ARFORGE_DB_ADMIN_URL)) {
  $env:ARFORGE_DB_ADMIN_URL
} else {
  $env:ARFORGE_DB_URL
}
$app = Get-DatabaseConnection $appUrl
$admin = Get-DatabaseConnection $adminUrl
if ($admin.Username -eq $app.Username) {
  throw "The recovery drill requires a separate PostgreSQL maintenance role that can create and drop a temporary database."
}

$pgRestore = Join-Path $PostgresBin "pg_restore.exe"
$psql = Join-Path $PostgresBin "psql.exe"
$createDb = Join-Path $PostgresBin "createdb.exe"
$dropDb = Join-Path $PostgresBin "dropdb.exe"
@($pgRestore, $psql, $createDb, $dropDb) | ForEach-Object {
  if (!(Test-Path -LiteralPath $_ -PathType Leaf)) {
    throw "Required PostgreSQL tool was not found: $_"
  }
}

$selectedBackup = if (![string]::IsNullOrWhiteSpace($BackupFile)) {
  [IO.Path]::GetFullPath($BackupFile)
} else {
  $latest = Get-ChildItem -LiteralPath ([IO.Path]::GetFullPath($BackupDirectory)) -Filter "arforge-*.dump.enc" -File |
    Sort-Object LastWriteTimeUtc -Descending |
    Select-Object -First 1
  if ($null -eq $latest) {
    throw "No Arforge PostgreSQL backup was found."
  }
  $latest.FullName
}
if (!(Test-Path -LiteralPath $selectedBackup -PathType Leaf)) {
  throw "Backup file does not exist: $selectedBackup"
}

$manifestPath = $selectedBackup -replace "\.dump\.enc$", ".manifest.json"
if (!(Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
  throw "Backup manifest is missing: $manifestPath"
}
$manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
$actualHash = Get-Sha256 $selectedBackup
if ($manifest.formatVersion -ne 2 -or $actualHash -ne $manifest.encrypted.sha256) {
  throw "Backup checksum does not match its manifest."
}
if (
  $manifest.encryption.algorithm -ne "AES-256-CBC" -or
  $manifest.encryption.authentication -ne "HMAC-SHA256" -or
  $manifest.encryption.hmacScope -ne "IV || ciphertext"
) {
  throw "The backup manifest declares an unsupported encryption format."
}
$temporaryDump = Join-Path ([IO.Path]::GetTempPath()) "arforge-restore-$([Guid]::NewGuid().ToString('N')).dump"
try {
  Unprotect-ArforgeBackup `
    $selectedBackup `
    $temporaryDump `
    $manifest.encryption.ivBase64 `
    $manifest.encryption.hmacSha256 `
    $KeyFile
  $plainHash = Get-Sha256 $temporaryDump
  if ($plainHash -ne $manifest.plaintext.sha256) {
    throw "Decrypted backup checksum does not match its manifest."
  }
  $null = Invoke-PostgresTool $pgRestore $app @("--list", $temporaryDump)

  $drillName = "arforge_restore_drill_$((Get-Date).ToUniversalTime().ToString('yyyyMMddHHmmss'))_$PID"
  $drill = [pscustomobject]@{
    Host = $app.Host
    Port = $app.Port
    Database = $drillName
    Username = $app.Username
    Password = $app.Password
  }
  $created = $false
  $started = Get-Date

  try {
    $null = Invoke-PostgresTool $createDb $admin @(
    "--host", $admin.Host,
    "--port", "$($admin.Port)",
    "--username", $admin.Username,
    "--maintenance-db", $admin.Database,
    "--owner", $app.Username,
    $drillName
  )
  $created = $true
  $null = Invoke-PostgresTool $pgRestore $drill @(
    "--host", $drill.Host,
    "--port", "$($drill.Port)",
    "--username", $drill.Username,
    "--dbname", $drill.Database,
    "--no-owner",
    "--no-privileges",
    "--exit-on-error",
    $temporaryDump
  )

  $productionCounts = Get-TableCounts $psql $app
  $restoredCounts = Get-TableCounts $psql $drill
  $allTables = @($productionCounts.Keys + $restoredCounts.Keys | Sort-Object -Unique)
  $mismatches = @(
    $allTables | ForEach-Object {
      $production = if ($productionCounts.Contains($_)) { $productionCounts[$_] } else { $null }
      $restored = if ($restoredCounts.Contains($_)) { $restoredCounts[$_] } else { $null }
      if ($production -ne $restored) {
        [ordered]@{ table = $_; production = $production; restored = $restored }
      }
    }
  )

  $reportRoot = [IO.Path]::GetFullPath($ReportDirectory)
  New-Item -ItemType Directory -Path $reportRoot -Force | Out-Null
  $reportPath = Join-Path $reportRoot "postgres-recovery-$((Get-Date).ToUniversalTime().ToString('yyyyMMdd-HHmmss')).json"
  $report = [ordered]@{
    formatVersion = 1
    product = "Arforge"
    startedAtUtc = $started.ToUniversalTime().ToString("o")
    completedAtUtc = (Get-Date).ToUniversalTime().ToString("o")
    sourceDatabase = $app.Database
    temporaryDatabase = $drillName
    backupFile = [IO.Path]::GetFileName($selectedBackup)
    encryptedBackupSha256 = $actualHash
    plaintextBackupSha256 = $plainHash
    encryption = $manifest.encryption.algorithm
    authentication = $manifest.encryption.authentication
    checksumVerified = $true
    authenticationVerified = $true
    restoreListVerified = $true
    tableCount = $allTables.Count
    productionRows = [long](($productionCounts.Values | Measure-Object -Sum).Sum)
    restoredRows = [long](($restoredCounts.Values | Measure-Object -Sum).Sum)
    mismatchCount = $mismatches.Count
    mismatches = $mismatches
    passed = $mismatches.Count -eq 0
  }
  $report | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $reportPath -Encoding utf8
  $report + [ordered]@{ report = $reportPath } | ConvertTo-Json -Depth 6

  if ($mismatches.Count -ne 0) {
    throw "Recovery drill found $($mismatches.Count) table count mismatch(es). See $reportPath."
  }
  } finally {
    if ($created) {
      $null = Invoke-PostgresTool $dropDb $admin @(
      "--host", $admin.Host,
      "--port", "$($admin.Port)",
      "--username", $admin.Username,
      "--maintenance-db", $admin.Database,
      "--if-exists",
      "--force",
      $drillName
      )
    }
  }
} finally {
  Remove-Item -LiteralPath $temporaryDump -Force -ErrorAction SilentlyContinue
}
