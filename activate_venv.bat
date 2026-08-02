@echo off
title Arforge Agent - 激活虚拟环境

echo.
echo ========================================
echo   Arforge Agent - 激活 Python 虚拟环境
echo ========================================
echo.

if exist ".venv\Scripts\activate.bat" (
    echo [OK] 正在激活 .venv ...
    call .venv\Scripts\activate.bat
    echo.
    echo [OK] 虚拟环境已激活！当前 Python:
    python --version 2>nul
    echo.
    echo 提示: 输入 arforge 启动智能体
    echo       输入 arforge doctor 运行诊断
    echo       输入 deactivate 退出虚拟环境
    echo.
) else (
    echo [FAIL] .venv 目录未找到
    echo.
    echo 请先运行 install.bat 创建虚拟环境:
    echo   python -m venv .venv
    echo   .venv\Scripts\python -m pip install -e .
    echo.
    pause
    exit /b 1
)
