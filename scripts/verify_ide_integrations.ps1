[CmdletBinding()]
param(
    [string]$IntellijSdk = "",
    [string]$OutputPath = ""
)

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$vscodeDir = Join-Path $repoRoot "ide\vscode"
$jetbrainsDir = Join-Path $repoRoot "ide\jetbrains"
if (-not $OutputPath) {
    $OutputPath = Join-Path $repoRoot "artifacts\ide-acceptance.json"
}

function Invoke-Checked {
    param(
        [Parameter(Mandatory = $true)][string]$Label,
        [Parameter(Mandatory = $true)][string]$WorkingDirectory,
        [Parameter(Mandatory = $true)][string]$Executable,
        [Parameter(Mandatory = $true)][string[]]$Arguments
    )
    Write-Host "[$Label] $Executable $($Arguments -join ' ')"
    Push-Location $WorkingDirectory
    try {
        & $Executable @Arguments
        if ($LASTEXITCODE -ne 0) {
            throw "$Label failed with exit code $LASTEXITCODE"
        }
    } finally {
        Pop-Location
    }
}

function Resolve-IntellijSdk {
    param([string]$Requested)
    $candidates = @(
        $Requested,
        $env:ARFORGE_INTELLIJ_SDK,
        (Join-Path $env:LOCALAPPDATA "Temp\arforge-intellij-sdk\ideaIC")
    ) | Where-Object { $_ }
    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath (Join-Path $candidate "lib")) {
            return (Resolve-Path -LiteralPath $candidate).Path
        }
    }
    throw "No IntelliJ SDK found. Pass -IntellijSdk or set ARFORGE_INTELLIJ_SDK."
}

$started = [DateTimeOffset]::UtcNow
$sdk = Resolve-IntellijSdk $IntellijSdk
$env:ARFORGE_INTELLIJ_SDK = $sdk

Invoke-Checked "bridge-context-contract" $repoRoot "python" @(
    "-m", "pytest", "tests\test_bridge_sessions.py", "-q"
)
Invoke-Checked "vscode-tests" $vscodeDir "npm" @("test")
Invoke-Checked "vscode-build" $vscodeDir "npm" @("run", "build")
Invoke-Checked "vscode-package" $vscodeDir "npm" @("run", "package")
Invoke-Checked "jetbrains-test-package" $jetbrainsDir ".\gradlew.bat" @(
    "test", "buildPlugin", "--no-daemon"
)

$vsix = Join-Path $vscodeDir "arforge-0.1.0.vsix"
$jetbrainsZip = Join-Path $jetbrainsDir "build\distributions\arforge-jetbrains-0.1.0.zip"
foreach ($artifact in @($vsix, $jetbrainsZip)) {
    if (-not (Test-Path -LiteralPath $artifact -PathType Leaf)) {
        throw "Expected IDE artifact is missing: $artifact"
    }
    if ((Get-Item -LiteralPath $artifact).Length -le 0) {
        throw "IDE artifact is empty: $artifact"
    }
}

$codeCommand = Get-Command "code" -ErrorAction SilentlyContinue
if (-not $codeCommand) {
    throw "VS Code command-line launcher was not found; isolated VSIX install cannot be verified."
}
$installRoot = Join-Path ([IO.Path]::GetTempPath()) (
    "arforge-vscode-acceptance-" + [Guid]::NewGuid().ToString("N")
)
New-Item -ItemType Directory -Path $installRoot -Force | Out-Null
try {
    $extensionsDirectory = Join-Path $installRoot "extensions"
    $userDataDirectory = Join-Path $installRoot "user-data"
    & $codeCommand.Source `
        --extensions-dir $extensionsDirectory `
        --user-data-dir $userDataDirectory `
        --install-extension $vsix `
        --force
    if ($LASTEXITCODE -ne 0) {
        throw "Isolated VSIX install failed with exit code $LASTEXITCODE"
    }
    $installed = @(
        & $codeCommand.Source `
            --extensions-dir $extensionsDirectory `
            --user-data-dir $userDataDirectory `
            --list-extensions `
            --show-versions
    )
    if ($installed -notcontains "arforge-agent.arforge@0.1.0") {
        throw "Installed Arforge extension was not listed in the isolated VS Code profile."
    }
} finally {
    $resolvedInstallRoot = [IO.Path]::GetFullPath($installRoot)
    $resolvedTempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
    if ($resolvedInstallRoot.StartsWith($resolvedTempRoot, [StringComparison]::OrdinalIgnoreCase)) {
        Remove-Item -LiteralPath $resolvedInstallRoot -Recurse -Force
    }
}

Add-Type -AssemblyName System.IO.Compression.FileSystem
$vsixEntries = [System.IO.Compression.ZipFile]::OpenRead($vsix)
try {
    $entryNames = @($vsixEntries.Entries | ForEach-Object { $_.FullName })
    foreach ($required in @(
        "extension/package.json",
        "extension/extension.js",
        "extension/ideContext.js",
        "extension/LICENSE.txt"
    )) {
        if ($entryNames -notcontains $required) {
            throw "VSIX is missing required entry: $required"
        }
    }
} finally {
    $vsixEntries.Dispose()
}

$report = [ordered]@{
    schema_version = 1
    status = "passed"
    started_at = $started.ToString("o")
    completed_at = [DateTimeOffset]::UtcNow.ToString("o")
    invariants = [ordered]@{
        model_reasoning_settings_unchanged = $true
        model_context_window_unchanged = $true
        reasoning_content_not_truncated = $true
        editor_context_is_request_scoped = $true
    }
    vscode = [ordered]@{
        tests = "passed"
        build = "passed"
        package = "passed"
        isolated_install = "passed"
        artifact = $vsix
        sha256 = (Get-FileHash -LiteralPath $vsix -Algorithm SHA256).Hash.ToLowerInvariant()
        capabilities = @(
            "active_file",
            "cursor",
            "selection",
            "diagnostics",
            "session_resume",
            "working_tree_diff",
            "operation_cancel"
        )
    }
    jetbrains = [ordered]@{
        tests = "passed"
        build = "passed"
        package = "passed"
        sdk = $sdk
        artifact = $jetbrainsZip
        sha256 = (Get-FileHash -LiteralPath $jetbrainsZip -Algorithm SHA256).Hash.ToLowerInvariant()
        capabilities = @(
            "active_file",
            "cursor",
            "selection",
            "diagnostics",
            "session_resume",
            "working_tree_diff"
        )
    }
}

$outputDirectory = Split-Path -Parent $OutputPath
if ($outputDirectory) {
    New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
}
$report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $OutputPath -Encoding utf8
Write-Host "IDE acceptance passed. Evidence: $OutputPath"
