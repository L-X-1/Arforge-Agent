[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("app", "core", "runtime", "tui", "agent-python", "python")]
    [string]$Suite,
    [ValidatePattern("^\d+/\d+$")]
    [string]$Shard = "",
    [string]$ResultDirectory = ""
)

$ErrorActionPreference = "Stop"
if (-not [string]::IsNullOrWhiteSpace($Shard) -and $Suite -ne "runtime") {
    throw "-Shard is only supported for the runtime suite."
}
$root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
if ([string]::IsNullOrWhiteSpace($ResultDirectory)) {
    $ResultDirectory = Join-Path $root "artifacts\final-acceptance"
}
if (-not (Test-Path -LiteralPath $ResultDirectory -PathType Container)) {
    $null = New-Item -ItemType Directory -Path $ResultDirectory
}

$bun = Join-Path $root ".tools\bun-1.3.14\bun.exe"
$python = Join-Path $root ".venv\Scripts\python.exe"
$timestamp = [DateTime]::UtcNow.ToString("yyyyMMddTHHmmssZ")
$suiteLabel = if ([string]::IsNullOrWhiteSpace($Shard)) {
    $Suite
} else {
    "$Suite-shard-$($Shard.Replace('/', '-of-'))"
}
$stdout = Join-Path $ResultDirectory "$suiteLabel-$timestamp.stdout.log"
$stderr = Join-Path $ResultDirectory "$suiteLabel-$timestamp.stderr.log"
$resultPath = Join-Path $ResultDirectory "$suiteLabel-latest.json"

switch ($Suite) {
    "app" {
        $executable = $bun
        $arguments = @("test")
        $workingDirectory = Join-Path $root "packages\app"
    }
    "core" {
        $executable = $bun
        $arguments = @("test", "--timeout", "30000")
        $workingDirectory = Join-Path $root "packages\core"
    }
    "runtime" {
        $executable = $bun
        $arguments = @("test", "--timeout", "30000", "--only-failures")
        if (-not [string]::IsNullOrWhiteSpace($Shard)) {
            $arguments += "--shard=$Shard"
        }
        $workingDirectory = Join-Path $root "packages\arforge"
    }
    "tui" {
        $executable = $bun
        $arguments = @("test", "--timeout", "30000", "--only-failures")
        $workingDirectory = Join-Path $root "packages\tui"
    }
    "agent-python" {
        $executable = $bun
        $arguments = @("test")
        $workingDirectory = Join-Path $root "packages\agent-python"
    }
    "python" {
        $executable = $python
        $arguments = @("-m", "pytest", "-q", "tests")
        $workingDirectory = $root
    }
}

$started = [DateTime]::UtcNow
$process = Start-Process `
    -FilePath $executable `
    -ArgumentList $arguments `
    -WorkingDirectory $workingDirectory `
    -WindowStyle Hidden `
    -RedirectStandardOutput $stdout `
    -RedirectStandardError $stderr `
    -Wait `
    -PassThru
$rawExitCode = $process.ExitCode
if ($null -eq $rawExitCode) {
    throw "Acceptance suite '$Suite' completed without an observable process exit code."
}
$exitCode = [int]$rawExitCode
$finished = [DateTime]::UtcNow
$result = [ordered]@{
    schema_version = 1
    suite = $Suite
    shard = if ([string]::IsNullOrWhiteSpace($Shard)) { $null } else { $Shard }
    started_at = $started.ToString("o")
    finished_at = $finished.ToString("o")
    duration_seconds = [Math]::Round(($finished - $started).TotalSeconds, 3)
    exit_code = $exitCode
    stdout = $stdout
    stderr = $stderr
}
[IO.File]::WriteAllText(
    $resultPath,
    (($result | ConvertTo-Json -Depth 3) + "`n"),
    (New-Object System.Text.UTF8Encoding($false))
)
exit $exitCode
