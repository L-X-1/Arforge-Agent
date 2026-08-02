param(
    [string]$Hostname = "localhost",
    [string]$OutputDirectory = ".arforge-private-tls",
    [ValidateRange(1, 3650)]
    [int]$Days = 365
)

$ErrorActionPreference = "Stop"

$openssl = Get-Command openssl -ErrorAction Stop
$output = [System.IO.Path]::GetFullPath((Join-Path (Get-Location) $OutputDirectory))
[System.IO.Directory]::CreateDirectory($output) | Out-Null

$certificate = Join-Path $output "arforge-private.crt"
$privateKey = Join-Path $output "arforge-private.key"
$emptyOpenSslConfig = if ($env:OS -eq "Windows_NT") { "NUL" } else { "/dev/null" }
$parsedAddress = $null
$subjectAltName = if ($Hostname -eq "localhost") {
    "DNS:localhost,IP:127.0.0.1,IP:::1"
} elseif ([System.Net.IPAddress]::TryParse($Hostname, [ref]$parsedAddress)) {
    "IP:$Hostname"
} else {
    "DNS:$Hostname"
}

$arguments = @(
    "req",
    "-x509",
    "-newkey", "rsa:3072",
    "-sha256",
    "-nodes",
    "-days", "$Days",
    "-config", $emptyOpenSslConfig,
    "-subj", "/CN=$Hostname",
    "-addext", "subjectAltName=$subjectAltName",
    "-addext", "keyUsage=digitalSignature,keyEncipherment",
    "-addext", "extendedKeyUsage=serverAuth",
    "-keyout", $privateKey,
    "-out", $certificate
)

& $openssl.Source @arguments
if ($LASTEXITCODE -ne 0) {
    throw "OpenSSL certificate generation failed with exit code $LASTEXITCODE."
}

if ($env:OS -eq "Windows_NT") {
    & icacls.exe $privateKey /inheritance:r /grant:r "$($env:USERNAME):(R)" | Out-Null
}

Write-Output "Certificate: $certificate"
Write-Output "Private key: $privateKey"
Write-Output "Start with: arforge serve --https-cert `"$certificate`" --https-key `"$privateKey`""
