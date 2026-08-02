param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("build", "unit", "integration", "negative", "package", "all")]
    [string]$Suite
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$Database = Join-Path $ProjectRoot "acceptance.db"

function Invoke-SqlFile([string]$Path) {
    $SqlitePath = $Path.Replace("\", "/")
    & sqlite3 $Database ".read `"$SqlitePath`""
    if ($LASTEXITCODE -ne 0) {
        throw "sqlite3 failed for $Path"
    }
}

function Reset-Database {
    if (Test-Path -LiteralPath $Database) {
        Remove-Item -LiteralPath $Database -Force
    }
    Invoke-SqlFile (Join-Path $ProjectRoot "sql/001_schema.sql")
    Invoke-SqlFile (Join-Path $ProjectRoot "sql/002_indexes.sql")
    Invoke-SqlFile (Join-Path $ProjectRoot "sql/seed.sql")
}

function Invoke-Unit {
    Reset-Database
    $IndexCount = & sqlite3 $Database "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='work_items_project_status';"
    if ($IndexCount -ne "1") {
        throw "expected migration index"
    }
}

function Invoke-Integration {
    Reset-Database
    $ReportPath = (Join-Path $ProjectRoot "sql/report.sql").Replace("\", "/")
    $Report = & sqlite3 $Database ".read `"$ReportPath`""
    if ($Report -ne "Arforge:1") {
        throw "unexpected report: $Report"
    }
}

function Invoke-Negative {
    Reset-Database
    $PreviousErrorPreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    $null = & sqlite3 $Database "INSERT INTO work_items(project_id,title,status) VALUES (1,'bad','deleted');" 2>$null
    $InvalidExitCode = $LASTEXITCODE
    $ErrorActionPreference = $PreviousErrorPreference
    if ($InvalidExitCode -eq 0) {
        throw "invalid status bypassed the SQL constraint"
    }
    $Count = & sqlite3 $Database "SELECT COUNT(*) FROM work_items;"
    if ($Count -ne "1") {
        throw "failed insert mutated the database"
    }
}

switch ($Suite) {
    "build" { Reset-Database }
    "unit" { Invoke-Unit }
    "integration" { Invoke-Integration }
    "negative" { Invoke-Negative }
    "package" {
        Reset-Database
        $Dist = Join-Path $ProjectRoot "dist"
        New-Item -ItemType Directory -Path $Dist -Force | Out-Null
        $Archive = Join-Path $Dist "arforge-sql-shell.zip"
        if (Test-Path -LiteralPath $Archive) {
            Remove-Item -LiteralPath $Archive -Force
        }
        Compress-Archive -Path (Join-Path $ProjectRoot "sql"), $Database -DestinationPath $Archive
    }
    "all" {
        Invoke-Unit
        Invoke-Integration
        Invoke-Negative
    }
}

Write-Output "PASS:$Suite"
