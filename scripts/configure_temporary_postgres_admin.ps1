[CmdletBinding()]
param(
    [string]$Role = "postgres",
    [string]$HostName = "localhost",
    [int]$Port = 5432,
    [string]$Database = "arforge",
    [switch]$Remove
)

$ErrorActionPreference = "Stop"
$envFile = Join-Path $env:USERPROFILE ".arforge\.env"
$envDirectory = Split-Path -Parent $envFile

function Write-PrivateEnv {
    param([string[]]$Lines)

    if (-not (Test-Path -LiteralPath $envDirectory -PathType Container)) {
        $null = New-Item -ItemType Directory -Path $envDirectory
    }
    $content = (($Lines | Where-Object { $_ -ne $null }) -join "`n").TrimEnd() + "`n"
    [IO.File]::WriteAllText(
        $envFile,
        $content,
        (New-Object System.Text.UTF8Encoding($false))
    )
}

$existing = @()
if (Test-Path -LiteralPath $envFile -PathType Leaf) {
    $existing = @(Get-Content -LiteralPath $envFile -Encoding UTF8)
}
$withoutAdmin = @($existing | Where-Object { $_ -notmatch "^\s*ARFORGE_DB_ADMIN_URL\s*=" })

if ($Remove) {
    Write-PrivateEnv -Lines $withoutAdmin
    Write-Host "Temporary PostgreSQL administrator connection removed from the private environment."
    exit 0
}

$programFiles = if ($env:ProgramFiles) { $env:ProgramFiles } else { "C:\Program Files" }
$psql = @(
    (Join-Path $programFiles "PostgreSQL\18\bin\psql.exe"),
    (Join-Path $programFiles "PostgreSQL\17\bin\psql.exe"),
    (Join-Path $programFiles "PostgreSQL\16\bin\psql.exe"),
    (Join-Path $programFiles "PostgreSQL\15\bin\psql.exe")
) | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
if (-not $psql) {
    throw "PostgreSQL psql.exe was not found."
}

$secure = Read-Host "PostgreSQL administrator password for $Role" -AsSecureString
$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
$plain = ""
try {
    $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    if ([string]::IsNullOrEmpty($plain)) {
        throw "Administrator password cannot be empty."
    }

    $previousPassword = $env:PGPASSWORD
    try {
        $env:PGPASSWORD = $plain
        $probe = & $psql `
            --host $HostName `
            --port $Port `
            --username $Role `
            --dbname $Database `
            --no-password `
            --no-psqlrc `
            --quiet `
            --tuples-only `
            --no-align `
            --set ON_ERROR_STOP=1 `
            --command "SELECT current_user || '|' || current_database() || '|' || (SELECT rolsuper::text FROM pg_roles WHERE rolname = current_user);" `
            2>&1
        if ($LASTEXITCODE -ne 0) {
            throw "PostgreSQL administrator login failed. No credential was written."
        }
    } finally {
        if ($null -eq $previousPassword) {
            Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue
        } else {
            $env:PGPASSWORD = $previousPassword
        }
    }

    $expected = "$Role|$Database|true"
    if (($probe | Out-String).Trim() -ne $expected) {
        throw "The verified role is not the expected PostgreSQL superuser on database $Database."
    }

    $encodedRole = [Uri]::EscapeDataString($Role)
    $encodedPassword = [Uri]::EscapeDataString($plain)
    $adminUrl = "postgresql://${encodedRole}:${encodedPassword}@${HostName}:$Port/$Database"
    Write-PrivateEnv -Lines @($withoutAdmin + "ARFORGE_DB_ADMIN_URL=$adminUrl")
    Write-Host "PostgreSQL administrator login verified and stored temporarily in the private environment."
} finally {
    $plain = ""
    if ($pointer -ne [IntPtr]::Zero) {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
    }
}
