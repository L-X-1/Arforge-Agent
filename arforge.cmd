@echo off
set ARFORGE_ROOT=%~dp0
set ARFORGE_ROOT=%ARFORGE_ROOT:~0,-1%
set VENV_PYTHON=%ARFORGE_ROOT%\.venv\Scripts\python.exe
set MAIN_PY=%ARFORGE_ROOT%\main.py

if exist "%VENV_PYTHON%" (
    "%VENV_PYTHON%" -X utf8 "%MAIN_PY%" %*
) else (
    python -X utf8 "%MAIN_PY%" %*
)
