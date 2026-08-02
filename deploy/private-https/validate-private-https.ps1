[CmdletBinding()]
param(
  [ValidateSet("Public", "Internal")]
  [string]$Mode = "Internal",
  [string]$Domain = "arforge.localhost",
  [string]$CaddyExecutable
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

if ($Domain -notmatch "^[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$") {
  throw "Domain must be a hostname without a scheme, port, path, or wildcard."
}
if ($Mode -eq "Public" -and $Domain.EndsWith(".localhost")) {
  throw "Public mode requires a real DNS hostname whose A/AAAA record points to this server."
}

$caddy = if (![string]::IsNullOrWhiteSpace($CaddyExecutable)) {
  [IO.Path]::GetFullPath($CaddyExecutable)
} else {
  (Get-Command caddy.exe -ErrorAction Stop).Source
}
if (!(Test-Path -LiteralPath $caddy -PathType Leaf)) {
  throw "Caddy executable was not found: $caddy"
}

$config = Join-Path $PSScriptRoot "Caddyfile.$($Mode.ToLowerInvariant())"
$previous = $env:ARFORGE_DOMAIN
try {
  $env:ARFORGE_DOMAIN = $Domain
  & $caddy validate --config $config --adapter caddyfile
  if ($LASTEXITCODE -ne 0) {
    throw "Caddy rejected the Arforge HTTPS configuration."
  }
} finally {
  if ($null -eq $previous) {
    Remove-Item Env:ARFORGE_DOMAIN -ErrorAction SilentlyContinue
  } else {
    $env:ARFORGE_DOMAIN = $previous
  }
}

[pscustomobject]@{
  Valid = $true
  Mode = $Mode
  Domain = $Domain
  Config = $config
  Backend = "http://127.0.0.1:4096"
  PublicUrl = "https://$Domain"
} | ConvertTo-Json -Depth 3
