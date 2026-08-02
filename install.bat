@echo off
setlocal
title Arforge Agent Installer

echo.
echo ========================================
echo   Arforge Agent Installer
echo ========================================
echo.

python --version >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Python 3.10 or newer was not found.
    echo Download: https://www.python.org/downloads/
    exit /b 1
)

if not exist ".venv\Scripts\python.exe" (
    echo [1/3] Creating isolated environment...
    python -m venv .venv
    if errorlevel 1 exit /b 1
) else (
    echo [1/3] Reusing .venv...
)

echo [2/3] Updating installer tools...
".venv\Scripts\python.exe" -m pip install --upgrade pip
if errorlevel 1 exit /b 1

echo [3/3] Installing Arforge Agent...
".venv\Scripts\python.exe" -m pip install -e .
if errorlevel 1 exit /b 1

echo.
echo Installation complete.
echo Run: .venv\Scripts\arforge.exe doctor
echo.
endlocal
