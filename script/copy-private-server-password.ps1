$password = [Environment]::GetEnvironmentVariable("ARFORGE_SERVER_PASSWORD", "User")
if ([string]::IsNullOrWhiteSpace($password)) {
  throw "ARFORGE_SERVER_PASSWORD is not configured in the current Windows user environment."
}

Set-Clipboard -Value $password
Write-Host "Arforge private server password copied to the clipboard."
