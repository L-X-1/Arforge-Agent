# R13：原 MCP Catalog 的遍历预算和共享读取并发（2026-09-13）

## 1. 本批结论

已把单服务器、单类完整目录的时间/条目/字节预算融入原 `McpCatalog.paginate`，tools、prompts、resources、resource templates 共用同一实现。原 MCP `InstanceState` 持有一个读取 Semaphore，所有工具目录入口、其他三类目录和健康探测共享最多 4 个在途名额；未新增 supervisor、目录存储或工具执行调度器。

这不是整个 R13 完成：默认 Windows/Bun 1.3.14 的 MCP 全目录为 **177 pass / 17 fail / 758 断言，194 项，129.73 秒，exit 1**。17 个本地加载及其相关生命周期失败保留，未降级沙箱、换运行时或改成跳过。

本批明确没有完成跨服务器累计保留量、所有排队工作的总 deadline、解码前网络大小限制、工具 progress 最大延期、OAuth token exchange 和 SDK task polling 总时限。`R13` 与其他原工作包均不因本批局部通过而关闭。

## 2. 具体实现和归属

| 原归属 | 融合内容 |
|---|---|
| `src/mcp/catalog.ts` 原 paginate | 一个完整遍历共享 request deadline；每页拿剩余毫秒和同一个 AbortSignal，不按页重新分配整段时间 |
| 同一 Catalog 内的 Limits | 保留原 1000 页；新增完整遍历 10000 条、10 MiB UTF-8 已解码 JSON 累计上限；包括 cursor 和 `_meta`，不是只计算显示条目 |
| 同一 Catalog 内的 withDeadline | 单个操作的原生定时/取消投影，超时或调用方取消会中断 SDK 请求；成功/失败后移除自身 timer/listener，不拥有或重建 Client，不允许重试副作用 |
| 原四个目录消费者 | tools 原 schema-ref 容错仍在同一次遍历预算内；所有种类调用同一个分页器，失败不返回该遍历的部分条目 |
| 原 MCP InstanceState | 读取名额按实例共享，不是每个 forEach 各自限制 4；初始化的批量连接枚举也改为有界并发，未另建连接管理器 |
| 原 catalogDefs / collectFromConnected / health | 显式连接、已批准本地启动、通知刷新、OAuth 两条完成路径、三类非工具目录和 ping 都接原实例名额；Effect 中断信号传到分页 SDK 请求 |
| 原 authenticate 无跳转分支 | 修复工具目录仍传 undefined timeout 的遗漏；使用冻结 request，目录失败关闭未归属客户端并退役原 pending OAuth，不保存新凭据 |

预算从遍历取得读取名额之后开始。等待名额的时间尚未纳入一个全实例操作总期限；当前 Semaphore 有界的是已准入的客户端读取，不是任意不配合远程服务的 CPU/网络资源。

页的 JSON 在 SDK 解码后计量，超过上限时不向调用方返回部分结果。这不能限制 SDK 解码前已经接收/分配的单个巨大 HTTP/stdio 消息，也不是全进程内存硬上限。保持这个边界，不能把后置 JSON 大小检查写成传输层保护。

重复 cursor 继续拒绝，但错误不再嵌入服务端任意 cursor 内容，避免把不透明分页凭据写到日志。正常空 cursor 与 1000 页边界保留。

## 3. 失败复现与修复验证

### 3.1 慢分页、总量和原边界

旧分页器面对每页延迟 60 毫秒、8 页的目录，会在设置的 150 毫秒整体期限之外完成并返回全部结果。修正新测试对旧 callback 参数的兼容读取后，真实 RED 为 **0 pass / 1 fail / 1 断言**：期望拒绝却返回成功，不把早先测试读取不存在参数的异常算作产品缺陷。

新增单页 10001 条、两页各 6000 条、UTF-8 元数据超过 10 MiB 的测试，旧实现均错误成功。修后增加两页各 6 MiB 的累计检查，避免只检查单页；exact boundary 测试保留 1000 页 × 10 条成功，1000 个空页仍带后续唯一 cursor 时拒绝继续。

本文件最终完整单测 **13 pass / 24 断言**，其中包含原输出 schema 验证与多页工具发现，不把配额测试通过视为替代原合同。

### 3.2 原服务入口而非仅 helper

使用原 MCP Service、真实本地 HTTP、原 SDK 服务端，四类目录均制造慢多页响应，检查：

- 该次读取不返回部分条目；工具初次连接失败不向用户公布工具。
- 没有遍历完 8 页；registry 没有该次不完整目录项。
- 正常多页、空 cursor、重复 cursor和输出 schema-ref 容错回归保留。

初始六项正式测试为 **1 pass / 5 fail**。其中并发峰值为 12、调用方中断未传至 SDK 是实际缺口；另外三项“必须看到服务端某一页被取消”的断言缺少在途前提——整体时间可能在两页间耗尽，不能把未看到取消当作稳定的失败证据。因此把取消证明保留在下面独立的“先观察真实请求开始，再执行中断”场景，而不是假设计时结束时必有在途页。

### 3.3 共享并发和真实取消

6 个已连接的真实 HTTP MCP，同时发起 prompts 与 resources 两种聚合读取。每个实际服务端统计活动处理数，修前峰值 **12**；修后 **大于 1 且不超过 4**，两种目录都完整返回 6 项，最后 active=0。不是通过串行执行所有工作来满足断言，也不是每次调用各有一套独立额度。

