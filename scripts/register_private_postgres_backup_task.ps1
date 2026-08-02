param(
    [string]$DailyAt = "03:00",
    [string]$BackupDirectory = (Join-Path $env:USERPROFILE "ArforgeBackups\PostgreSQL"),
    [ValidateRange(1, 3650)]
    [int]$RetentionDays = 30,
    [string]$TaskName = "Arforge Private PostgreSQL Backup"
)

$ErrorActionPreference = "Stop"
$root = (Resolve-Path -LiteralPath (Split-Path $PSScriptRoot -Parent)).Path
$python = Join-Path $root ".venv\Scripts\python.exe"
$script = Join-Path $root "scripts\postgres_private_backup.py"
$privateEnv = Join-Path $env:USERPROFILE ".arforge\.env"

foreach ($file in @($python, $script, $privateEnv)) {
    if (!(Test-Path -LiteralPath $file -PathType Leaf)) {
        throw "Required file not found: $file"
    }
}

$time = [DateTime]::ParseExact($DailyAt, "HH:mm", [Globalization.CultureInfo]::InvariantCulture)
$arguments = @(
    "`"$script`"",
    "--private-env", "`"$privateEnv`"",
    "--destination", "`"$BackupDirectory`"",
    "--retention-days", "$RetentionDays",
    "--prune"
) -join " "

$action = New-ScheduledTaskAction -Execute $python -Argument $arguments -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -Daily -At $time
$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Hours 2)

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Description "Verified Arforge PostgreSQL backup with retention pruning." `
    -Force | Out-Null

Write-Output "Scheduled task registered: $TaskName at $DailyAt"
Write-Output "Backup directory: $BackupDirectory"
