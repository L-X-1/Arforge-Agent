# Arforge 私人产品运行基线

状态日期：2026-07-27  
唯一产品主线：`E:\Arforge-Agent`

## 1. 已确认的运行边界

- Desktop、CLI、Web UI 和 TypeScript Server 均从本仓库构建。
- Electron Desktop 启动本机回环 Sidecar，使用每次启动生成的随机 Basic Auth
  密码；密码只在主进程和 Sidecar 之间传递。
- CLI 与 Desktop 在同一 PostgreSQL 会话上完成了真实双端读写验证。
- 统一私有配置文件是 `%USERPROFILE%\.arforge\.env`；显式进程环境变量优先，
  开发工作区 `.env` 只在用户配置不存在时作为回退。
- 自动更新、公共发布、签名、官网和公共托管不属于本次重构范围。

## 2. 数据库边界

- 正式数据源是本机 PostgreSQL 的 `arforge` 数据库。
- `arforge_app` 是唯一应用运行角色，只具备连接、Schema 使用、业务表读写和
  序列权限。
- `arforge_app` 不具备超级用户、建库、建角色、复制、绕过 RLS、Schema 建表或
  临时表权限。
- 管理角色只用于建库、迁移与隔离恢复演练，不持久化到产品私有配置。
- 2026-07-27 的恢复演练覆盖 45 张表，生产/恢复各 58 行，差异为 0，临时数据库
  已清理。

## 3. 私有身份边界

- Web UI 已具有 Arforge 自有登录页。
- Server 已具有签名 Session Cookie、失败限速、注销吊销和 Cookie/Origin 安全
  边界。
- 本机 Desktop 仍优先使用进程内随机凭据，不把长期服务密码写入渲染进程。
- 外网 HTTPS、域名和证书部署未执行；这是部署阶段，不影响当前本机重构验收。

## 4. 当天可用入口

开发桌面端：

```powershell
E:\Arforge-Agent\.tools\bun-1.3.14\bun.exe run dev:desktop
```

CLI：

```powershell
E:\Arforge-Agent\.tools\bun-1.3.14\bun.exe --conditions=browser `
  E:\Arforge-Agent\packages\arforge\src\index.ts
```

这两个入口共用用户私有配置和 PostgreSQL，不再要求参考工程存在。

## 5. 三种后续方案

| 方案 | 范围 | 优点 | 缺点 | 当前建议 |
| --- | --- | --- | --- | --- |
| A 本机私人版 | 单台 Windows 设备 | 攻击面最小、无需域名 | 不能跨设备 | 当前采用 |
| B 私有远程版 | 自有设备/少量受邀者 | 可跨设备、仍可控 | 需要 HTTPS、告警和运维 | 重构完成后再做 |
| C 公网产品版 | 公开用户 | 覆盖面最大 | 多租户、RLS、合规和发布成本高 | 当前不做 |

## 6. 当前完成标准

- [x] Desktop 与 CLI 共用 PostgreSQL 会话事实源。
- [x] 应用角色通过最小权限读写回环审计。
- [x] 加密备份可在隔离空数据库恢复并逐表对账。
- [x] 私有配置不依赖父进程偶然注入。
- [x] 目标工程使用自身 Bun/Electron 启动。
- [ ] 全仓不存在外部参考目录的运行依赖。
- [ ] 品牌、来源、旧入口等价和全量回归最终审计通过。

发布、安装器、代码签名、官网与公共托管明确不作为本阶段完成条件。