取消测试先从服务端记录观察模板目录请求已开始，再 `Fiber.interrupt` 原读取。修复 collectFromConnected 遗漏的 Effect signal 后，服务端真实 handler 收到取消，随后同一客户端正常读取新模板并保持 connected。这里证明可配合的原 SDK 服务端能取消；不承诺任意第三方计算已停止。

另有真实 10001 项 prompts 的超大服务器和一个健康服务器同时读取：只返回健康完整目录，capability registry 同样只公布健康项，健康服务器保持 connected。

### 3.4 无跳转认证目录漏用 request

上一批已修无跳转 OAuth 的 startup，但其后 tools/list 仍传 undefined，绕过了已配置 request。新增初始化快、工具目录响应 500 毫秒、request=100 的真实认证场景，修前返回 connected，**0 pass / 1 fail / 1 断言**。

现复用同一个 catalogDefs 和冻结 request，超时返回 failed、没有新 token、没有公开工具，目录只请求一次；失败退役原 pending OAuth。完整 OAuth 文件 **20 pass / 85 断言**，保留旧凭据、代际、禁用、断开、提交/发布失败和跨项目隔离回归。

## 4. 最终验证

各批有重叠，不相加作为独立测试覆盖或计划完成率。本批只修改 5 个源/测试文件及原用户指南，没有更改 API schema，未重复生成不受影响的 SDK。

| 命令 / 运行位置 | 实际结果 |
|---|---|
| arforge：`bun test --timeout 10000 test/mcp/catalog.test.ts` | **13 pass / 24 断言 / 2.93 秒，exit 0** |
| arforge：下方明确的 Catalog + 生命周期筛选 | **22 pass / 30 filtered / 56 断言 / 5.75 秒，exit 0** |
| arforge：`bun test --timeout 10000 test/mcp/oauth-auto-connect.test.ts` | **20 pass / 85 断言 / 12.53 秒，exit 0** |
| arforge：`bun test --timeout 60000 test/mcp` | **177 pass / 17 fail / 758 断言 / 194 项 / 129.73 秒，exit 1** |
| 根目录：`bun turbo typecheck --concurrency=2 --force` | **22/22、0 cached、53.642 秒，exit 0** |
| 根目录：5 文件 Prettier check；5 文件及 USER_GUIDE diff-check | **exit 0** |
| 根目录：同 5 文件 Oxlint | **34 warnings / 0 errors**；既有警告未清零，不称整仓 lint 达标 |

正式筛选命令（`packages/arforge`）：

```powershell
bun test --timeout 10000 test/mcp/catalog.test.ts test/mcp/lifecycle.test.ts -t 'McpCatalog|schema validation across paginated|original.*catalog consumer|concurrent catalog readers|interrupting a catalog reader|oversized remote catalog|follows cursors|accepts empty cursors'
```

新增测试的 readonly fixture 数组曾造成四处类型错误，已改为只固定 tuple 位置、保留真实可变 page 数组后通过类型检查；没有放宽产品类型或用 any 掩盖。

原始任务执行标识：慢分页 RED `354b5e`；并发/中断 RED 完成 `eb6d07`；无跳转目录 RED `e12f3a`；最终 helper `32e0fd`；正式筛选 `ca9414`；OAuth 完成 `3ddd46`；默认 MCP 完成 `3670a1`；强制类型完成 `2589d6`；lint `356227`。这些是本任务工具记录标识，不是另存的全量日志文件。

## 5. 后续必须继续的边界

1. 工具 progress 最大延期、SDK task stream/polling 总时限及超时后的原 Durable Action outcome_unknown/不可重放。必须改原 Catalog/Gateway，不再建工具执行服务。
2. 跨服务器/跨目录种类的累计保留条目与字节、等待名额/整次聚合操作的总 deadline、通知/请求排队上限。当前单遍历上限不能乘成“整个 MCP 内存已有界”。
3. SDK 解码前的 HTTP/stdio 帧大小，以及工具 schema/SDK metadata cache 与已发布目录在分页失败或并发刷新期间的一致性。现只验证成功多页时原输出 schema 仍生效，尚未验收缓存事务性。
4. 目录读取的所有真实入口接入原 Control Action/Gateway 和外发授权；本批 Semaphore 只管读取准入，不是权限授予，也没有用配额替代授权。
5. 默认 Windows/Bun 本地启动、只读/跨目录/非系统卷依赖仍未达标，17 个失败不能跳过；上批沙箱目录 34 pass / 1 fail 保留历史范围，不作为本批新证据。
6. 其他配置 writer/交互入口、活跃 PersonalJob 原预算/当前授权/部分计费及自身 SIGKILL → 新进程恢复继续；外部 Provider、迁移、Python 退役和完整用户验收等 v2 退出条件不缩减。
7. R13/R07 等仍开放，R31 真实 Linux/macOS/Windows full sandbox 仅在 R30 后开展；不涉及发布。

原 USER_GUIDE 已补上限、调大 request 与缩小目录的处理方式，以及排队、解码前、远程取消和 progress 的未完成边界。桌面 v2 计划第九节前两段同步本批事实。最后用原 composition、runner-negative、dependencies 和 source-snapshot 生成器绑定输入；新鲜度 valid 不等于 capability 等价验收，原缺 receipt 项保持未完成。

安全自检：未修改用户 profile/凭据/业务数据库、全局 CLI/PATH、Bun 固定版本或系统沙箱策略；未创建平行 owner、子代理、提交或推送，保留既有工作树改动。
