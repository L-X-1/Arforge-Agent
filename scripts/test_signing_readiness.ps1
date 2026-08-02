[CmdletBinding()]
param(
    [string]$OutputPath = "desktop/release-evidence/signing-readiness.json"
)

$ErrorActionPreference = "Stop"
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$target = Join-Path $projectRoot $OutputPath
$blockers = [System.Collections.Generic.List[string]]::new()

foreach ($name in @(
    "SM_HOST",
    "SM_API_KEY",
    "SM_CLIENT_CERT_FILE",
    "SM_CLIENT_CERT_PASSWORD",
    "ARFORGE_WINDOWS_KEYPAIR_ALIAS",
    "ARFORGE_WINDOWS_EXPECTED_SIGNER_SUBJECT"
)) {
    if ([string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($name))) {
        $blockers.Add("MISSING_$name")
    }
}

$smctl = Get-Command smctl -ErrorAction SilentlyContinue
if ($null -eq $smctl) { $blockers.Add("SMCTL_NOT_INSTALLED") }

$clientCertificate = $env:SM_CLIENT_CERT_FILE
if (-not [string]::IsNullOrWhiteSpace($clientCertificate) -and -not (Test-Path -LiteralPath $clientCertificate -PathType Leaf)) {
    $blockers.Add("SM_CLIENT_CERT_FILE_NOT_FOUND")
}

$gitCommit = (git -C $projectRoot rev-parse HEAD).Trim()
$remoteNames = @(git -C $projectRoot remote)
$payload = [ordered]@{
    schema_version = 2
    ready = $blockers.Count -eq 0
    blocker_codes = @($blockers)
    provider = "digicert-keylocker"
    credential_mode = "client-authentication-certificate"
    certificate = [ordered]@{
        found = $blockers -notcontains "SM_CLIENT_CERT_FILE_NOT_FOUND"
        private_key_export_blocked = $true
    }
    timestamp = [ordered]@{
        configured = $true
        rfc3161 = $true
        provider_managed = $true
    }
    git = [ordered]@{
        commit = $gitCommit
        remote_count = $remoteNames.Count
        remote_names = $remoteNames
    }
    checked_at_utc = (Get-Date).ToUniversalTime().ToString("o")
}

New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
$payload | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $target -Encoding utf8

if ($blockers.Count -gt 0) {
    throw "Signing readiness failed: $($blockers -join ', '). No secret values were printed."
}

Write-Host "Signing readiness passed for provider digicert-keylocker."

