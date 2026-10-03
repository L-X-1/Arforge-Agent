# R13 / R07：MCP 标准超时的端到端融合（2026-09-13）

## 1. 结论和验收边界

原标准 `mcp.timeout` / `mcp.servers.<name>.timeout.startup/request` 已接入既有配置投影、分层读取、TS CLI/HTTP writer、审批冻结、MCP supervisor 和 OAuth 协议连接。没有新增配置存储、超时 manager、进程 supervisor 或 Python 产品路径。

这是一批已验证的配置和运行时修复，不是整个 R13 完成。默认 Windows/Bun 1.3.14 的 MCP 全目录仍为 **160 pass / 17 fail / 710 断言，177 项，134.80 秒，exit 1**。失败数量仍为 17，集中在原本地启动/模块加载及依赖它的连接、恢复、退出场景。新增通过项不能掩盖这些失败，也不能作为默认运行时已达标的证明。

最终超时专项 **14 pass / 74 断言**；Core 六文件 **66 pass / 244 断言**；CLI/配置/HTTP/OpenAPI 五文件 **143 pass / 902 断言**；原 SDK 四文件 **4 pass / 7 断言**。强制 workspace 类型检查 **22/22、0 cached、46.63 秒**。各批存在重叠，不相加计算覆盖率或计划完成率。

## 2. 同一 TS 配置和执行链

| 原有归属 | 本批融合 |
|---|---|
| Core `config/mcp.ts` | 原 `Timeout` 仍是标准字段约束；单一纯函数按阶段解析服务器值、全局值和内置 30000 毫秒，返回冻结副本 |
| Core `v1/config/mcp.ts` / `config.ts` | 兼容读取投影接受旧数字或标准阶段对象，完整保留 startup/request；没有新增第二种字段名 |
| Core `v1/config/migrate.ts` | 原迁移器把服务器旧数字转换为两个阶段相同值，把旧全局实验数字转换为 request；保存归入标准 mcp 对象 |
| 产品 `config/config.ts` | 原文档合并前先规范化数字，分别继承两个阶段；高优先级只改 request 时不抹掉低优先级 startup |
| 原 `cli/cmd/mcp.ts` | 具名 add 增加 `--startup-timeout` / `--request-timeout`；仍调用原 Config writer，非法输入拒绝且不回显提交值 |
| 原 MCP `add`、冻结 spawn 和 OAuth identity | 入参在首次等待前复制；两个阶段纳入原冻结执行配置和身份；本地任一阶段变化产生新审批，原请求退役，未批准不 spawn |
| 原连接和 supervisor | 本地/远程初始化使用 startup，目录/资源/提示词/工具投影/健康检查使用 request；远程两种传输共享一个启动 deadline |
| 原 OAuth start / completion | 初始化使用被冻结的 startup；完成后目录和工具投影使用 request；失败不提交新凭据，不绕过原 generation 发布检查 |
| 原 SDK/OpenAPI generator | 从原 schema 重新生成；SDK Config PATCH 和 MCP add 使用同一 timeout 类型，无手工平行 DTO |

兼容语义必须区分来源：

- 服务器旧数字 `timeout: 500` 历史上约束启动和请求，因此迁移为 `{startup:500, request:500}`。
- 旧全局 `experimental.mcp_timeout: 500` 历史上只约束请求，因此迁移为标准 `mcp.timeout.request`，不改变启动默认。
- 新对象按字段继承。服务器 `{request:250}` 和全局 `{startup:6000, request:500}` 的有效值是 `{startup:6000, request:250}`。
- V1 只是原产品 API 的兼容读写投影；磁盘以 canonical TS 配置为准，不在磁盘维持两份全局超时状态。

投影必须是可按字段合并的普通记录。直接投影为 schema class 实例曾导致原合并器整对象替换，从而丢失继承的 startup；现复用 `ConfigMCP.Timeout.fields` 生成 plain Struct 读投影，仍由同一标准字段定义约束。原 100 次随机迁移性质测试保留并通过，没有缩小样本来绕过失败。

## 3. 已复现并修复的运行缺陷

### 3.1 传输回退重获整段启动时间

真实本地 HTTP MCP 将 initialize 延迟 500 毫秒，配置 startup=100、request=2000。修复前收到 `POST` 后仍收到 SSE 的 `GET`，专项 **0 pass / 1 fail / 4 断言**。这证明启动超时后又启动了新传输，不只是工具属性展示不正确。

