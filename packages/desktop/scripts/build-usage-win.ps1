param(
  [string]$OutputRoot = 'E:\APPS\Arforge',
  [string]$BunPath = '',
  [switch]$CreateDesktopShortcut
)
$ErrorActionPreference = 'Stop'
$desktopRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$repoRoot = [IO.Path]::GetFullPath((Join-Path $desktopRoot '..\..'))
if (-not $BunPath) { $BunPath = Join-Path $repoRoot '.tools\bun-1.3.14\bun.exe' }
if (-not (Test-Path -LiteralPath $BunPath -PathType Leaf)) { throw 'An existing build-time Bun executable is required' }
$outputBase = [IO.Path]::GetFullPath($OutputRoot)
if (-not [IO.Path]::IsPathFullyQualified($OutputRoot)) { throw 'OutputRoot must be absolute' }
$stamp = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ')
$destination = Join-Path $outputBase "1.0.0-$stamp"
if (Test-Path -LiteralPath $destination) { throw 'Refusing to overwrite an existing usage version' }
$stage = Join-Path ([IO.Path]::GetTempPath()) "arforge-usage-build-$([Guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Path $stage | Out-Null
$buildEnv = @{
  ARFORGE_CHANNEL = 'prod'; ARFORGE_VERSION = '1.0.0';
  ARFORGE_NODE_OUT = (Join-Path $stage 'node');
  ARFORGE_DESKTOP_OUT = (Join-Path $stage 'desktop-out');
  ARFORGE_DESKTOP_PACKAGE_OUT = (Join-Path $stage 'package');
  ARFORGE_DESKTOP_ICON_DIR = (Join-Path $desktopRoot 'icons\prod');
  CSC_IDENTITY_AUTO_DISCOVERY = 'false';
  ARFORGE_WINDOWS_SIGNING_PROVIDER = $null;
  MODELS_DEV_API_JSON = $null; ARFORGE_MODELS_URL = $null
}
$previous = @{}
foreach ($name in $buildEnv.Keys) {
  $previous[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
  [Environment]::SetEnvironmentVariable($name, $buildEnv[$name], 'Process')
}
Push-Location $desktopRoot
try {
  # Invoke canonical recipes directly: prebuild's shared icon/out writes are avoided.
  & $BunPath ../arforge/script/build-node.ts
  if ($LASTEXITCODE -ne 0) { throw 'Canonical Node/SDK build failed' }
  # The temporary Node bundle retains build-time imports for Rollup to bundle.
  # Resolve those against installed workspace dependencies during compilation;
  # only the compiled Desktop output is packaged, never this staging junction.
  $taskNodeBuildModules = Join-Path $env:ARFORGE_NODE_OUT 'node_modules'
  $taskNodeBuildDependencies = Join-Path $repoRoot 'packages\arforge\node_modules'
  if (-not (Test-Path -LiteralPath $taskNodeBuildModules)) {
    New-Item -ItemType Junction -Path $taskNodeBuildModules -Target $taskNodeBuildDependencies | Out-Null
  }
  & $BunPath run --bun electron-vite build
  if ($LASTEXITCODE -ne 0) { throw 'Normal prod Desktop build failed' }
  & $BunPath run --bun electron-builder --win --dir --publish never --config electron-builder.config.ts
  if ($LASTEXITCODE -ne 0) { throw 'Local unpacked packaging failed' }
  $unpacked = [IO.Path]::GetFullPath((Join-Path $stage 'package\win-unpacked'))
  if (-not $unpacked.StartsWith([IO.Path]::GetFullPath($stage) + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Staged source escaped its owned root' }
  if (-not $destination.StartsWith($outputBase.TrimEnd('\','/') + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Delivery destination escaped OutputRoot' }
  if (-not (Test-Path -LiteralPath (Join-Path $unpacked 'Arforge.exe') -PathType Leaf)) { throw 'Packaged Arforge.exe missing' }
  New-Item -ItemType Directory -Path $outputBase -Force | Out-Null
  Move-Item -LiteralPath $unpacked -Destination $destination
  $shortcutPath = $null
  if ($CreateDesktopShortcut) {
    $shortcutPath = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Arforge.lnk'
    if (Test-Path -LiteralPath $shortcutPath) { throw 'Existing Desktop shortcut preserved; choose a separate link explicitly' }
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($shortcutPath)
    $shortcut.TargetPath = Join-Path $destination 'Arforge.exe'
    $shortcut.WorkingDirectory = $destination
    $shortcut.IconLocation = "$($shortcut.TargetPath),0"
    $shortcut.Save()
  }
  [ordered]@{ version='1.0.0'; channel='prod'; appId='ai.arforge.desktop'; executable='Arforge.exe'; desktopShortcutCreated=[bool]$shortcutPath; runtimeAudit='See separately delivered audit receipt'; signing=$false; publishing=$false } |
    ConvertTo-Json | Set-Content -LiteralPath (Join-Path $destination 'local-delivery.json') -Encoding utf8
  Write-Output $destination
} finally {
  Pop-Location
  foreach ($name in $buildEnv.Keys) { [Environment]::SetEnvironmentVariable($name, $previous[$name], 'Process') }
}
