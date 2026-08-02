@echo off
chcp 65001 >nul
echo === Arforge PostgreSQL 环境配置 ===
set PGDIR=C:\Program Files\PostgreSQL\17
set PGDATA=%PGDIR%\data
set PGBIN=%PGDIR%\bin
if "%ARFORGE_POSTGRES_PASSWORD%"=="" (
    echo ERROR: Set ARFORGE_POSTGRES_PASSWORD before running this script.
    echo The password is read from the process environment and is never stored here.
    exit /b 2
)
set PGPASSWORD=%ARFORGE_POSTGRES_PASSWORD%

echo.
echo [1/2] 确保 PostgreSQL 服务已启动...
net start postgresql-x64-17

echo.
echo [2/2] 创建数据库...
"%PGBIN%\psql" -U postgres -h localhost -d postgres -c "CREATE DATABASE arforge;" 2>nul
if errorlevel 1 echo arforge 数据库已存在（跳过创建）
"%PGBIN%\psql" -U postgres -h localhost -d postgres -c "CREATE DATABASE arforge_ma;" 2>nul
if errorlevel 1 echo arforge_ma 数据库已存在（跳过创建）

echo.
echo === 配置完成 ===
echo 数据库: arforge, arforge_ma
echo.
echo 接下来在项目目录运行:
echo   在 .env 或用户环境中设置 ARFORGE_DB_URL（不要提交密码）
echo   arforge.cmd
set PGPASSWORD=
pause
