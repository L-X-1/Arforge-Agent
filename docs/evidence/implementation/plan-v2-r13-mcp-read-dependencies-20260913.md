# R13 / R07：MCP 显式只读依赖目录融合（2026-09-13）

## 1. 本批结论与边界

本批把 `read_only_paths` 从原标准 Config、原 TS CLI/HTTP writer、原 MCP 审批意图，接到原 SandboxPolicy/Runner 和 Windows SBOX `fs_read_only`。没有另造配置存储、supervisor、权限管理器、进程执行器或 Python 路径。

**已验证的是一项可用的显式授权能力，不是 MCP 整体完成。** 默认 Bun 1.3.14 全目录最终 **150 pass / 17 fail / 663 断言，167 项，115.57 秒，exit 1**。沙箱目录及启动诊断最终 **34 pass / 1 fail / 109 断言，35 项，8.43 秒，exit 1**。Bun 模块加载失败仍保留，不删除、不改成预期成功、不降低默认策略。

Node 使用显式 `--preserve-symlinks --preserve-symlinks-main` 参数，运行同一份打包 SDK MCP 服务器，经过原正式 MCP 服务、真实审批、原生只读授权、工具目录读取、disconnect/真实 PID 退出验证。不是自动把用户的 Bun 命令替换成 Node，也不是所有第三方 MCP 服务均已验收。没有启动 R31 三平台认证。

## 2. 唯一链路中的实现

| 原 owner / 文件 | 本批职责与保证 |
|---|---|
| `packages/core/src/config/mcp.ts` | 标准本地服务器增加唯一 `read_only_paths` 字段；共享 schema 拒绝空白、NUL、非字符串项及非数组。空数组明确清空附加读取目录 |
| `packages/core/src/v1/config/mcp.ts`、`migrate.ts` | 原运行时读投影及旧形状到标准形状的迁移保留相同字段；不设另一种命名或 writer |
| `packages/core/src/v1/config/config.ts` | enable-only override 明确要求 `type` 不存在，防止坏的完整服务器被降格为开关而误报保存成功 |
| `packages/arforge/src/config/config.ts` | 仍用原分层 merge 与 Core writer；按明确 `type` 判别，合法开关覆盖仍保留原服务器。高优先级读取目录替换低优先级列表，空数组不复活旧授权 |
| `packages/arforge/src/cli/cmd/mcp.ts` | 具名 `mcp add` 接受可重复 `--read-only-path`，保存原标准配置；远程服务器/缺名称/空值拒绝，不回显输入值 |
| `packages/arforge/src/mcp/index.ts` | 相对目录从 workspace 解析，不从自定义 cwd 解析；realpath、目录类型、device/inode 在原冻结 spawn 中保存，进入原保护性 HMAC 和审批资源 `read-only:<路径>` |
| 原 `spawnStdioTransport` | 使用冻结目录而非调用者之后修改的数组；执行前重新核对 realpath/目录类型/device/inode。漂移即拒绝，不启动新进程；已批准读取目录变化须新审批 |
| 原 SandboxPolicy / SandboxRunner | 附加 `readOnlyRoots` 与可写 roots 分开；无此字段保持原输出。显式附加只读目录在无法维持文件边界时 fail-closed，即使调用者未另设 requireEnforcement |
| 原 Windows launcher / SBOX encoder | 只读目录进入原 `fs_read_only` 字段，不放入 writable roots；路径规范化沿原逻辑。辅助程序本身也拒绝无 BaseContainer 却带只读目录的请求 |
| 原 SDK/OpenAPI generator | 从原 schema 重新生成，不手工维护平行类型；SDK 合同测试验证 Config PATCH 与 MCP add 都接受同一字段 |

