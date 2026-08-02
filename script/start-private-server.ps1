param(
  [ValidateSet("web", "serve")]
  [string] $Mode = "web",

  [string] $Hostname = "127.0.0.1",

  [ValidateRange(1, 65535)]
  [int] $Port = 4096,

  [switch] $AllowRemoteHttp
)

$root = Split-Path -Parent $PSScriptRoot
$cli = Join-Path $root "packages\arforge\dist\arforge-windows-x64\bin\arforge.exe"
$loopback = @("127.0.0.1", "localhost", "::1")

if (-not (Test-Path -LiteralPath $cli -PathType Leaf)) {
  throw "Arforge CLI was not found at $cli. Build the CLI before starting the private server."
}

if ($Hostname -notin $loopback -and -not $AllowRemoteHttp) {
  throw "Remote plain-HTTP exposure is blocked. Publish through an HTTPS reverse proxy, or pass -AllowRemoteHttp only for an isolated trusted network."
}

foreach ($key in @("ARFORGE_DB_URL", "ARFORGE_SERVER_USERNAME", "ARFORGE_SERVER_PASSWORD")) {
  $value = [Environment]::GetEnvironmentVariable($key, "User")
  if ([string]::IsNullOrWhiteSpace($value)) {
    throw "$key is not configured in the current Windows user environment."
  }
  Set-Item -LiteralPath "Env:$key" -Value $value
}

$env:ARFORGE_DISABLE_AUTOUPDATE = "true"
& $cli $Mode --hostname $Hostname --port $Port
exit $LASTEXITCODE
