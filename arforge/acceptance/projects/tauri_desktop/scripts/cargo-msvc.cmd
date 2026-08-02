@echo off
setlocal
set "VCVARS=C:\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
if not exist "%VCVARS%" (
  set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
  if exist "%VSWHERE%" (
    for /f "usebackq tokens=*" %%i in (`"%VSWHERE%" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do (
      set "VCVARS=%%i\VC\Auxiliary\Build\vcvars64.bat"
    )
  )
)
if not exist "%VCVARS%" (
  echo Visual C++ vcvars64.bat is unavailable 1>&2
  exit /b 2
)
call "%VCVARS%" >nul
if errorlevel 1 exit /b %ERRORLEVEL%
cargo %*
exit /b %ERRORLEVEL%