Windows字段顺序核对来源：[Microsoft BaseContainerSpecification.fbs](https://github.com/microsoft/mxc/blob/main/external/windows-sdk/BaseContainerSpecification.fbs)。`fs_read_only` 是独立于 `fs_read_write` 的字段；无附加目录时保留原 FlatBuffer 布局。此处是 SDK 编码和本机真实探针证据，不是跨平台隔离认证。

授权语义：增加读权限不等于撤销已有写权限。如果目录已经位于可写 workspace 内，该字段不把原可写目录变成只读。没有自动扩大到父目录、整盘、用户目录或全部依赖缓存。执行前身份复核也不是 OS 原子句柄绑定，不能宣称消除了所有 TOCTOU 竞争。

## 3. 真实失败、修复和复验

### 3.1 原生 helper 不能忽略只读要求

新增独立测试直接调用原 helper，传入自建 sibling library、只读根及 `baseContainer:false`。修复前 helper 返回 **0**，违反必须拒绝的断言。修复后在 launchLegacy 前拒绝，stdout 为空，自建 library 的副作用文件不存在。

同组另两个独立子进程只在自己的环境中禁用 native/backend capability，直接装配原 SandboxRunner.Service：无附加目录和空数组维持旧 prepare 行为，非空显式读取列表返回原 UnavailableError。未修改父测试进程、用户环境或系统沙箱开关。

最初该组 **1 pass / 2 fail / 6 断言**：其中一项是测试误写无后端 enforcement 为 `none`，实际合同为 `unavailable`，已纠正测试；另一项才是上述 helper 真缺陷。最终该组三项全部通过，且包含在最后 35 项沙箱/诊断结果中。

### 3.2 HTTP 无效配置不再被解码成 enable-only override

正式 `Server.Default().app` PATCH→原 writer→文件→再次 GET，先证明中文/空格目录及清空列表的往返，再提交五类坏值并要求文件原文不变。

修复前空目录数组项配上 `enabled:false`，HTTP 返回 **200**，测试 **0 pass / 1 fail / 11 断言**。原 V1 union 退回 `{enabled:boolean}` 分支，静默丢弃完整服务器的坏字段。Core 独立回归也复现：带 type 的坏 server 被变成仅 `{enabled:false}`。

在原 V1 schema 里给开关覆盖增加 `type: optional Never`，原产品 merge/migrate 按 `type !== undefined` 判别；合法纯开关仍保持有效。最终 HTTP 专项 **1 pass / 20 断言**；扩大配置/CLI/HTTP/OpenAPI 批 **142 pass / 886 断言**。

Effect 的属性生成器不支持推导 optional Never，初次修复后因此出现 **62 pass / 1 fail**。仅给该 override 声明其真实合法生成形状 `{enabled:boolean}`，未删除或减小原 100 次随机迁移性质检查；最终 Core 扩大批 **63 pass / 236 断言**。

### 3.3 Bun 编译夹具与 MCP 运行必须分开记账

原同进程重复 `Bun.build` 在第二次编译出现 EISDIR、SDK/Zod 文件被读作其他模块内容；Node 那项尚未启动 MCP 就在编译处失败。四项专项原为 **2 pass / 2 fail / 18 断言**，不能据此说 Node 原生 MCP 不可用。

夹具改为原 ChildProcess/CrossSpawnSpawner 中的独立、作用域管理的 Bun 编译进程，仍构建同一个真实 SDK 服务器，有 30 秒编译边界。没有替换 server 协议或修改被测运行时；Bun 运行用例仍用原 `process.execPath`，Node 用例仍是显式 Node 参数。修后五项联合筛选 **3 pass / 2 fail / 33 断言**：Node、目录身份漂移、非法目录均通过，两个 Bun 加载用例仍失败。

最后只读授权三项专项 **3 pass / 25 断言 / 9.76 秒**；其中 Node 从审批前零 marker、冻结目录、真实连接与工具目录、断开后进程退出，到改读取授权后的新 ask/reject 均通过。第一次最后全目录从 149/18 变成 150/17，是消除一个夹具编译失败，不是修好一类 Bun 运行问题。

### 3.4 本机权限行为与运行时限制

原 native 子进程能读取自建已授权依赖文件，不能写回该文件，不能读取相邻未批准文件；父测试复核两文件内容未变。相同只读目录内的 Bun 模块入口仍无法加载。Bun 1.3.14 报 CouldntReadCurrentDirectory；前序隔离候选 Bun 1.4.2 能运行授权可写 cwd 内的 SDK 包，但只读目录的 module/readdir 仍失败。相同读取授权下 Node 的目录读取对照正常。

这些结果不能合并为“升级 Bun 即全部修复”，也不能为了模块加载增加写权限。Bun 候选来源、摘要和前序原生启动修复见[原启动证据](./plan-v2-r13-windows-mcp-startup-20260913.md)。本批没有升级项目固定 Bun 或全局运行时。

## 4. 最终检查记录

环境：Windows 本机、项目固定 Bun 1.3.14、独立测试 profile/SQLite/目录/真实本地子进程。测试不使用真实远程 MCP/模型账号。各批有重叠，不能相加当独立覆盖率。

| 运行目录 / 命令 | 实际结果 |
|---|---|
| `packages/core`：`bun test --rerun-every test/config/config.test.ts test/config/config-write.test.ts test/config/provider.test.ts test/config/provider-options.test.ts test/sandbox/policy.test.ts` | **63 pass / 0 fail / 236 断言 / 2.32 秒，exit 0** |
| `packages/arforge`：`bun test --timeout 60000 test/config/config.test.ts test/server/httpapi-config.test.ts test/server/httpapi-mcp-read-paths.test.ts test/server/httpapi-public-openapi.test.ts test/cli/mcp-add.test.ts` | **142 pass / 0 fail / 886 断言 / 104.46 秒，exit 0** |
| `packages/arforge`：`bun test --timeout 60000 test/mcp/local-approval.test.ts -t 'explicit read dependencies.*node\|replacing an approved read\|invalid explicit read'` | **3 pass / 0 fail / 25 filtered / 25 断言 / 9.76 秒，exit 0** |
| `packages/arforge`：`bun test --timeout 60000 test/mcp` | **150 pass / 17 fail / 663 断言 / 115.57 秒，exit 1**；之前同批 111.33 秒结果相同，最终结果以上行时间为准 |
| `packages/arforge`：`bun test --timeout 60000 test/sandbox test/mcp/startup-diagnostic.test.ts` | **34 pass / 1 fail / 109 断言 / 8.43 秒，exit 1**；失败为原生只读依赖目录中的 Bun 模块加载 |
| 根目录：`bun run script/generate.ts` | **exit 0**；原 SDK 编译及最终 OpenAPI 生成完成，保留生成器现有 deprecation 提示 |
| `packages/sdk/js`：`bun test` | 最终生成后 **4 pass / 0 fail / 6 断言 / 33 毫秒，exit 0** |
| 根目录：`bun turbo typecheck --concurrency=2 --force` | **22/22，0 cached，49.209 秒，exit 0** |
| 根目录：25 个本批源/测试文件 Prettier check；同范围及用户指南 diff-check | **exit 0**；不把整个历史脏树差异归为本批改动 |
| 根目录：同 25 个源/测试文件 Oxlint | **66 warnings / 0 errors，exit 0**；警告未清零，不称整仓 lint 达标 |

类型检查曾先因新编译夹具把 branded ExitCode 与裸数字比较、以及 type optional 后两处旧判别未收窄而失败，均在原接口内修正。另一次强制 workspace 检查因 SDK `tsconfig.tsbuildinfo` 的 Windows mapped-file 锁失败（9/22）；确认没有仍存活的生成/类型检查进程后，SDK 单包及上述最终强制全工程复验通过。未删除用户文件、关闭系统保护或伪造缓存通过。

原始结果位于本任务工具执行记录：最终 Core `a132fb`、产品扩大批完成 `daa747`、HTTP 修前 `af3d96`、HTTP 修后 `d70f4b`、最终 MCP 完成 `7d605c`、沙箱 `910c1e`、最终强制类型完成 `fd9df4`、lint `76cc4b`。这些是当前任务执行记录标识，不是另存到磁盘的全量日志文件。

## 5. 用户使用说明与剩余工作

已在原 [USER_GUIDE](../../USER_GUIDE.md) 增加 TS CLI 示例、字段保存位置、相对目录基准、审批与重新审批、已存在写权限不被撤销、后端不足时拒绝，以及 Windows/Bun 的真实限制。文档没有承诺任意第三方服务器可用。

下一步仍按原计划推进：

1. 项目 Bun 与原 Windows MCP 正式启动兼容、只读/跨目录/非系统卷依赖加载；保持现有失败回归，不扩大权限或擅自降级。不把此问题等同于提前进行三平台认证。
2. 原标准 `mcp.timeout.startup/request` 到 supervisor 的完整消费仍未统一，目前 V1 投影仍主要映射 request；交互式带引号命令、其他配置 writer/显式文件、模板/托管来源和完整 UI 仍有未完成项。
3. 回到原 PersonalJob：活跃 run 的部分用量/未结算费用、原预算与当前授权、PersonalJob 自身 SIGKILL→新进程恢复。已完成结果补记不等于这些已完成。
4. R04/R06/R07/R09/R13/R17/R23/R30 保持开放；其他 v2 工作包退出条件没有被本批缩减。R31 真实三平台 full sandbox 仍仅在 R30 后执行，不涉及发布。

## 6. 源码与证据绑定

- composition：`c51a341cdb66e78771636d6c37004913ff424dca5aad4792c83fe4f1a8b984f3`（1757 源文件、3 roots、5 bindings、3 Runner uses）。
- runner-negative：`7f7e2d75ad3e9e725baeb7ae181cf6e2075c4aeb22c7d27ff7629e2070926172`。
- dependencies：`184dcd6a76e3273109936831445ae67a30983df4fb05d0252d4a91b44419f16c`（7289 文件、7490 叶、6 assets）。
- 本文和桌面同步完成后，由原 source-snapshot 生成器绑定最终输入，再运行 migration-freshness。静态 valid 不替代功能验收；既有 capability link 的未验收/缺 receipt 项仍不能改成已完成。

安全自检：没有修改真实账户、凭据、业务数据库、PATH、全局 CLI、Bun 固定版本或系统策略；未创建平行 owner、子代理、提交或推送，未恢复旧任务卡协议。只清理测试自行创建的资源，保留工作区已有改动。