原 connectRemote 和 OAuth completion 现在用 monotonic deadline 计算每次剩余时间；耗尽后不再尝试另一个传输。原 connectTransport 把剩余时间同时传给 SDK 初始化请求和原整体连接定时器，覆盖 transport.start 与 initialize 的等待。另有真实 HTTP 405 快速拒绝测试，证明期限内仍会尝试 SSE；没有简单删除传输回退功能。

原挂起 HTTP 取消测试也按新的真实合同更新：超时必须中断已发出的 POST，并且不能在过期后启动 GET。保留取消断言，不能继续要求一个本不应该发出的第二请求。

此处约束的是协议启动，不宣称任意第三方 close 实现都能在相同 deadline 内清理完成。

### 3.2 健康检查在响应后才套超时

旧 health probe 先 await ping，再把已完成结果交给 withTimeout；所以实际请求根本没有使用配置期限。

新增真实 MCP ping 延迟 500 毫秒、request=100 的场景。修复前 health 仍为 healthy，**0 pass / 1 fail / 2 断言**。修复后原 health 方法直接给 SDK ping 传 request timeout 和 Effect 的取消信号，复用原失败记忆、失效客户端清理和恢复调度，不另造健康检查服务。专项验证失败计数增加而非假健康，其他断线重连/后台健康监控回归也通过。

### 3.3 无跳转 OAuth 初始化漏用 startup

原 startAuth 直接调用 client.connect，没有应用配置中的 startup。新增本地 OAuth MCP 先要求授权、随后允许匿名但延迟初始化的场景；修复前 startAuth 返回成功，包含两条 completion 对照的初始批为 **2 pass / 1 fail / 11 断言**。

修复后用冻结的 startup 约束该协议连接。短期限失败不保存新 token、不读取工具目录；OAuth completion 也分别验证短 startup + 长 request 拒绝、长 startup + 短 request 成功，并检查连接后工具的 request 值。完整 OAuth 文件 **19 pass / 81 断言**，包含旧凭据保留、提交/发布失败、过期回调、禁用、断开和项目间隔离场景。

这不等于用户等待授权、OAuth 令牌交换、整个认证流程已经具有一个总时限；这些边界仍见第 6 节。

## 4. 正式配置与用户路径

- CLI 真实子进程保存本地和远程阶段值，仍写入原标准 mcp.servers；JSONC 注释、无关字段、显式配置目录、并发保存和 endpoint 凭据替换回归通过。
- 非交互式 CLI 拒绝零期限和非数字值，测试要求假敏感输入不出现在输出中，且不创建配置。
- 原 HTTP PATCH → Core writer → 文件 → GET 同时保留全局和服务器阶段值；零、负数、小数、字符串均返回 400，文件原文不变。
- 原产品文档合并实测全局 legacy request 覆盖和服务器 canonical request 覆盖，低优先级 startup 均保留。
- 本地审批专项分别改变 startup/request，验证新请求身份、资源变化、只剩一个待批请求、未批准零 marker，以及拒绝后原 Action 数量正确。
- Node 使用上批显式只读依赖参数启动原完整 SDK stdio fixture。审批后初始化真实延迟 200 毫秒；调用方把原 startup/request 对象改为 1 不改变冻结连接，工具仍使用原 request=1000。Node 是显式测试对照，不是把默认 Bun 替换掉。
- 原 [USER_GUIDE](../../USER_GUIDE.md) 增加 CLI 示例、canonical JSON、继承规则、旧数字差异、重新审批和未覆盖的总时限边界。没有新增 UI；完整交互体验验收仍开放。

## 5. 最终检查与可复现命令

环境：本机 Windows、项目固定 Bun 1.3.14、隔离测试 profile/SQLite/目录、本地 HTTP 和原 SDK；没有使用真实远程账号或生产配置。

