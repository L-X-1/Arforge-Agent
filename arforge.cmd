@echo off
setlocal

rem Canonical Windows entrypoint: delegate to the unified TypeScript CLI.
rem bin\arforge.js resolves the repository Bun runtime and starts
rem packages\arforge\src\index.ts. The legacy Python CLI is migration-only.
set "ARFORGE_ROOT=%~dp0"
node "%ARFORGE_ROOT%bin\arforge.js" %*
set "ARFORGE_EXIT=%ERRORLEVEL%"
endlocal & exit /b %ARFORGE_EXIT%
