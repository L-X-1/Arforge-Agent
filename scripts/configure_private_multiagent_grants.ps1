[CmdletBinding()]
param(
    [string]$PrivateEnv = (Join-Path $env:USERPROFILE ".arforge\.env"),
    [string]$ApplicationRole = "arforge_app"
)

$ErrorActionPreference = "Stop"

function Read-PrivateEnv {
    param([string]$Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Private environment file does not exist: $Path"
    }
    $result = @{}
    foreach ($raw in Get-Content -LiteralPath $Path -Encoding UTF8) {
        $line = $raw.Trim()
        if (-not $line -or $line.StartsWith("#") -or -not $line.Contains("=")) { continue }
        $parts = $line.Split("=", 2)
        $result[$parts[0].Trim()] = $parts[1].Trim().Trim('"').Trim("'")
    }
    return $result
}

function Get-PostgresCredential {
    param([string]$Url, [string]$Variable)

    try { $uri = [Uri]$Url } catch { throw "$Variable is not a valid URL" }
    if ($uri.Scheme -notin @("postgres", "postgresql")) {
        throw "$Variable must use PostgreSQL"
    }
    $userInfo = $uri.UserInfo.Split(":", 2)
    if ($userInfo.Count -ne 2) { throw "$Variable must include a username and password" }
    return @{
        Uri = $uri
        User = [Uri]::UnescapeDataString($userInfo[0])
        Password = [Uri]::UnescapeDataString($userInfo[1])
        Port = if ($uri.IsDefaultPort) { 5432 } else { $uri.Port }
    }
}

function Write-ExplicitMultiagentUrl {
    param([string]$Path, [string]$Url)

    $lines = @(Get-Content -LiteralPath $Path -Encoding UTF8 |
        Where-Object { $_ -notmatch "^\s*ARFORGE_MULTIAGENT_DB_URL\s*=" })
    $content = (($lines + "ARFORGE_MULTIAGENT_DB_URL=$Url") -join "`n").TrimEnd() + "`n"
    [IO.File]::WriteAllText(
        $Path,
        $content,
        (New-Object System.Text.UTF8Encoding($false))
    )
}

$values = Read-PrivateEnv -Path $PrivateEnv
$app = Get-PostgresCredential -Url $values["ARFORGE_DB_URL"] -Variable "ARFORGE_DB_URL"
$admin = Get-PostgresCredential -Url $values["ARFORGE_DB_ADMIN_URL"] -Variable "ARFORGE_DB_ADMIN_URL"
if ($app.Uri.Host -ne $admin.Uri.Host -or $app.Port -ne $admin.Port) {
    throw "Application and administrator URLs must target the same PostgreSQL server"
}
if ([Uri]::UnescapeDataString($app.Uri.AbsolutePath.TrimStart("/")) -ne "arforge") {
    throw "ARFORGE_DB_URL must target the arforge database"
}

$multiagentDatabase = "arforge_ma"
$programFiles = if ($env:ProgramFiles) { $env:ProgramFiles } else { "C:\Program Files" }
$psql = @(
    (Join-Path $programFiles "PostgreSQL\18\bin\psql.exe"),
    (Join-Path $programFiles "PostgreSQL\17\bin\psql.exe"),
    (Join-Path $programFiles "PostgreSQL\16\bin\psql.exe"),
    (Join-Path $programFiles "PostgreSQL\15\bin\psql.exe")
) | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
if (-not $psql) { throw "PostgreSQL psql.exe was not found" }

$previousPassword = $env:PGPASSWORD
try {
    $env:PGPASSWORD = $admin.Password
    & $psql `
        --host $admin.Uri.Host `
        --port $admin.Port `
        --username $admin.User `
        --dbname $multiagentDatabase `
        --no-password `
        --no-psqlrc `
        --quiet `
        --set ON_ERROR_STOP=1 `
        --command @"
BEGIN;
GRANT CONNECT ON DATABASE arforge_ma TO arforge_app;
GRANT USAGE ON SCHEMA public TO arforge_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.multiagent_tasks, public.multiagent_conversations TO arforge_app;
GRANT SELECT ON TABLE public.alembic_version TO arforge_app;
COMMIT;
"@
    if ($LASTEXITCODE -ne 0) { throw "Failed to apply isolated multi-agent grants" }
} finally {
    if ($null -eq $previousPassword) {
        Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue
    } else {
        $env:PGPASSWORD = $previousPassword
    }
}

$builder = New-Object UriBuilder($app.Uri)
$builder.Path = $multiagentDatabase
Write-ExplicitMultiagentUrl -Path $PrivateEnv -Url $builder.Uri.AbsoluteUri

try {
    $env:PGPASSWORD = $app.Password
    $probe = & $psql `
        --host $app.Uri.Host `
        --port $app.Port `
        --username $app.User `
        --dbname $multiagentDatabase `
        --no-password `
        --no-psqlrc `
        --quiet `
        --tuples-only `
        --no-align `
        --set ON_ERROR_STOP=1 `
        --command @"
SELECT json_build_object(
  'database', current_database(),
  'role', current_user,
  'tasks', (SELECT count(*)::int FROM multiagent_tasks),
  'conversations', (SELECT count(*)::int FROM multiagent_conversations),
  'can_create_schema', has_schema_privilege(current_user, 'public', 'CREATE')
);
"@
    if ($LASTEXITCODE -ne 0) { throw "Application-role multi-agent verification failed" }
    $result = ($probe | Out-String).Trim() | ConvertFrom-Json
    if ($result.database -ne $multiagentDatabase -or $result.role -ne $ApplicationRole) {
        throw "Application-role verification reached an unexpected database or role"
    }
    if ($result.can_create_schema -ne $false) {
        throw "Application role must not be able to create schemas"
    }
    [pscustomobject]@{
        database = $result.database
        role = $result.role
        tasks = $result.tasks
        conversations = $result.conversations
        can_create_schema = $result.can_create_schema
        explicit_private_url_saved = $true
    } | ConvertTo-Json
} finally {
    if ($null -eq $previousPassword) {
        Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue
    } else {
        $env:PGPASSWORD = $previousPassword
    }
}
