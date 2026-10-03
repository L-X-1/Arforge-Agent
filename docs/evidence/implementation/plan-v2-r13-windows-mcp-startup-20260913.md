# R13 / R07：Windows MCP 启动与 stderr 管道实证（2026-09-13）

## 1. 范围与结论

继续桌面 v2.0 计划 R07 的配置/恢复工作中暴露的 R13 本地 MCP 启动问题。本批修复原 Windows launcher 的 HRESULT 判断、标准流结构偏移，以及原 MCP 连接的 stderr 无消费者问题。没有另建 launcher、supervisor、权限服务或 Python 路径。

**默认 MCP 仍未达到交付标准。** 最后默认 Bun 1.3.14 / 原 Windows BaseContainer 路径：146 pass / 16 fail / 631 断言，162 项，158.09 秒。新增的授权目录内完整服务器测试揭示了现有运行时不兼容，因此比历史目录多一项明确失败；没有删除、跳过或改低原 15 项失败的断言。

本批属于本地 MCP 基本可用性，不是 R31 的真实三平台 full sandbox 认证。未改全局 Bun、PATH、CLI、系统策略、权限或真实业务数据；项目仍固定 Bun 1.3.14。

## 2. 原生修复与定位证据

### 2.1 HRESULT 成功值不再误判

