[CmdletBinding(PositionalBinding = $false)]
param(
  [string]$Workspace = "",
  [switch]$ValidateOnly,
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$CliArguments
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$scriptDirectory = $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($Workspace)) {
  $Workspace = Split-Path $scriptDirectory -Parent
}
$root = (Resolve-Path -LiteralPath $Workspace).Path
$expectedRoot = [IO.Path]::GetFullPath((Split-Path $scriptDirectory -Parent))
if ($root -ne $expectedRoot) {
  throw "This private launcher only starts its owning workspace: $expectedRoot"
}

$bun = Join-Path $root ".tools\bun-1.3.14\bun.exe"
$entry = Join-Path $root "packages\arforge\src\index.ts"
if (!(Test-Path -LiteralPath $bun -PathType Leaf)) {
  throw "Target-owned Bun runtime was not found: $bun"
}
if (!(Test-Path -LiteralPath $entry -PathType Leaf)) {
  throw "Unified Arforge CLI entry was not found: $entry"
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
  "runtime=$bun"
  "entry=$entry"
  return
}

Import-ArforgePrivateEnvironment -Path $privateEnv

$env:PATH = "$(Split-Path $bun -Parent);$env:PATH"
& $bun --conditions=browser $entry @CliArguments
exit $LASTEXITCODE
