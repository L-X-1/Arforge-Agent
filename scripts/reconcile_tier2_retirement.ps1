[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$TargetPath,
    [switch]$Execute
)

$ErrorActionPreference = "Stop"

$root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$planPath = Join-Path $root "specs\tier2-deletion-plan.json"
$plan = Get-Content -LiteralPath $planPath -Raw -Encoding UTF8 | ConvertFrom-Json

if (
    $plan.authorization.tier2Approved -ne $true -or
    $plan.authorization.approvedOption -ne "B" -or
    $plan.status -ne "executed-recoverable"
) {
    throw "Tier 2 reconciliation requires the already executed, recoverable option B plan."
}
if ($plan.executionResult.permanentlyDeleted -ne $false) {
    throw "Tier 2 reconciliation refuses a plan that records permanent deletion."
}

function Normalize-RelativePath([string]$value) {
    return $value.Replace("\", "/").TrimStart("./").TrimEnd("/")
}

function Resolve-SafeTarget([string]$relativePath) {
    if ([IO.Path]::IsPathRooted($relativePath)) {
        throw "TargetPath must be workspace-relative: $relativePath"
    }
    $absolute = [IO.Path]::GetFullPath((Join-Path $root $relativePath))
    $rootPrefix = $root.TrimEnd("\") + "\"
    if (-not $absolute.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "TargetPath escapes the workspace: $relativePath"
    }
    return $absolute
}

$requested = Normalize-RelativePath $TargetPath
$approvedTargets = @($plan.options.A.delete) + @($plan.options.B.additionalDelete)
$approvedNames = @($approvedTargets | ForEach-Object { Normalize-RelativePath ([string]$_.path) })
if ($approvedNames -notcontains $requested) {
    throw "TargetPath is not an approved option B target: $requested"
}

$remaining = @($approvedTargets | Where-Object {
        Test-Path -LiteralPath (Resolve-SafeTarget (Normalize-RelativePath ([string]$_.path)))
    } | ForEach-Object { Normalize-RelativePath ([string]$_.path) })
if ($remaining.Count -ne 1 -or $remaining[0] -ne $requested) {
    $found = if ($remaining.Count -eq 0) { "none" } else { $remaining -join ", " }
    throw "Reconciliation requires exactly one remaining approved target, but found: $found"
}

$absoluteTarget = Resolve-SafeTarget $requested
$item = Get-Item -LiteralPath $absoluteTarget -Force
if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "TargetPath is a reparse point: $requested"
}
$canonicalTarget = [IO.Path]::GetFullPath($absoluteTarget)
if (-not $canonicalTarget.StartsWith($root.TrimEnd("\") + "\", [StringComparison]::OrdinalIgnoreCase)) {
    throw "TargetPath resolves outside the workspace: $requested"
}

if ($item.PSIsContainer) {
    $nestedLink = Get-ChildItem -LiteralPath $absoluteTarget -Recurse -Force -ErrorAction Stop |
        Where-Object { ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 } |
        Select-Object -First 1
    if ($nestedLink) {
        throw "TargetPath contains a reparse point: $($nestedLink.FullName)"
    }
    $files = @(Get-ChildItem -LiteralPath $absoluteTarget -Recurse -File -Force | Sort-Object FullName)
} else {
    $files = @($item)
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

if (-not $Execute) {
    [pscustomobject]@{
        status = "dry-run"
        approved_option = "B"
        target = $requested
        recovery = "Windows Recycle Bin"
        target_type = if ($item.PSIsContainer) { "directory" } else { "file" }
        bytes = $bytes
        file_count = $entries.Count
        permanently_deleted = $false
        execute_required = $true
    } | ConvertTo-Json
    exit 0
}

$artifactDirectory = Join-Path $root "artifacts\tier2-retirement"
if (-not (Test-Path -LiteralPath $artifactDirectory -PathType Container)) {
    $null = New-Item -ItemType Directory -Path $artifactDirectory
}
$timestamp = [DateTime]::UtcNow.ToString("yyyyMMddTHHmmssZ")
$manifestPath = Join-Path $artifactDirectory "reconcile-manifest-$timestamp.json"
$manifest = [ordered]@{
    schema_version = 1
    created_at = $timestamp
    workspace = $root
    approved_option = "B"
    recovery = "Windows Recycle Bin"
    reconciliation = $true
    target_count = 1
    targets = @([ordered]@{
            path = $requested
            type = if ($item.PSIsContainer) { "directory" } else { "file" }
            bytes = $bytes
            file_count = $entries.Count
            files = $entries
        })
}
[IO.File]::WriteAllText(
    $manifestPath,
    (($manifest | ConvertTo-Json -Depth 8) + "`n"),
    (New-Object System.Text.UTF8Encoding($false))
)

Add-Type -AssemblyName Microsoft.VisualBasic
if ($item.PSIsContainer) {
    [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory(
        $absoluteTarget,
        [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs,
        [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin
    )
} else {
    [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile(
        $absoluteTarget,
        [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs,
        [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin
    )
}
if (Test-Path -LiteralPath $absoluteTarget) {
    throw "Approved reconciliation target remains after Recycle Bin move: $requested"
}

[pscustomobject]@{
    status = "pass"
    approved_option = "B"
    target = $requested
    targets_reconciled = 1
    recovery = "Windows Recycle Bin"
    manifest = $manifestPath
    permanently_deleted = $false
} | ConvertTo-Json