| 运行位置 / 命令 | 结果 |
|---|---|
| core：`bun test --rerun-every test/config/mcp.test.ts test/config/config.test.ts test/config/config-write.test.ts test/config/provider.test.ts test/config/provider-options.test.ts test/sandbox/policy.test.ts` | 最后清理后 **66 pass / 244 断言 / 2.51 秒，exit 0** |
| arforge：`bun test --timeout 60000 test/config/config.test.ts test/server/httpapi-config.test.ts test/server/httpapi-mcp-read-paths.test.ts test/server/httpapi-public-openapi.test.ts test/cli/mcp-add.test.ts` | **143 pass / 902 断言 / 139.05 秒，exit 0** |
| arforge：本节下方三个 MCP 文件的明确筛选 | 最后清理后 **14 pass / 67 filtered / 74 断言 / 23.14 秒，exit 0** |
| arforge：`bun test --timeout 60000 test/mcp/oauth-auto-connect.test.ts` | **19 pass / 81 断言 / 11.46 秒，exit 0**；与全目录及专项重叠 |
| arforge：`bun test --timeout 60000 test/mcp` | **160 pass / 17 fail / 710 断言 / 177 项 / 134.80 秒，exit 1** |
| 根目录：`bun run script/generate.ts` | **exit 0**；原 SDK 编译和最终 OpenAPI 生成完成，保留生成器 deprecation 提示 |
| sdk/js：`bun test` | **4 pass / 7 断言 / 38 毫秒，exit 0** |
| 根目录：`bun turbo typecheck --concurrency=2 --force` | 最后清理后 **22/22、0 cached、46.63 秒，exit 0** |
| 根目录：本批 16 个源/测试文件 Prettier、diff-check | 格式通过；diff-check 同时覆盖用户指南和生成文件 |
| 根目录：同 16 个源/测试文件 Oxlint | **66 warnings / 0 errors**；清理两条本批可直接消除的提示后复验，既有警告未清零 |

最终专项命令（在 `packages/arforge`）：

```powershell
bun test --timeout 60000 test/mcp/lifecycle.test.ts test/mcp/oauth-auto-connect.test.ts test/mcp/local-approval.test.ts -t 'phase-specific|short MCP startup|transport fallback|health probes enforce|remote startup timeout|OAuth startup without|OAuth completion uses|changing the.*timeout|explicit read dependencies.*node|replacing an approved read|invalid explicit read'
```

全目录之后只做两处无行为清理：移除已不再使用的旧默认常量、canonical 读投影复用同一个 canonicalTimeout 转换函数。最终 Core、三个 MCP 文件专项及强制 workspace typecheck 均在这两处清理之后运行。

执行记录标识：回退 RED `0874aa`；健康 RED `d283a2`；OAuth RED `a6ad29`；最终 Core `58008f`；产品扩大批完成 `1c7b6c`；MCP 全目录完成 `2e0ba8`；最终专项完成 `cefac9`；SDK `965940`；最终类型完成 `dc6d9a`；最终 lint `efbf3f`。这些标识属于本任务工具记录，并非另存的全量日志文件。

原 composition、runner-negative、dependencies 台账在最终源码后刷新，source-snapshot 在本文与桌面计划同步后生成并校验。静态新鲜度只能证明输入绑定；原 capability link 的缺 receipt / 未验收项不能因此改成完成。

## 6. 下一步与未关闭项

1. R13 原调用链的总体资源边界：分页整体 deadline、总条目/字节限制、跨服务器并发、progress 最大延期。现在工具适配器仍使用 `resetTimeoutOnProgress:true`，不能宣称 request 是恶意 progress 下的总调用硬上限。必须融合原 Catalog/Gateway，而非另起管线。
2. OAuth token exchange/finishAuth、SDK task polling、第三方 close 和中断的整体时限与资源回收仍需专项验收；本批只约束上述协议初始化和普通健康请求。
3. 默认 Windows/Bun 真实启动及只读/跨目录/非系统卷模块读取仍未达标。保留默认失败测试，不自动换运行时、不扩整盘/父目录/写权限、不降级。上批沙箱目录记录为 34 pass / 1 fail，本批未修改沙箱实现，未把它当作本批重新通过。
4. 原配置剩余字段、交互式带引号命令、其他 writer/显式文件/模板/托管来源与完整 UI 仍须融合。
5. 回到原 PersonalJob 的活跃 run 部分用量与未结算账单、原预算/当前授权，以及自身 SIGKILL → 新进程恢复。完成结果补记不代替这些边界。
6. R04/R06/R07/R09/R13/R17/R23/R30 不关闭，v2 其他工作包退出条件不缩减。R31 真实三平台 full sandbox 仅在 R30 之后执行；不涉及发布。

安全自检：未修改用户账户/凭据/业务数据、PATH、全局 CLI、项目 Bun 版本或系统策略；未启动三平台认证、恢复旧任务卡协议、创建平行 owner、子代理、提交或推送，保留既有工作树改动。
