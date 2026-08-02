[CmdletBinding()]
param(
    [switch]$Execute
)

$ErrorActionPreference = "Stop"
if (-not $Execute) {
    throw "Tier 2 retirement is destructive. Re-run with -Execute only after the approved plan passes."
}

$root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$planPath = Join-Path $root "specs\tier2-deletion-plan.json"
$plan = Get-Content -LiteralPath $planPath -Raw -Encoding UTF8 | ConvertFrom-Json
if (
    $plan.authorization.tier2Approved -ne $true -or
    $plan.authorization.approvedOption -ne "B" -or
    $plan.status -ne "approved-waiting-database-preconditions"
) {
    throw "Tier 2 option B is not in the exact approved pre-execution state."
}

$targets = @($plan.options.A.delete) + @($plan.options.B.additionalDelete)
$rootPrefix = $root.TrimEnd("\") + "\"
$validated = @()
foreach ($target in $targets) {
    $absolute = [IO.Path]::GetFullPath((Join-Path $root ([string]$target.path)))
    if (-not $absolute.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Deletion target escapes the workspace: $($target.path)"
    }
    if (-not (Test-Path -LiteralPath $absolute)) {
        throw "Approved deletion target is missing: $($target.path)"
    }
    $item = Get-Item -LiteralPath $absolute -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Deletion target is a reparse point: $($target.path)"
    }
    if ($item.PSIsContainer) {
        $nestedLink = Get-ChildItem -LiteralPath $absolute -Recurse -Force -ErrorAction Stop |
            Where-Object { ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 } |
            Select-Object -First 1
        if ($nestedLink) {
            throw "Deletion target contains a reparse point: $($nestedLink.FullName)"
        }
    }
    $validated += [pscustomobject]@{
        RelativePath = [string]$target.path
        AbsolutePath = $absolute
        IsDirectory = [bool]$item.PSIsContainer
    }
}

$running = @(Get-CimInstance Win32_Process | Where-Object {
    $_.ExecutablePath -and
    $_.ExecutablePath.StartsWith((Join-Path $root "desktop"), [StringComparison]::OrdinalIgnoreCase)
})
if ($running.Count -gt 0) {
    throw "A process is running from the retired desktop tree: $($running.ProcessId -join ', ')"
}

$manifestTargets = @()
foreach ($target in $validated) {
    if ($target.IsDirectory) {
        $files = @(Get-ChildItem -LiteralPath $target.AbsolutePath -Recurse -File -Force | Sort-Object FullName)
    } else {
        $files = @(Get-Item -LiteralPath $target.AbsolutePath -Force)
    }
    $entries = @()
    [int64]$bytes = 0
    foreach ($file in $files) {
        $bytes += $file.Length
        $relative = [IO.Path]::GetRelativePath($root, $file.FullName).Replace("\", "/")
        $entries += [ordered]@{
            path = $relative
            bytes = [int64]$file.Length
            sha256 = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        }
    }
    $manifestTargets += [ordered]@{
        path = $target.RelativePath.Replace("\", "/")
        type = if ($target.IsDirectory) { "directory" } else { "file" }
        bytes = $bytes
        file_count = $entries.Count
        files = $entries
    }
}

$artifactDirectory = Join-Path $root "artifacts\tier2-retirement"
if (-not (Test-Path -LiteralPath $artifactDirectory -PathType Container)) {
    $null = New-Item -ItemType Directory -Path $artifactDirectory
}
$timestamp = [DateTime]::UtcNow.ToString("yyyyMMddTHHmmssZ")
$manifestPath = Join-Path $artifactDirectory "pre-delete-manifest-$timestamp.json"
$manifest = [ordered]@{
    schema_version = 1
    created_at = $timestamp
    workspace = $root
    approved_option = "B"
    recovery = "Windows Recycle Bin"
    target_count = $manifestTargets.Count
    targets = $manifestTargets
}
[IO.File]::WriteAllText(
    $manifestPath,
    (($manifest | ConvertTo-Json -Depth 8) + "`n"),
    (New-Object System.Text.UTF8Encoding($false))
)

Add-Type -AssemblyName Microsoft.VisualBasic
foreach ($target in $validated) {
    if ($target.IsDirectory) {
        [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory(
            $target.AbsolutePath,
            [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs,
            [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin
        )
    } else {
        [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile(
            $target.AbsolutePath,
            [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs,
            [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin
        )
    }
    if (Test-Path -LiteralPath $target.AbsolutePath) {
        throw "Approved target remains after Recycle Bin move: $($target.RelativePath)"
    }
}

[pscustomobject]@{
    approved_option = "B"
    targets_recycled = $validated.Count
    manifest = $manifestPath
    permanently_deleted = $false
} | ConvertTo-Json
