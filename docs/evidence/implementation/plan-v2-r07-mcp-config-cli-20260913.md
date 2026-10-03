# R07：MCP CLI 标准配置保存、分层合并与子目录重新加载

日期：2026-09-13。接续[配置保存与 Core 重新加载](./plan-v2-r07-config-save-reload-20260913.md)。涉及 R04 的 CLI 融合和 R13 的 MCP 消费入口，但不关闭这些工作包。本文记录连续开发批次的实码、失败及验证边界；不是全计划交付证明。

## 1. 本批融合到已有 owner 的内容

1. `packages/arforge/src/cli/cmd/mcp.ts` 删除独立的配置文件选择、JSONC 修改与直接写入函数。交互和非交互添加均进入原产品 Config.update/updateGlobal，再调用原 Core Config.updateDocument；没有新增 MCP 配置服务、writer 或 supervisor。
2. 保存标准 `mcp.servers.<name>`，文件由 Core writer 选择，成功提示显示实际路径。非交互调用尊重 ARFORGE_CONFIG_DIR；无需初始化项目实例就能做全局添加。交互项目保存传入原 worktree，而不是另行查找文件。
3. Core 原 decodeDocument 接受 MCP-only 旧拼写、标准拼写和同文件混合拼写，保留原有文档顺序与路径。旧名为 servers/timeout 的服务器不会直接被当作保留字段。旧 enabled 覆盖迁成 disabled；标准无 type 的 disabled 覆盖可保留低优先级定义。
4. 明确无效 MCP 配置在解码时失败，不因字段被忽略或退化为 disabled 覆盖而偷偷通过。错误不回显原配置内容。Schema 的 Override 限制显式 type，避免 `{type:"local",command:12,disabled:false}` 错误地匹配仅开关分支。
5. 原产品 Config reader 通过现有 TS V1 兼容模块把标准配置投影给原 MCP supervisor；映射 disabled、OAuth snake_case 和 request timeout。**这仍是迁移中的只读兼容投影，不是已完成所有标准配置消费者退役。startup timeout 尚未完整接入 supervisor。**

### 保存与分层读取的语义不能混为一谈

- 单次保存完整服务器定义：Core patch 在 `mcp.servers.<name>` 原子替换完整定义，避免 CLI 重设地址后保留旧 header/OAuth。仅开关 patch 仍合并。这与旧 CLI 的整份服务器保存语义一致；重新添加完整定义不承诺保留未提供的 disabled。
- 不同文件或新旧拼写的分层读取：同一 remote URL、或同一 local argv/cwd 保留既有分层字段合并；只有开关的覆盖仍继承。更换 URL、进程命令或 cwd 时，新定义不继承旧服务器的凭据/环境。
- 最初将所有完整定义一律替换，破坏了原有同地址分层测试。已在原 mergeConfig 内修复，并让同文件新旧拼写也复用这个合并入口，不维护第二套合并逻辑。
- 以上没有全面完成 OAuth credential identity 的所有分层变化语义。配置中的旧拼写也未全部物理移除，不能据此宣称全仓只剩一种历史文件格式。

## 2. 用户路径与真实失败复现

### TS CLI 子进程

`test/cli/mcp-add.test.ts` 共 7 项：实际新进程启动原 TS CLI，分别验证远程 URL/header、local argv/environment、JSONC 高优先级/注释/无关字段保留、指定配置目录、两个 CLI 进程并发保存不丢双方服务器、坏 JSON 不改原文、不回显非法 URL/header 输入。

服务器地址替换专项先失败：原 endpoint 的 header 留在新地址配置内。修复后 header/OAuth 的旧 fixture 值不再残留于替换后的服务器定义。JSONC 保存后的原 `mcp list` 实际读到该服务器；测试在保存后显式将自己的服务器 fixture 禁用，避免连接虚构地址，**不是活服务器连接验证**。

### 默认服务器 HTTP

- 实际 GET /config 打开原标准 MCP 文档，PATCH 通过既有接口保存新地址，等待原 instance.disposed，重新 GET。旧 endpoint header 不再出现，username 保留，磁盘是标准 mcp.servers；fixture 全程 disabled，不作远程外发。
- 新增项目根目录保存→已经打开的 nested 目录重新读取测试。修复前 PATCH=200，但 nested 仍返回 before（1 fail / 7 断言 / 7.19 秒）。原 Config.update 现在同时失效其 ScopedCache 中受影响的后代目录，与既有 Core LocationServiceMap 对齐；不另建缓存。修复后 nested 返回 after，另一个项目仍返回 unrelated（1 pass / 9 断言 / 7.10 秒）。
- 这一测试证明配置重新读取，不代表所有已经运行的 MCP client、插件 hook、UI 状态都已在同一时刻重建；活跃任务撤权和资源排空仍是后续范围。