原 `DeleteAppContainerProfile` 声明为 bool，并按零失败处理，真实诊断出现 `Win32 error 0`。改为 i32 HRESULT，负值才是失败，不再读不适用的 GetLastError。删除不存在的本批 profile 也是成功；身份名称限制保持。合同来源：[Microsoft DeleteAppContainerProfile](https://learn.microsoft.com/en-us/windows/win32/api/userenv/nf-userenv-deleteappcontainerprofile)。

`windows-cleanup.test.ts` 通过真实已结束的自建进程、随机本批 profile 名称和独立目录验证：cleanup 返回 0、只移除自己创建的 temp、邻接测试文件保留。修复前 0 pass / 1 fail，修复后通过。没有针对任意用户 PID 或 profile 执行清理。

### 2.2 标准输入输出结构修复

原两个 launch 分支将 64 位 STARTUPINFOW 的 dwFlags 写在 byte 68，而不是 byte 60，导致 stdout/stderr 丢失。现在共用一个 startupInfo 构建函数，在 60 写 STARTF_USESTDHANDLES，原标准句柄仍在 80/88/96；SetHandleInformation 的失败现在可观察。kernel32 符号复用，避免读取 GetLastError 时重新 dlopen 改变原错误。结构来源：[Microsoft STARTUPINFOW](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/ns-processthreadsapi-startupinfow)。

真实原 native runner 验证带空格/中文 stdin、stdout、stderr 与退出码 23 完整保留。中间曾将实验 API 的 inherit_handles 设为 1，宿主返回 ERROR_NOT_SUPPORTED（50）；已恢复为 0，显式标准句柄仍工作，与 [Microsoft MXC BaseContainer runner](https://github.com/microsoft/mxc/blob/main/src/backends/appcontainer/common/src/base_container_runner.rs) 的调用一致。没有以普通 CreateProcess 的参数假设覆盖该实验 API。

边界：本批纠正已观察到的错误清理误报，不代表所有 native finally 中的真实清理失败聚合、PID 重用和全部清理攻击面已审查完毕。跨平台 enforcement 不由这些测试推导。

### 2.3 运行时兼容性不是扩大权限的理由

同一个原 prepareCommand、相同显式授权目录、相同最小环境下：

- Bun 1.3.14+0d9b296af 能读 cwd、打开当前目录句柄，但 readdir 返回 EBADFD。
- Node v24.16.0 能列同一目录；二者的用户态 realpath 都在驱动器根路径得到 EPERM。
- cwd 字符码核对正常，没有多出的反斜杠。最初“只是外部依赖越界”的归因不足：把原 SDK 服务器完整打包到授权 cwd 内，Bun 1.3.14 仍报 CouldntReadCurrentDirectory。

上游 [Bun #33119](https://github.com/oven-sh/bun/pull/33119) 于 2026-07-20 合并，针对 AppContainer 的父目录读取、Windows 文件打开和内部路径解析做了修复；其中非系统卷仍有已说明限制。该资料解释了本地对照，但不能代替 Arforge 自己的正式入口测试。

只在独立临时目录下载并解压官方 [Bun 1.4.2](https://github.com/oven-sh/bun/releases/tag/bun-v1.4.2) Windows x64 归档，执行前核对 GitHub release digest：

```text
version: 1.4.2+744846f84
archive sha256: ce4c17497b2f29712a99d3d53f028de28cd42e3bacb8589599e7f000e49b6405
```

使用该候选二进制运行原授权目录内 SDK MCP 用例，连接、工具目录和断开后真实进程退出通过；增强为启动及初始化后均写大 stderr 的原 SDK 用例后，连同安全失败旅程为 2 pass / 14 断言 / 6.22 秒。审批前无 marker，原 Gateway/stdio/client/supervisor 均未替换。

候选二进制的较早完整目录为 140 pass / 15 fail / 607 断言 / 136.11 秒（155 项，尚未加入本批 7 项日志检查），**并非最终源码全量通过**。原跨目录入口用例在最终代码上仍失败，0 pass / 1 fail / 4.79 秒，且并未得到可分类的 stderr。不能断言所有剩余失败只有同一个原因，也不能直接宣称升级到 1.4.2 即修好 MCP。

## 3. stderr 管道融合与用户错误提示

原 `StdioClientTransport({ stderr: "pipe" })` 创建了 PassThrough，但连接流程没有消费者；大量日志会反压到子进程。已融合到原 `spawnStdioTransport → connectTransport`：

1. 在 SDK connect 前订阅既有 stderr，不新建进程或流管线。
2. 按 4096 字节窗口识别固定错误类别，只保留 192 字符尾部识别跨 chunk 标记；不缓存全部输出。
3. 只允许当前目录、模块不可用、原生启动三类固定中文提示进入错误状态。任意日志正文、路径、环境值、栈文本不进入这些新诊断。
4. 成功/失败/中断均撤下分类监听、清空临时尾部；成功后仍排空 stderr，避免后续日志阻塞协议。进程关闭、取消和重试继续由原 transport/supervisor 拥有。
5. 保留首个已经分类的错误；后续清理错误不覆盖它。没有匹配到固定标记时保留原连接错误，不凭空猜测缺权限或升级已成功。

正式负例使用原 MCP add→needs_approval→批准→原 native 子进程：子进程写 512 KiB 日志及假凭据标记后报目录错误。修复前无法到达 failed（17.23 秒，1 fail）；修复后及时失败、提示可读、错误长度有界、durable action 不含假凭据、工具为空、disconnect 后 disabled（8 断言）。这不是只测纯 helper。

原 `mcp-lifecycle-stdio.ts` 新增可选噪声 fixture，分别在 connect 前和真实 SDK tools/list 返回前等待大 stderr 写完。授权目录内打包用例继续使用此原服务器，未替换成自制协议 stub。默认旧 Bun 的加载失败仍保留。

## 4. 最终验证记录

| 范围                                 | 结果与限制                                                                                  |
| ------------------------------------ | ------------------------------------------------------------------------------------------- |
| 默认原 Sandbox 测试目录 + 新诊断单测 | 28 pass / 0 fail / 84 断言 / 6.03 秒；含本机 native stdio、清理、原取消回归，不是三平台认证 |
| 默认 MCP 全目录                      | 146 pass / 16 fail / 631 断言 / 158.09 秒，162 项；必须保留失败                             |
| 同源码 partial 子进程对照            | 162 pass / 0 fail / 674 断言 / 96.57 秒；只是既有 partial 后端诊断，不是默认或 full 验收    |
| 候选 Bun 1.4.2 的两个正式专项        | 2 pass / 0 fail / 14 断言 / 6.22 秒；不得代替默认运行时或跨目录用例                         |
| Arforge typecheck                    | 最终退出 0；修复了 SDK stderr 声明为 Stream 而不是 Readable 的类型问题                      |
| 强制全 workspace typecheck           | 22/22，0 cached，48.955 秒                                                                  |
| 八文件格式及已跟踪变更 diff-check    | 通过；untracked 原 sandbox/transport 文件亦单独格式化和实测，不只依赖 git diff              |
| 八文件 scoped lint                   | 53 warnings / 0 errors，包含既有原生 finally/FFI 和测试警告，未称清零                       |

中间测试也保留：首次新诊断单测因尚无实现报 export 缺失；一次宽泛名字筛选额外选中了既有失败的 startup 用例；一次纯流测试把 resume 后立即清空当同步行为，改为等待 stream end 就绪信号，不增加任意 sleep。曾误用不存在的 local-cwd.test.ts 路径，命令退出 1、未计入通过，后改用实际 lifecycle.test.ts 用例。

复验命令（前两条在 packages/arforge，最后一条在根目录）：

```text
bun test --timeout 30000 test/sandbox/ test/mcp/startup-diagnostic.test.ts
bun test --timeout 60000 test/mcp/
bun turbo typecheck --concurrency=2 --force
```

对照的 partial 仅通过测试子进程 env 的 ARFORGE_SANDBOX_DISABLE_BASE_CONTAINER=1 选择，不更改全局或默认配置。最终 162 pass / 0 fail / 674 断言 / 96.57 秒，不能混入默认验收。

## 5. 下一步与仍未关闭事项

- 默认 MCP 启动仍开放。分别验证项目运行时升级兼容性、跨目录/非系统卷入口和依赖的实际读取需求；原 Config/SandboxPolicy/Gateway 必须绑定显式授权，不为通过测试而授予整盘或任意父目录读取，也不自动改用 partial。
- MCP startup/request 两种 timeout 的标准字段仍未完整接通；继续原 TS 配置、旧 CLI/TOML writer、带引号交互命令等融合，不另设标准。
- 然后继续活跃任务部分用量/未结算账单、原预算/当前授权恢复及 PersonalJob 自身强杀→新进程恢复。已完成 run 的结果补记不替代这些验收。
- R04/R06/R07/R09/R13/R17/R23/R30 均保持开放；其他工作包的退出条件未缩减。R31 仍仅在 R30 后执行，不涉及发布。

源码快照和迁移新鲜度使用原 composition/runner-negative/dependency/source-snapshot 工具在最后文档同步后生成；这些静态结果不证明上述默认 MCP 失败已解决。规则自检：仅原 TS 实现、隔离测试、证据和指定桌面计划；未修改真实账号/数据库/全局入口/系统权限，未提交或推送，未启用子代理。
