# Arforge Windows 内部 Alpha 发布手册

内部 Alpha 只用于开发者和受控测试者验证安装、启动、模型调用和卸载。它未经代码签名，不能放到官网或公开传播，自动更新也保持关闭。

## 1. 准备发布快照

正式 Alpha 必须来自干净、可追溯的 Git 提交：

```powershell
git status --short
git rev-parse HEAD
```

`git status --short` 必须没有输出。不要用 `-AllowDirty` 绕过正式发布；该参数只用于本机排练，并会在清单中记录 `dirty: true`。

## 2. 本机生成 Alpha

在仓库根目录执行：

```powershell
.\scripts\build_internal_alpha.ps1
```

脚本依次执行桌面构建、Windows NSIS 打包、SHA-256 清单生成和二次验证。输出位于：

```text
packages/desktop/dist/arforge-desktop-win-x64.exe
packages/desktop/dist/internal-alpha-manifest.json
packages/desktop/dist/SHA256SUMS.internal-alpha
```

只排练现有安装包和证据生成时：

```powershell
.\scripts\build_internal_alpha.ps1 -SkipBuild -AllowDirty
```

## 3. 独立验证下载包

将三个文件放在同一个目录，然后执行：

```powershell
.\.venv\Scripts\python.exe scripts\desktop_alpha_artifacts.py `
  --output-dir packages\desktop\dist `
  --verify
```

也可以人工比对：

```powershell
Get-FileHash packages\desktop\dist\arforge-desktop-win-x64.exe -Algorithm SHA256
Get-Content packages\desktop\dist\SHA256SUMS.internal-alpha
```

两个 SHA-256 必须完全一致。

## 4. 在 GitHub 生成干净快照

1. 打开仓库的 **Actions** 页面。
2. 选择 **Desktop internal Alpha**。
3. 点击 **Run workflow**，选择需要验证的分支。
4. 等待 `Build unsigned Windows internal Alpha` 通过。
5. 下载 `arforge-desktop-internal-alpha-<run_id>`，不要单独转发 EXE。

工作流只允许手动触发，产物保留 14 天，不会创建 Release，也不会部署官网。

## 5. 安装验收

优先使用没有生产数据的 Windows 测试账号或虚拟机：

1. 校验 SHA-256 后运行安装器；Windows 可能显示未知发布者，这是内部 Alpha 的已知限制。
2. 首次启动，确认界面版本、工作区选择和本地 Sidecar 正常。
3. 使用测试模型凭据完成一次真实提示词调用，不使用生产凭据或生产数据。
4. 退出并重新启动，确认测试会话按设计恢复。
5. 导出调试日志，确认日志不包含 API Key、密码或完整认证令牌。
6. 卸载应用，确认程序文件被移除；用户数据是否保留必须与本轮测试记录一致。
7. 记录安装包 SHA-256、Git commit、测试人、时间和结果。

## 6. 阶段完成条件

- GitHub 与本机至少一条干净快照构建通过；
- Desktop 行为测试全部通过；
- 安装包、Manifest、SHA256SUMS 三者齐全且验证通过；
- 在隔离 Windows 环境完成安装、启动、真实调用、重启和卸载；
- 所有测试者明确知道它未签名、无自动更新且禁止公开传播。

完成这些条件后，进入下一阶段：受保护 Runner、Authenticode/RFC 3161 时间戳、签名候选与限量 Beta 下载。
