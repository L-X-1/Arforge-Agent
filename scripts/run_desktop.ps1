[CmdletBinding()]
param(
  [ValidateSet("Dev")]
  [string]$Mode = "Dev",
  [string]$Workspace = "",
  [switch]$ValidateOnly,
  [switch]$Detached
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$scriptDirectory = $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($scriptDirectory)) {
  $scriptDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
}
if ([string]::IsNullOrWhiteSpace($Workspace)) {
  $Workspace = Split-Path $scriptDirectory -Parent
}
$root = (Resolve-Path -LiteralPath $Workspace).Path
$expectedRoot = [IO.Path]::GetFullPath((Split-Path $scriptDirectory -Parent))
if ($root -ne $expectedRoot) {
  throw "This private launcher only starts its owning workspace: $expectedRoot"
}

$bun = Join-Path $root ".tools\bun-1.3.14\bun.exe"
if (!(Test-Path -LiteralPath $bun -PathType Leaf)) {
  throw "Target-owned Bun runtime was not found: $bun"
}

$desktopPackage = Join-Path $root "packages\desktop\package.json"
if (!(Test-Path -LiteralPath $desktopPackage -PathType Leaf)) {
  throw "Unified Electron Desktop package was not found: $desktopPackage"
}

$electronPackage = Get-ChildItem -LiteralPath (Join-Path $root "node_modules\.bun") -Directory -Filter "electron@42.3.3*" |
  Sort-Object Name |
  Select-Object -First 1
if ($null -eq $electronPackage) {
  throw "Electron 42.3.3 is not installed in the target workspace. Run the target-owned Bun install first."
}
$electronRoot = Join-Path $electronPackage.FullName "node_modules\electron"
$electronName = (Get-Content -Raw -LiteralPath (Join-Path $electronRoot "path.txt")).Trim()
$electron = Join-Path (Join-Path $electronRoot "dist") $electronName
if ([string]::IsNullOrWhiteSpace($electronName) -or !(Test-Path -LiteralPath $electron -PathType Leaf)) {
  throw "Electron executable is incomplete: $electron"
}

$privateEnv = Join-Path $env:USERPROFILE ".arforge\.env"
function Import-ArforgePrivateEnvironment {
  param([string]$Path)
  if (!(Test-Path -LiteralPath $Path -PathType Leaf)) {
    return
  }
  foreach ($line in Get-Content -LiteralPath $Path) {
    if ($line -notmatch '^\s*((?:ARFORGE|DEEPSEEK)_[A-Za-z0-9_]+)\s*=(.*)$') {
      continue
    }
    $name = $Matches[1]
    $value = $Matches[2].Trim()
    if (($value.StartsWith('"') -and $value.EndsWith('"')) -or
        ($value.StartsWith("'") -and $value.EndsWith("'"))) {
      $value = $value.Substring(1, $value.Length - 2)
    }
    [Environment]::SetEnvironmentVariable($name, $value, "Process")
  }
}

if ($ValidateOnly) {
  "workspace=$root"
  "mode=$Mode"
  "runtime=$bun"
  "desktop=Electron"
  "electron=$electron"
  "private_config=$privateEnv"
  "private_config_exists=$(Test-Path -LiteralPath $privateEnv -PathType Leaf)"
  return
}

Import-ArforgePrivateEnvironment -Path $privateEnv

if ($Detached) {
  $env:PATH = "$(Split-Path $bun -Parent);$env:PATH"
  Start-Process -FilePath $bun -ArgumentList @("run", "dev:desktop") -WorkingDirectory $root -WindowStyle Hidden
  return
}

$env:PATH = "$(Split-Path $bun -Parent);$env:PATH"
& $bun run dev:desktop
exit $LASTEXITCODE
