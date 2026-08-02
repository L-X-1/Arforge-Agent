# Arforge 私有运维基线

更新时间：2026-07-27

本文是 PostgreSQL 灾备、Arforge 私有登录和 HTTPS 部署的可执行手册。任何口令、数据库 URL、恢复密钥和证书私钥都不得写入仓库。

## 1. PostgreSQL 备份

### 已部署策略

| 项目 | 当前值 |
| --- | --- |
| Windows 计划任务 | `Arforge PostgreSQL Backup` |
| 时间 | 每天 02:00（错过后尽快补跑） |
| 保留期 | 30 天 |
| 输出目录 | `%LOCALAPPDATA%\Arforge\backups\postgresql` |
| dump 格式 | PostgreSQL custom format、压缩级别 9 |
| 静态加密 | AES-256-CBC |
| 完整性/认证 | HMAC-SHA256（IV + 密文）与密文/明文双 SHA-256 |
| 主密钥保护 | Windows DPAPI CurrentUser |

运行账户只读取用户级 `ARFORGE_DB_URL`，命令行和计划任务参数中不出现数据库口令。每次成功备份先执行 `pg_restore --list`，明文临时 dump 在 `finally` 中删除，最终只保留 `.dump.enc`、manifest 和 SHA-256 sidecar。

手工备份：

```powershell
.\script\postgres-backup.ps1 -RetentionDays 30
```

重新安装计划任务：

```powershell
.\script\install-postgres-backup-task.ps1 -At "02:00" -RetentionDays 30
```

### 离线恢复密钥

DPAPI 文件只能由创建它的 Windows 用户在当前用户配置中解开，因此至少导出一份离线恢复密钥到可信密码管理器：

```powershell
.\script\copy-postgres-backup-recovery-key.ps1
```

脚本只把 JSON 恢复载荷写入剪贴板，不在终端显示密钥。保存后应清空剪贴板。新机器恢复时，将载荷放入剪贴板后执行：

```powershell
.\script\restore-postgres-backup-recovery-key.ps1
```

如果目标机器已有密钥，脚本默认拒绝覆盖；只有人工确认备份归属后才能加 `-Force`。

### 恢复演练

维护角色 URL 只应临时放在当前进程环境中，不得持久化为用户变量：

```powershell
$env:ARFORGE_DB_ADMIN_URL = "<postgresql-maintenance-url>"
.\script\postgres-recovery-drill.ps1
Remove-Item Env:ARFORGE_DB_ADMIN_URL
```

演练会创建隔离临时数据库、解密并恢复最新备份、逐表比较生产库与恢复库行数、输出 JSON 报告，最后无论成功失败都删除临时数据库和明文 dump。建议每月一次，并把报告复制到离线审计存储。

目标：日常 RPO 不超过 24 小时；当前小型数据库的实测恢复演练约 12 秒，但生产 RTO 应按数据量、磁盘和网络重新压测。

## 2. Arforge 私有登录

- 登录页面只把用户名和密码 POST 到同源 `/auth/login`。
- 服务端签发 HMAC-SHA256 Session Cookie；默认有效期 8 小时。
- Cookie 属性：`HttpOnly`、`SameSite=Strict`、`Path=/`；非回环域名强制 `Secure`。
- 用户名或密码变化会使旧 Session 立即失效。
- 退出登录会在服务端吊销当前 Session，复制出的旧 Cookie 也不能继续使用。
- 同一代理来源 15 分钟内连续失败 5 次会被限制 5 分钟，响应不泄露用户名是否存在。
- Cookie 身份下的非安全 HTTP 方法要求 `Origin` 与 `Host` 一致，降低 CSRF 风险。
- 页面不把口令写入 LocalStorage、URL 或客户端配置文件。

运行前必须配置用户级 `ARFORGE_SERVER_USERNAME` 和 `ARFORGE_SERVER_PASSWORD`。公网/局域网访问必须经过 HTTPS，后端保持监听 `127.0.0.1:4096`。

## 3. 私有 HTTPS

部署模板与验证步骤见 `deploy/private-https/README.md`：

- `Caddyfile.public`：自有公网域名，自动申请和续期公有证书。
- `Caddyfile.internal`：本机/私网测试，使用 Caddy 内部 CA。

Caddy 是唯一 443 入口，反向代理回环后端；访问日志删除 `Authorization`、`Cookie` 并脱敏旧查询令牌。正式启用仍需要最终域名、DNS/网络入口和服务运行账户三个部署坐标。

## 4. 验收与告警

每次发布至少验证：

1. 计划任务状态为 `Ready`，最近结果为成功；
2. 最新 `.dump.enc` 的 manifest、密文 SHA-256 和 HMAC 均通过；
3. 隔离恢复报告 `passed=true`、`mismatchCount=0`；
4. 临时数据库 `arforge_restore_drill_%` 数量为 0；
5. 非回环 HTTP 不可直接访问后端；
6. 登录 Cookie 在 HTTPS 响应中包含 `Secure; HttpOnly; SameSite=Strict`；
7. 证书自动续期、Caddy 日志轮转和磁盘剩余空间有监控。

当前脚本尚未主动发送备份失败告警；计划任务历史记录是最低可用信号。正式无人值守前，建议接入 Windows 事件日志告警或私人监控渠道。
