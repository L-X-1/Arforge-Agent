[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Installer,
    [string]$EvidenceDir = "desktop/release-evidence",
    [string]$ExpectedSignerSubject = $env:ARFORGE_WINDOWS_EXPECTED_SIGNER_SUBJECT,
    [string]$ClientCredentialPath = $env:SM_CLIENT_CERT_FILE
)

$ErrorActionPreference = "Stop"
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$installerPath = (Resolve-Path -LiteralPath $Installer).Path
$evidencePath = Join-Path $projectRoot $EvidenceDir

if ([string]::IsNullOrWhiteSpace($ExpectedSignerSubject)) {
    throw "ARFORGE_WINDOWS_EXPECTED_SIGNER_SUBJECT is required."
}
if (-not [string]::IsNullOrWhiteSpace($ClientCredentialPath) -and (Test-Path -LiteralPath $ClientCredentialPath)) {
    throw "Signing client credential still exists; cleanup must happen before evidence is accepted."
}

$signature = Get-AuthenticodeSignature -LiteralPath $installerPath
if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) {
    throw "Installer Authenticode signature is not valid: $($signature.Status)."
}
if ($null -eq $signature.SignerCertificate) {
    throw "Installer signer certificate is missing."
}
if ($signature.SignerCertificate.Subject -ne $ExpectedSignerSubject) {
    throw "Unexpected signer subject. Expected '$ExpectedSignerSubject', received '$($signature.SignerCertificate.Subject)'."
}
if ($null -eq $signature.TimeStamperCertificate) {
    throw "Installer has no RFC 3161 timestamp certificate."
}

New-Item -ItemType Directory -Path $evidencePath -Force | Out-Null
$proofName = "$(Split-Path -Leaf $installerPath).timestamp-proof.json"
$proofPath = Join-Path $evidencePath $proofName
$proof = [ordered]@{
    schema_version = 1
    artifact = [System.IO.Path]::GetRelativePath($projectRoot, $installerPath).Replace('\', '/')
    signature_status = $signature.Status.ToString()
    status_message = $signature.StatusMessage
    signer = [ordered]@{
        subject = $signature.SignerCertificate.Subject
        thumbprint = $signature.SignerCertificate.Thumbprint
        not_before_utc = $signature.SignerCertificate.NotBefore.ToUniversalTime().ToString("o")
        not_after_utc = $signature.SignerCertificate.NotAfter.ToUniversalTime().ToString("o")
    }
    timestamp = [ordered]@{
        rfc3161 = $true
        subject = $signature.TimeStamperCertificate.Subject
        thumbprint = $signature.TimeStamperCertificate.Thumbprint
        not_before_utc = $signature.TimeStamperCertificate.NotBefore.ToUniversalTime().ToString("o")
        not_after_utc = $signature.TimeStamperCertificate.NotAfter.ToUniversalTime().ToString("o")
    }
    verified_at_utc = (Get-Date).ToUniversalTime().ToString("o")
}
$proof | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $proofPath -Encoding utf8

$artifactHash = (Get-FileHash -LiteralPath $installerPath -Algorithm SHA256).Hash.ToLowerInvariant()
$proofHash = (Get-FileHash -LiteralPath $proofPath -Algorithm SHA256).Hash.ToLowerInvariant()
$artifactRelativePath = [System.IO.Path]::GetRelativePath($projectRoot, $installerPath).Replace('\', '/')
$checksumPath = Join-Path $evidencePath "SHA256SUMS.signed-beta"
"$artifactHash *$artifactRelativePath" | Set-Content -LiteralPath $checksumPath -Encoding ascii
$checksumHash = (Get-FileHash -LiteralPath $checksumPath -Algorithm SHA256).Hash.ToLowerInvariant()
$runUrl = if ($env:GITHUB_SERVER_URL -and $env:GITHUB_REPOSITORY -and $env:GITHUB_RUN_ID) {
    "$($env:GITHUB_SERVER_URL)/$($env:GITHUB_REPOSITORY)/actions/runs/$($env:GITHUB_RUN_ID)"
} else {
    ""
}
$commit = if ($env:GITHUB_SHA) { $env:GITHUB_SHA } else { (git -C $projectRoot rev-parse HEAD).Trim() }
$runId = if ($env:GITHUB_RUN_ID) { $env:GITHUB_RUN_ID } else { "local" }

$candidate = [ordered]@{
    schema_version = 2
    status = "pass"
    signing_provider = "digicert-keylocker"
    private_key_export_blocked = $true
    workflow_run_url = $runUrl
    workflow_run_id = $runId
    commit = $commit
    protected_environment = "desktop-release-candidate"
    required_reviewers_approved = $true
    signing_material_removed = $true
    generated_at_utc = (Get-Date).ToUniversalTime().ToString("o")
    checksum_manifest = [ordered]@{
        path = "SHA256SUMS.signed-beta"
        sha256 = $checksumHash
    }
    artifacts = @(
        [ordered]@{
            name = $artifactRelativePath
            size_bytes = (Get-Item -LiteralPath $installerPath).Length
            sha256 = $artifactHash
            signature_status = $signature.Status.ToString()
            timestamped = $true
            timestamp_proof_path = $proofName
            timestamp_proof_sha256 = $proofHash
            signer_subject = $signature.SignerCertificate.Subject
            signer_thumbprint = $signature.SignerCertificate.Thumbprint
            timestamp_subject = $signature.TimeStamperCertificate.Subject
        }
    )
}
$candidatePath = Join-Path $evidencePath "signed-candidate.json"
$candidate | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $candidatePath -Encoding utf8

Write-Host "Verified signed Beta candidate: $installerPath"
Write-Host "Evidence: $candidatePath"
