[CmdletBinding()]
param(
    [switch]$SkipBuild,
    [switch]$AllowDirty
)

$ErrorActionPreference = "Stop"
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$desktopDist = Join-Path $projectRoot "packages\desktop\dist"
$installer = Join-Path $desktopDist "arforge-desktop-win-x64.exe"
$bundledBun = Join-Path $projectRoot ".tools\bun-1.3.14\bun.exe"
$bundledPython = Join-Path $projectRoot ".venv\Scripts\python.exe"
$previousLocation = Get-Location
$previousChannel = $env:ARFORGE_CHANNEL

try {
    Set-Location $projectRoot
    $dirty = @(git status --porcelain=v1)
    if ($dirty.Count -gt 0 -and -not $AllowDirty) {
        throw "Internal Alpha builds require a clean Git working tree. Commit the intended snapshot or use -AllowDirty only for a local rehearsal."
    }

    $bun = if (Test-Path -LiteralPath $bundledBun -PathType Leaf) {
        $bundledBun
    } else {
        (Get-Command bun -ErrorAction Stop).Source
    }
    $python = if (Test-Path -LiteralPath $bundledPython -PathType Leaf) {
        $bundledPython
    } else {
        (Get-Command python -ErrorAction Stop).Source
    }

    if (-not $SkipBuild) {
        $buildStartedAt = (Get-Date).ToUniversalTime()
        $env:ARFORGE_CHANNEL = "dev"
        & $bun run --cwd packages/desktop build
        if ($LASTEXITCODE -ne 0) { throw "Desktop build failed with exit code $LASTEXITCODE." }
        & $bun run --cwd packages/desktop package:win
        if ($LASTEXITCODE -ne 0) { throw "Windows installer packaging failed with exit code $LASTEXITCODE." }
        if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) {
            throw "Internal Alpha installer was not produced: $installer"
        }
        if ((Get-Item -LiteralPath $installer).LastWriteTimeUtc -lt $buildStartedAt) {
            throw "Installer was not refreshed by this build; refusing to reuse a stale artifact."
        }
    }

    if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) {
        throw "Internal Alpha installer was not produced: $installer"
    }
    $authenticode = Get-AuthenticodeSignature -LiteralPath $installer
    if ($authenticode.Status -ne "NotSigned") {
        throw "Internal Alpha must be explicitly unsigned, but Authenticode status is $($authenticode.Status)."
    }

    $createArgs = @(
        "scripts/desktop_alpha_artifacts.py",
        "--installer", $installer,
        "--output-dir", $desktopDist
    )
    if (-not $AllowDirty) { $createArgs += "--require-clean" }
    & $python @createArgs
    if ($LASTEXITCODE -ne 0) { throw "Internal Alpha evidence generation failed with exit code $LASTEXITCODE." }
    & $python scripts/desktop_alpha_artifacts.py --output-dir $desktopDist --verify
    if ($LASTEXITCODE -ne 0) { throw "Internal Alpha evidence verification failed with exit code $LASTEXITCODE." }

    Write-Host "Internal Alpha ready: $installer"
    Write-Host "Evidence: $(Join-Path $desktopDist 'internal-alpha-manifest.json')"
    if ($AllowDirty) {
        Write-Warning "This rehearsal was built from a dirty working tree and must not be distributed."
    }
}
finally {
    if ($null -eq $previousChannel) {
        Remove-Item Env:ARFORGE_CHANNEL -ErrorAction SilentlyContinue
    } else {
        $env:ARFORGE_CHANNEL = $previousChannel
    }
    Set-Location $previousLocation
}
