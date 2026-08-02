# Arforge Agent - 激活虚拟环境 (PowerShell)
Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Arforge Agent - 激活 Python 虚拟环境" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

if (Test-Path ".venv\Scripts\Activate.ps1") {
    Write-Host "[OK] 正在激活 .venv ..." -ForegroundColor Green
    . .venv\Scripts\Activate.ps1
    Write-Host ""
    Write-Host "[OK] 虚拟环境已激活！当前 Python:" -ForegroundColor Green
    python --version
    Write-Host ""
    Write-Host "提示: 输入 arforge 启动智能体" -ForegroundColor Yellow
    Write-Host "      输入 arforge doctor 运行诊断" -ForegroundColor Yellow
    Write-Host "      输入 deactivate 退出虚拟环境" -ForegroundColor Yellow
    Write-Host ""
} else {
    Write-Host "[FAIL] .venv 目录未找到" -ForegroundColor Red
    Write-Host ""
    Write-Host "请先创建虚拟环境:" -ForegroundColor Yellow
    Write-Host "  python -m venv .venv" -ForegroundColor Yellow
    Write-Host "  .venv\Scripts\python -m pip install -e ." -ForegroundColor Yellow
}
