# Arforge 私有 HTTPS 反向代理

这里提供 `docs/PRIVATE_HTTPS_DEPLOYMENT.md` 中 Option 2 的可执行 Caddy 配置。
Arforge 只监听 `127.0.0.1:4096`；Caddy 是唯一的 443/TLS 入口。

## 1. 启动统一服务

先在 `C:\Users\<用户名>\.arforge\.env` 配置高熵
`ARFORGE_SERVER_PASSWORD`，再从仓库根目录运行：

```powershell
.\scripts\run_cli.ps1 serve --hostname 127.0.0.1 --port 4096
```

不要把后端监听地址改为公网地址。

## 2. 选择证书模式

| 模式 | 配置 | 适用范围 |
| --- | --- | --- |
| Internal | `Caddyfile.internal` | 本机、私有 LAN、开发测试；客户端需信任 Caddy 私有 CA |
| Public | `Caddyfile.public` | 自有域名；DNS 指向服务器，由 Caddy 自动申请和续期证书 |

验证配置不会启动或重启任何进程：

```powershell
.\deploy\private-https\validate-private-https.ps1 `
  -Mode Internal `
  -Domain arforge.localhost
```

运行 Internal 模式：

```powershell
$env:ARFORGE_DOMAIN = "arforge.localhost"
caddy run --config .\deploy\private-https\Caddyfile.internal --adapter caddyfile
```

Public 模式必须使用你控制的真实域名，并开放 TCP 80/443。正式使用时应把 Caddy
注册为受限 Windows 服务，使配置、证书存储和日志目录仅允许管理员及服务账户写入。

## 安全不变量

- Caddy 配置和仓库中不保存数据库密码、登录密码或证书私钥。
- 日志删除 `Cookie`、`Authorization`，并脱敏旧式 `auth_token` 查询参数。
- Arforge 的 4096 端口只允许回环访问；LAN/公网只访问 443。
- 不使用 `tls_insecure_skip_verify`。
- HTTPS 不能替代 Arforge 登录；两层必须同时启用。
