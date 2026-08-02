# Arforge Agent 用户指南

本文面向 `Arforge 测试 1.00.00 版` 的私有本地使用。产品入口统一为
TypeScript CLI 与 Electron Desktop。

## 1. 启动前检查

```powershell
cd E:\Arforge-Agent
powershell -ExecutionPolicy Bypass -File .\scripts\run_cli.ps1 -ValidateOnly
powershell -ExecutionPolicy Bypass -File .\scripts\run_desktop.ps1 -ValidateOnly
```

两个命令应显示工作区 `E:\Arforge-Agent`、仓库固定 Bun 和当前 Electron 路径。
启动器不会从 `E:\Arforge` 或其他工程加载代码。

## 2. 模型配置

私有密钥文件：

```text
%USERPROFILE%\.arforge\.env
```

```dotenv
DEEPSEEK_API_KEY=replace-with-your-key
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-v4-flash
```

统一运行时的选中模型必须写成 `provider/model`：

```text
%USERPROFILE%\.config\arforge\arforge.json
```

```json
{
  "model": "deepseek-v4-flash/deepseek-v4-flash"
}
```

如果界面一直显示“思考中”，依次检查：

1. 模型是否是完整的 `provider/model`，而不是旧的显示名称。
2. `DEEPSEEK_API_KEY` 是否在用户私有 `.env` 或 Arforge 凭据存储中。
3. 用 CLI 执行一次最小调用：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\run_cli.ps1 run `
  "只回复：Arforge模型链路正常" `
  --model "deepseek-v4-flash/deepseek-v4-flash"
```

## 3. PostgreSQL

私有持久模式使用数据库 `arforge`，日常角色必须是最小权限
`arforge_app`。管理员角色只运行迁移、授权与恢复，不启动产品。

首次配置应用角色：

```powershell
# 当前进程临时设置管理员 URL 后执行；不要把管理员 URL 提交到仓库
$env:ARFORGE_DB_URL = "postgresql://admin:password@127.0.0.1:5432/arforge"
powershell -ExecutionPolicy Bypass -File .\scripts\configure_private_postgres.ps1
Remove-Item Env:ARFORGE_DB_URL
```

配置脚本会生成随机应用密码、验证读写往返和拒绝的管理权限，并把应用 URL
写入 `%USERPROFILE%\.arforge\.env`。

备份目录：

```text
%LOCALAPPDATA%\Arforge\backups\postgresql
```

备份文件存在不等于可恢复；必须定期恢复到隔离数据库并比较表数和关键数据。

## 4. 启动 CLI 与桌面端

```powershell
# CLI
powershell -ExecutionPolicy Bypass -File .\scripts\run_cli.ps1

# Desktop
powershell -ExecutionPolicy Bypass -File .\scripts\run_desktop.ps1
```

常用 CLI：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\run_cli.ps1 --help
powershell -ExecutionPolicy Bypass -File .\scripts\run_cli.ps1 models
powershell -ExecutionPolicy Bypass -File .\scripts\run_cli.ps1 session list
powershell -ExecutionPolicy Bypass -File .\scripts\run_cli.ps1 capabilities
powershell -ExecutionPolicy Bypass -File .\scripts\run_cli.ps1 quality package.json
powershell -ExecutionPolicy Bypass -File .\scripts\run_cli.ps1 repo-scale AgentPython `
  --max-files 5000 --limit 10
```

CLI 与 Desktop 共用 Provider、Session、Permission 和 PostgreSQL 状态。不要
同时用旧入口写入同一生产数据。

`quality` 与 `repo-scale` 都通过统一 Server/Core 调用保留的 Python
只读能力，并受当前工作区边界限制。桌面端“Session operations”中提供相同的
质量门禁、仓库规模和有界搜索界面。

## 5. 安全使用

- 只对可信工作区授予写入或命令执行权限。
- 阅读审批卡中的命令、目标路径和风险；取消/无输入应视为拒绝。
- 不把 `.env`、数据库 URL、完整日志或用户数据发送给他人。
- 日志与导出前仍需检查脱敏结果。
- Go/Ruby/PHP 等外部运行时缺失时，Arforge 会报告不可用；不会把未启动的
  Docker Desktop 误判为可用。

完整状态见 [本地能力审计](LOCAL_PROJECT_READINESS.md) 和
[融合矩阵](CAPABILITY_FUSION_MATRIX.md)。

运维与恢复入口：

- [数据库迁移手册](DATABASE_MIGRATION_RUNBOOK.md)
- [数据库备份与恢复](DATABASE_DEPLOYMENT.md)
- [私有 HTTPS 部署](PRIVATE_HTTPS_DEPLOYMENT.md)
- [依赖归属与许可文件处理策略](DEPENDENCY_ATTRIBUTION_POLICY.md)
