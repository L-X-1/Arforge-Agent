# Run with & in the PowerShell session whose arforge resolution you want to inspect.
# Collect metadata only; do not invoke arforge aliases/functions or read function bodies.
[CmdletBinding()]
param([switch]$Json)

$commands = @(Microsoft.PowerShell.Core\Get-Command -Name arforge -All -ErrorAction SilentlyContinue)
$rows = @(foreach ($command in $commands) {
    $row = @{ name = $command.Name; command_type = [string]$command.CommandType }
    if ($command.CommandType -eq 'Application' -or $command.CommandType -eq 'ExternalScript') { $row.path = $command.Path }
    $row
})
$snapshot = @{ schema_version = 1; commands = $rows } | Microsoft.PowerShell.Utility\ConvertTo-Json -Depth 4 -Compress
$nodeCommand = @(Microsoft.PowerShell.Core\Get-Command -Name node -CommandType Application -ErrorAction Stop)[0]
$launcher = [System.IO.Path]::GetFullPath("$PSScriptRoot/../bin/arforge.js")
$previousEncoding = $OutputEncoding
try {
    $OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    if ($Json) { $snapshot | & $nodeCommand.Path $launcher cli-path --powershell-stdin --json }
    else { $snapshot | & $nodeCommand.Path $launcher cli-path --powershell-stdin }
    $diagnosticExit = $LASTEXITCODE
} finally {
    $OutputEncoding = $previousEncoding
}
exit $diagnosticExit
