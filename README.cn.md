# Arforge Agent

[English](README.md)

Arforge Agent 是面向开发工作区的本地优先 AI 智能体。当前公开源码快照对应
测试版本 `1.0.0-test.1`，界面版本名为 `Arforge 测试 1.00.00 版`。本仓库提供
源码与开发文档，暂未提供官方商店版本或公共更新服务。

许可状态：`UNLICENSED`。源码公开可见不代表授予复制、再分发或制作衍生作品的
许可；如需开放授权，应由仓库所有者另行添加许可证。

## 当前统一架构

- `packages/core`：共享契约、数据库、Session Runner 和 Python capability bridge。
- `packages/arforge`：统一 CLI、Provider、Server、工具与会话运行时。
- `packages/app`：Desktop 与 Web 共用的 Solid 前端。
- `packages/desktop`：当前 Electron 桌面外壳。
- `arforge/`：保留的 Arforge Agent 特色能力，包括记忆、多智能体、评测、
  自动化、办公工具和兼容 Bridge。

CLI、Server、App 和 Desktop 使用同一套会话、模型、权限和 PostgreSQL
契约，不再各自维护一套产品状态。

## 已验证状态（2026-07-27）

- 真实 CLI → Core → DeepSeek 调用成功，模型完成状态为 `stop`。
- 切换最小权限 `arforge_app` 后再次真实调用，返回
  `Arforge私有链路正常`。
- Python 全量：`2967 passed, 7 skipped, 0 failed`。
- TypeScript 成熟运行时全量：
  `3182 passed, 65 skipped, 1 todo, 0 failed`。
- 根工作区 TypeScript：`23/23` 包通过。
- 严格品牌审计：`0 hits in 0 finding files`；遍历 6,392 个文件，扫描
  5,786 个文本文件。
- 外部 `E:\Arforge` 路径依赖、Junction 和运行进程：均为 0。
- PostgreSQL 应用角色读写往返、备份和恢复比对通过。

跳过项是当前 Windows 主机缺少的可选运行时或平台能力；例如本机没有
Go/Ruby/PHP 且 Docker 引擎未启动时会明确跳过/报告不可用，不伪造成功。

## 首次配置

```powershell
cd E:\Arforge-Agent
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -e ".[dev,postgres]"
.\.tools\bun-1.3.14\bun.exe install
```

私有环境文件位于：

```text
%USERPROFILE%\.arforge\.env
```

示例值只能使用占位符，真实密钥不要提交到仓库：

```dotenv
DEEPSEEK_API_KEY=replace-with-your-key
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-v4-flash
ARFORGE_DB_URL=postgresql://arforge_app:replace-with-generated-secret@127.0.0.1:5432/arforge
```

统一 TypeScript 运行时的模型选择位于：

```text
%USERPROFILE%\.config\arforge\arforge.json
```

```json
{
  "model": "deepseek-v4-flash/deepseek-v4-flash"
}
```

管理员数据库连接只用于迁移和应用角色初始化。当前进程临时持有管理员
`ARFORGE_DB_URL` 时，可执行：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\configure_private_postgres.ps1
```

脚本会生成随机的 `arforge_app` 密码、审计最小权限，并只把应用连接持久化到
用户私有 `.env`；不会把管理员连接当作日常运行连接保存。

## 启动

CLI：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\run_cli.ps1 --help
powershell -ExecutionPolicy Bypass -File .\scripts\run_cli.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\run_cli.ps1 doctor --json
powershell -ExecutionPolicy Bypass -File .\scripts\run_cli.ps1 tools --json
powershell -ExecutionPolicy Bypass -File .\scripts\run_cli.ps1 agents --json
powershell -ExecutionPolicy Bypass -File .\scripts\run_cli.ps1 models deepseek
powershell -ExecutionPolicy Bypass -File .\scripts\run_cli.ps1 --model deepseek/deepseek-v4-pro
powershell -ExecutionPolicy Bypass -File .\scripts\run_cli.ps1 logs-prune 30
powershell -ExecutionPolicy Bypass -File .\scripts\run_cli.ps1 secrets-scan
```

进入 CLI 终端界面后，输入 `/models` 并回车可打开模型选择器；也可先按
`Ctrl+X`、松开后再按 `M`。方向键选择、`Enter` 确认，`F2` 在最近模型间
切换。启动参数 `--model 提供商/模型` 可直接指定本次会话模型。

`logs-prune` 默认只生成删除预览；确认清单后追加 `--apply` 才会删除过期
日志。`secrets-scan` 只输出命中文件和凭据类别计数，不会显示凭据值。

桌面端：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\run_desktop.ps1
```

两个启动器都固定使用本工程的 Bun，并加载同一个用户私有 `.env`。它们拒绝
从其他工程目录启动。

## 数据库边界

- 私有持久模式：PostgreSQL `arforge` 数据库，日常角色 `arforge_app`。
- 管理员角色：只运行迁移、授权和恢复管理，不启动产品。
- SQLite/内存数据库：只用于显式本地隔离测试或尚未迁移的兼容能力。
- 备份：`%LOCALAPPDATA%\Arforge\backups\postgresql`。

`arforge clear-data` 采用两阶段协议：首次调用只盘点 `workspace|all` 范围、
生成并验证加密 PostgreSQL 备份，再显示 15 分钟有效的一次性短语；执行阶段
重新校验数据库指纹和备份哈希。`all` 还必须提供独立的
`ARFORGE_DB_ADMIN_URL`，账号、凭据和迁移账本始终保留。

## 重要边界

- 当前工程提供手动触发的未签名 Windows 内部 Alpha，以及受保护的签名 Beta 候选
  流水线。后者在取得经验证的云 HSM 代码签名身份并配置 GitHub 受保护环境前仍是
  阻塞状态。操作见 [内部 Alpha 发布手册](docs/INTERNAL_ALPHA_RELEASE.md) 和
  [签名 Beta 配置指南](docs/SIGNED_BETA_SETUP.md)。商店、官网、自动更新和公共托管
  仍未启用。
- 冻结的 Tauri/Python 产品入口已在数据库收敛并获得所有者批准后，于
  2026-07-28 移入 Windows 回收站。
- GitHub 通用仓库解析和第三方 LSP/ripgrep 下载仍是功能依赖；它们不代表
  Arforge 的官网或公共仓库。删除这些能力前必须先由所有者确认。
- `node_modules` 与 `.bun` 是可重建依赖缓存，可清理但会导致下一次安装/启动
  重新下载和链接依赖；不属于产品源码。

完整能力映射见
[融合矩阵](docs/CAPABILITY_FUSION_MATRIX.md) 与
[本地能力审计](docs/LOCAL_PROJECT_READINESS.md)。

多用户部署前请阅读
[用户认证与租户隔离指南](docs/USER_AUTH_AND_TENANCY.md)，其中包含生产环境变量、邮件 Webhook 协议、
PostgreSQL RLS 要求和上线验收步骤。