### SDK/OpenAPI 生成

原 `script/generate.ts` 的第二步 shell 重定向实际失败：`bun: unknown error: ../sdk/openapi.json`。现同一生成脚本先取得原 CLI generate 输出，解析并检查 OpenAPI 文档形状，然后写入既有生成产物；不在子命令成功前打开目标文件，保留原 scoped formatter。重新完整生成 exit 0，SDK 三文件测试通过。生成器只刷新原可重建 SDK/dist/OpenAPI 产物，没有产品发布操作。

## 3. 必须保留的默认 Windows MCP 失败

默认环境 `bun test --timeout 60000 test/mcp/`：**139 pass / 15 fail / 601 断言 / 164.37 秒**。失败主要在真实本地 stdio 启动、批准后连接和进程清理场景。不能用配置/CLI 139 项通过覆盖这批失败。

单项独立重现 `local mcp cwd`，增强原测试诊断后直接看到 `MCP error -32000: Connection closed`，而不是只等超时（0 pass / 1 fail / 5.66 秒）。只读宿主探测选择 windows-native/BaseContainer；隔离临时目录内沿原 prepareCommand + SDK stdio 诊断，stderr 显示现有 windows-launcher 的 DeleteAppContainerProfile 误报 `Win32 error 0`。

实码将该 API 声明为 bool，并把零当失败；[Microsoft 原始合同](https://learn.microsoft.com/en-us/windows/win32/api/userenv/nf-userenv-deleteappcontainerprofile)规定它返回 HRESULT，S_OK 表示成功，删除不存在的 profile 也成功。这是明确的原生启动/清理链缺陷；清理错误还可能掩盖前面的启动错误，**尚不能断言已完全定位全部 15 项的原因**。本批未修改原生后端、未自动降级、未调整全局环境或系统权限。

仅对诊断子进程设置 `ARFORGE_SANDBOX_DISABLE_BASE_CONTAINER=1`，让原 runner 使用现有 partial 路径，同一 local cwd 用例通过（1 pass / 2 断言 / 5.84 秒）。随后同一 MCP 全目录对照为 **154 pass / 0 fail / 641 断言 / 107.32 秒**，涵盖真实 stdio、审批、取消、远程 HTTP、重连及既有冷进程恢复夹具。该诊断不能替代默认环境或 full enforcement 验收，原失败没有被删除、skip 或改写成通过。

R31 三平台 full sandbox 仍按用户要求在 R30 后执行。**当前宿主 MCP 默认启动缺陷仍是交付缺项，不因诊断切换后可运行就移入“已完成”。** 后续须修复基础启动与诊断链，不能将降低保护作为修复，也不能把只读 API 探测当作完整 OS 验证。

## 4. 已结束的验证

Windows / Bun 1.3.14；以下不同范围及重叠批次不换算百分比。

| 范围                                                  | 已结束结果                                                                                                          |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| 产品配置完整文件 + CLI + HTTP config + public OpenAPI | 139 pass / 0 fail / 858 断言 / 113.14 秒；107 配置、7 CLI、7 HTTP config、18 OpenAPI                                |
| Core config/writer/provider/options 四完整文件        | 56 pass / 0 fail / 203 断言 / 2.18 秒，显式 rerun-every                                                             |
| Formal PersonalJob 与 title config 筛选               | 33 pass / 0 fail / 167 filtered / 564 断言 / 219.18 秒                                                              |
| Formal scoped/compaction/credential 筛选              | 11 pass / 0 fail / 189 filtered / 137 断言 / 45.60 秒；与上行分别运行，未以此声明完整 prompt 文件通过               |
| SDK 三文件                                            | 3 pass / 0 fail / 5 断言 / 24 ms                                                                                    |
| 原 SDK/OpenAPI 全生成                                 | exit 0；原生成器有 instance 选项弃用提示，未声称无警告                                                              |
| 强制 workspace typecheck                              | 22/22 successful、0 cached、55.475 秒；不是全仓测试通过                                                             |
| scoped 格式与 diff-check                              | 13 个源/测试/脚本全部通过，生成产物 diff-check 通过                                                                 |
| scoped oxlint                                         | 17 warnings / 0 errors：原 MCP CLI 4、原 lifecycle 2、原产品 config 测试 11；新增修改范围无告警，不是整仓 lint 清零 |
| 默认 MCP 全目录                                       | 139 pass / 15 fail，必须与配置批次的 139 pass 区分                                                                  |
| MCP 全目录 partial 诊断                               | 154 pass / 0 fail / 641 断言 / 107.32 秒；只对诊断子进程设置开关，不改变默认失败结论                                |

中间失败记录：旧同地址分层语义回归导致一批 126 pass / 1 fail，修复后专项 7 pass / 17 断言；根目录缓存缺陷又在较早启动的扩大批复现（137 pass / 1 fail），最终修复后的 139 项完整批已通过。类型检查最初出现 fixture 返回结构、CLI builder 推导问题，均已修复，最终强制全工作区结果如上。两次格式命令路径与 cwd 不匹配，未被当作通过；最终在仓库根目录按明确文件列表复查通过。

复验命令（对应包目录）：

```text
# packages/core
bun test --rerun-every test/config/config.test.ts test/config/config-write.test.ts test/config/provider.test.ts test/config/provider-options.test.ts

# packages/arforge，默认环境，MCP 批已知失败，不可隐藏
bun test --timeout 60000 test/config/config.test.ts test/server/httpapi-config.test.ts test/server/httpapi-public-openapi.test.ts test/cli/mcp-add.test.ts
bun test --timeout 60000 test/mcp/
bun test --timeout 60000 --test-name-pattern 'Formal PersonalJob|Formal saved|Formal.*config|Formal.*price' test/session/prompt.test.ts
bun test --timeout 60000 --test-name-pattern 'Formal scoped execution|Formal compaction HTTP|Formal credential billing boundary' test/session/prompt.test.ts

# packages/sdk/js
bun test

# root
bun run script/generate.ts
bun turbo typecheck --concurrency=2 --force
bun run audit:migration-freshness
```

## 5. 下一步与未完成范围

1. 原 Windows MCP 启动/清理错误及可读诊断；默认完整目录尚未通过，不关闭 MCP 运行验收。不提前做三平台认证，也不降级默认策略。
2. 继续原 TS 标准配置与消费者融合：MCP startup/request 完整消费、agents/skills/compaction、显式文件/模板/托管来源、剩余 CLI/TOML writer、手工文件监听。交互 MCP 命令仍使用旧空格切分，带引号命令的交互旅程未验收；本批不能说所有用户设置方式已完善。
3. 活跃任务的配置保存/撤权、部分用量与未结算账单、原预算/当前授权恢复；随后 PersonalJob 自身 SIGKILL→新进程恢复。已完成 run 的不重发补记，不替代未完成 run 的全部恢复。
4. 配置层级变化下现有 client/hook/UI 的排空、再读取与状态投影，多租户/PostgreSQL/大历史/不同用户桌面旅程仍需分别验证。
5. R04/R06/R07/R09/R13/R17/R23/R30 均不因本批关闭；R31 后置；不涉及发布。

## 6. 证据来源和授权边界

- composition：d921400d70f3c1c2234fae890e1121202d1f8b0dd2fa6ab40fb67bdd13aa56ef，1757 源文件、3 roots、5 bindings、3 Runner uses。
- runner-negative：c5f98e523a5e3db9efaf6f5bafda579ee25721e547dc280cdc6c2a0e626a5ca8。
- dependency：f5dba895c7fb23a18eb0b27c7127d795bfcced9af3ffd871f2ab70b235fe3406；7281 文件、7484 叶、6 assets。source snapshot/freshness 在文档同步后由原工具生成/核验；静态新鲜度不证明默认 MCP 失败已修。

操作只涉及原 TS 源码/测试、可重建生成文件、仓库证据和用户指定桌面计划。进程/配置写入测试使用隔离 fixture；宿主诊断只启动自己的临时实例并清理自己的临时目录。未操作真实账号/凭据/业务数据库、PATH、全局 CLI 或系统策略，未新增 Python 能力，未提交推送。规则自检：未以通过切片替代整阶段，默认环境失败及诊断边界明确保留。
