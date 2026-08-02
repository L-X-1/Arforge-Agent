[CmdletBinding()]
param(
  [string]$TaskName = "Arforge PostgreSQL Backup",
  [string]$At = "02:00",
  [ValidateRange(1, 3650)]
  [int]$RetentionDays = 30
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$backupScript = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "postgres-backup.ps1"))
if (!(Test-Path -LiteralPath $backupScript -PathType Leaf)) {
  throw "Backup script does not exist: $backupScript"
}
if ([string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable("ARFORGE_DB_URL", "User"))) {
  throw "The current Windows user does not have ARFORGE_DB_URL configured."
}

$time = [DateTime]::ParseExact($At, "HH:mm", [Globalization.CultureInfo]::InvariantCulture)
$powerShell = (Get-Command powershell.exe).Source
$action = New-ScheduledTaskAction -Execute $powerShell -Argument (
  "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$backupScript`" -RetentionDays $RetentionDays"
)
$trigger = New-ScheduledTaskTrigger -Daily -At $time
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -ExecutionTimeLimit (New-TimeSpan -Hours 2)
$principal = New-ScheduledTaskPrincipal `
  -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) `
  -LogonType Interactive `
  -RunLevel Limited

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Principal $principal `
  -Description "Creates and verifies an encrypted-at-rest Arforge PostgreSQL custom-format backup using the current user's database configuration." `
  -Force | Out-Null

Get-ScheduledTask -TaskName $TaskName |
  Select-Object TaskName, State, @{Name = "NextRunTime"; Expression = { (Get-ScheduledTaskInfo $_).NextRunTime } } |
  ConvertTo-Json -Depth 3
