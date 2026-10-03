# R14 Embedding 请求绑定与外发边界（2026-09-15）

## 结论

本切片把 R14 的“远程请求必须绑定主体与数据边界”落到统一 `RuntimeEmbedding` transport seam。`RemoteRequest` 现在必须携带 `EmbeddingRequestBinding`，绑定主体（tenant/user）、workspace、data scope、目标 origin、固定 `POST` 方法、model、credential identity 与 consent。进入网络前，服务会将 binding 与最终 `/embeddings` URL、请求 model/credential/consent 做 exact comparison；origin、model、凭据身份或 consent 任一漂移均在 Egress assertion 和 SecretProvider resolver 之前 fail-closed，不发送请求。

绑定由 `makeRequestBinding` 深冻结（包括 principal），SecretProvider 构造器复制冻结后的 binding；审计只写 binding digest，不写主体/工作区/数据范围原值、API key、输入文本或 query。Memory 还把当前 `Database.CurrentPrincipal`、canonical workspace path 和 `memory:<project>:<workspace>` data scope 作为 `expectedBinding` 传入同一服务，防止调用方仅自填跨主体或跨工作区字符串；CodeRetrieval 继续消费同一个 `RuntimeEmbedding`，允许远程的真实 loopback fixture 也必须显式提供该 binding；默认 hashing、未授权和发送后 fallback 的外发事实语义保持不变。

这不是 R14 整项完成：生产调用方如何从认证上下文自动生成并校验主体/workspace/dataScope、所有真实 LLM/embedding/MCP/skill/plugin/web/telemetry/child 入口的 allowed/rejected 矩阵、审计强持久化/冷恢复以及 R13/R18—R26 接线仍开放。

## 实现

- `packages/core/src/runtime/embedding.ts`
  - 新增 `EmbeddingRequestBinding` 与 `makeRequestBinding`；`RemoteRequest.binding` 为必填，SecretProvider-backed request 在 transport 前保留冻结 binding。
  - 新增 `EmbeddingBindingContext`/`expectedBinding` 和 `validateRequestBinding`，核对主体、workspace、dataScope 的非空有界性及 owner context，一并核对 target origin、固定 `POST`、model、credential identity、consent 的精确一致性。
  - 校验位于 Egress `assert` 与 credential `resolve` 之前；失败沿既有 hashing fallback 返回 `egress=denied/localOnly=true`，并复用既有 `RuntimeInsight` 审计。
  - audit metadata 仅增加不可逆 `bindingDigest`，不复制绑定明文或用户内容。
- `packages/core/test/runtime/embedding.test.ts`
  - 所有远程 fixture 改为显式绑定；新增 target-origin 漂移测试，确认请求计数为 0、凭据不解析。
- `packages/core/test/memory.test.ts`
  - Memory 允许远程 embedding 的真实 loopback fixture 增加主体/workspace/dataScope/target binding，确认 API 结果仍标记 `localOnly=false`。
- `packages/core/test/code-retrieval.test.ts`
  - CodeRetrieval configured embedding 增加真实 loopback allowed/rejected 旅程；绑定漂移时不新增网络请求并回退 hashing。

## 验收证据

| 范围                                      | 命令/结果                                                                                                                                                                                                                                                                                                      |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RuntimeEmbedding + CodeRetrieval + Memory | 分文件运行 `D:\\bun\\bin\\bun.exe test ...`：Embedding **14 pass / 0 fail / 44 assertions**；CodeRetrieval **4 / 0 / 17**；Memory **11 / 0 / 79**；合计 **29 pass / 0 fail / 140 assertions，exit 0**                                                                                                          |
| Core 类型                                 | `D:\\bun\\bin\\bun.exe run typecheck`：**exit 0**                                                                                                                                                                                                                                                              |
| 修改文件 lint                             | 根目录 `D:\\bun\\bin\\bun.exe x oxlint --type-aware packages/core/src/runtime/embedding.ts packages/core/src/memory.ts packages/core/test/runtime/embedding.test.ts packages/core/test/memory.test.ts packages/core/test/code-retrieval.test.ts`：**0 errors**（12 条既有 Memory owner/assertion warnings）    |
| 格式                                      | 修改文件 Prettier 通过；`git diff --check` exit 0                                                                                                                                                                                                                                                              |
| 迁移 freshness                            | 按 Python dependency → TS composition → source snapshot 顺序重生成后 `audit:migration-freshness`：**valid=true**；Python scanned **5096** / dependency leaves **6709** / assets **6**，TS source **1799** / composition **3/5/3**，source inputs **7705**，capability links **4 records / 4 missing evidence** |

测试只使用临时 loopback HTTP、内存/临时 SQLite 与测试凭据字符串；未读取或修改用户数据，未执行真实外部 Provider 或三平台 full sandbox。

## 未关闭项

1. Memory 已校验当前 Database principal/workspace/dataScope；CodeRetrieval 及其他生产调用方仍由调用方提供 owner context，还需接入统一认证上下文与数据范围策略，防止仅凭调用者自填字符串通过。
2. 需列出并实测所有实际 HTTP/process 外发入口的 allowed/rejected、取消、重试与审计持久化矩阵；当前只闭合统一 embedding service 的边界。
3. R13 MCP read/template/prompt 的正式 control action、外发期限、receipt/recovery，R15—R30 非 sandbox 交付与用户旅程仍开放；真实 Linux/macOS/Windows full sandbox 只能在 R30 后执行。

## 2026-09-15 接续切片：CodeRetrieval owner-context seam 与 workspace writer 入口绑定

本轮继续沿 R14 的 owner-context 缺口推进，并开始 R15 的生产入口接线。`CodeRetrieval.Query` 新增可选 `embeddingExpectedBinding`，配置 embedding 调用把它原样交给统一 `RuntimeEmbedding.embedBatch`；当 principal/workspace/dataScope 与请求 binding 不一致时，在 Egress、凭据解析和网络之前回退 hashing。新增 `packages/arforge/src/workspace-root-control-gateway.ts` 作为 CLI/HTTP/Desktop 共用的唯一 mutation adapter：它只从 Core owner 重新读取 profile 状态、构造稳定 control-plane ActionGateway 输入和 intent digest，随后委托既有 `executeWorkspaceRootMutation`，不接收调用方伪造的状态数组，也不直写 `trusted_workspaces.json`/`workspace_roots.json`。CLI 的 trust/add/remove 分支已改为调用该 adapter；当前五门禁仍保持 disabled，因此生产命令继续在进入 Gateway 前 fail-closed，并明确显示 blocking gate，不会落回 Python writer。

新增验证：Core `code-retrieval.test.ts` **4 pass / 0 fail / 19 断言**；Arforge `workspace-root-control-gateway.test.ts` **2 pass / 0 fail / 10 断言**；Arforge read-only CLI smoke **18 pass / 0 fail / 50 断言**（含 workspace list/contract audit 与 mutation fail-closed journey）；HTTP coverage 新增 `experimental.workspace.rootMutation` 场景通过，整套 coverage **429 pass / 0 fail / 0 skip / 9 missing / exit 1**，9 个 missing 为既有 `/api/fs/*`、`/api/model/default`、`/api/path`、`/api/project*`、`/api/vcs` 等未补场景，本次 workspace route 无失败；Core typecheck **exit 0**；Arforge typecheck 仍只有既有 `packages/tui` JSX/BaseRenderable 诊断，本轮无 workspace adapter/API 新诊断；新文件与 API schema Prettier 通过，workspace API scoped Oxlint **0 errors / 0 warnings**。文档与源码变更后 freshness 已重新生成并校验 **valid=true**：Python **5098/6715/6**，TS source **1800**、composition **3/5/3**，source inputs **7707**，capability links **4/4**。这是一条可审查的统一入口与拒绝路径，不代表 R15 已可写入，也不关闭 R14 的全部生产认证上下文/外发矩阵。

## 2026-09-15 接续切片：workspace HTTP API 统一控制入口

`WorkspaceApi` 新增 `POST /experimental/workspace/root-mutation`。请求只接受 `action=trust|add|remove` 与有界 `target`；不接受 renderer/CLI 传入的状态数组、profile 路径或授权 receipt。handler 从当前 instance 目录创建唯一 `typescript-core-workspace-root-writer` owner，由 adapter 重新读取 Core profile 状态，构造稳定 control-plane subject/action digest，并委托既有 `executeWorkspaceRootMutation`；CLI、未来 Desktop 与该 HTTP route 因而共享同一 writer/ActionGateway，不产生 Python 或第二套 TypeScript writer。当前五门禁保持 `keep-disabled`，所以路由在解析 identity/gateway 之前返回结构化 409（`writer_disabled`、blocking gate、owner），错误消息明确无 Python fallback；schema 拒绝空白 target 为 400，均不创建 profile 文件。

HTTP coverage 场景使用隔离 profile 与目录，真实请求通过 route/middleware/instance context，验证 409 JSON 的 name/reason/owner/blocking/message；新增场景通过，整套 coverage 仍只受既有 9 个缺失场景影响。该 API 接入只完成 R15 的统一入口与 fail-closed 可观察性，不开启生产写入；真实 profile add/remove/reorder、ActionGateway 人工审批、CAS/rollback/outbox/audit 故障恢复、Desktop 旅程与全平台 sandbox 仍开放。

## 2026-09-15 接续切片：R16 文件 move 进入 Core 唯一事务管线

本轮把文件变更链的最后一个明显分叉收敛到 Core `FileMutation`：新增 `moveIfUnchanged`，对 source/destination 使用同一规范化 lock key 按稳定顺序获取跨进程 lease 与进程内 keyed mutex；source 必须匹配 `expectedSource`，destination 缺省时必须不存在，覆盖时必须匹配 `expectedDestination`。目标写入使用既有 atomic CAS primitive，随后 source 使用 conditional remove；source 删除冲突时只在目标仍匹配本次新内容的条件下补偿，补偿失败返回结构化 filesystem failure，不静默留下 phantom copy。该操作不是另建权限或状态 owner，也不把跨卷原子 rename 冒充已实现：当前语义是同一 workspace 内的受保护“写入新目标 + 条件删除源”，宿主链接/跨卷/OS enforcement 矩阵仍按 R16/R30 另行验收。

`packages/arforge/src/tool/apply_patch.ts` 的 move 分支现在只调用 `FileMutation.moveIfUnchanged`，保留原有 mutation intent、rollback journal、post-processing、LSP/event/watcher 顺序；工具层不再自行拼接 destination write 与 source remove。write/edit/delete 继续复用同一 Core service。Core 与 Arforge 仍只有一个生产 FileMutation owner。

增量验收：Core `file-mutation.test.ts` **26 pass / 0 fail / 77 断言 / 9.77 秒**，包含新建目标 move、精确 source/destination preimage、目标冲突与覆盖；Arforge `apply_patch.test.ts` move 筛选 **2 pass / 0 fail / 4 断言 / 7.83 秒**，完整文件此前 **32 pass / 0 fail / 86 断言**；Arforge `tool/file-mutation.test.ts` **10 pass / 0 fail / 41 断言 / 2.37 秒**。Core typecheck **exit 0**；受影响文件 Prettier、`git diff --check` 通过；scoped Oxlint **0 errors**（仅既有 warnings，新增 lock assertion warning 已清理）。迁移 freshness 按 Python dependency → TS composition → source snapshot 重生成并校验 **valid=true**：Python **5098/6715/6**，TS source **1800**、composition **3/5/3**，source inputs **7707**，capability links **4 records / 4 missing evidence**；原始 digest 以 `docs/evidence/implementation/source-snapshot.v1.json` 为准。

这条切片只推进 R16 的文件事务融合，不关闭 R16：链接/junction/UNC/长路径/锁定文件/跨卷限制的事实矩阵、Shell 四类宿主完整 quoting/PTY/进程树矩阵、CodeMode 真实资源限制与全用户旅程，以及 R15 五门禁、R13、R17—R30 仍开放。真实 Linux/macOS/Windows full sandbox 继续只在 R30 后执行，未修改用户文件、profile、凭据或全局 CLI。

## 2026-09-15 接续切片：R16 Git Bash/MSYS 宿主兼容性显式化

在 Windows 主机上对真实 Git Bash 做了宿主复现：为 bash 安装目录补充只读根后，依赖路径可以解析，但进入 Windows BaseContainer 仍在 MSYS 初始化阶段因 `BaseNamedObjects` 命名对象边界返回 `0xC0000022`，用户命令未执行；PowerShell、Windows PowerShell 与 cmd 在同一宿主保持可用。这个结果证明“给安装目录只读权限”不能冒充 MSYS 的完整 SBOX 隔离。

现将该限制收敛到唯一 `SandboxRunner`/`ShellTool` 分支：识别到 Git Bash/MSYS 时，非 unrestricted 命令显式走 legacy Restricted Token + Job Object 清理路径，报告 `enforcement=partial`、host filesystem/network/process boundary 与 `job-kill-on-close`，原因包含 MSYS/BaseContainer 不兼容；不会静默报告 full。automatic/scoped 或 `requireEnforcement` 调用在执行前因 partial fail-closed，人工批准路径才允许用户明确承担未隔离文件/网络边界。PowerShell/pwsh/cmd 的 BaseContainer 路径仍保留安装目录及父目录只读依赖根，并继续要求 full 才放行自动受限执行。

增量验收：Git Bash/MSYS Runner 合同测试 **1 pass / 3 断言**；Shell 基础、MSYS、超时、非零退出、stderr、取消和 durable barrier 组合筛选 **11 pass / 0 fail / 32 断言 / 14.51 秒**；受影响文件 Prettier 通过，scoped Oxlint **0 errors**（仅既有 warnings），Core typecheck 仍为 **exit 0**。这只证明宿主边界被如实建模，不等于 Windows full sandbox，也未改变用户默认权限或绕过 Gateway。

仍开放：Git Bash 若要获得 full filesystem/network containment 需未来提供兼容 MSYS 命名对象的宿主方案；R16 其他链接/junction/UNC/长路径/锁定/跨卷与 CodeMode 资源矩阵、R15、R13、R17—R30 继续未完成。三平台 full sandbox 按计划只能在 R30 后执行，未改用户数据、profile、凭据或全局 CLI。

## 2026-09-15 接续切片：R16 CodeMode 宿主预算接线

底层 `@arforge-ai/codemode` 已有可选的 `timeoutMs`、`maxToolCalls`、`maxOutputBytes`，但 Arforge 适配器此前没有提供宿主上限，模型生成的纯计算死循环或无界嵌套调用只能依赖外层取消。本轮在 `CodeModeTool` 唯一适配器设置固定、可审查的宿主预算：单次程序最多 **120,000 ms**、最多 **128 次**嵌套工具调用、最多 **1 MiB** 模型侧结果/日志；每个真实 MCP 子调用仍由既有 `ActionGateway`/leaf budget 负责，未新增权限或执行器。超限由 CodeMode 返回稳定 `ToolCallLimitExceeded`/`TimeoutExceeded` 诊断，再沿现有 Tool 错误投影；用户取消仍优先中断并清理子调用。

增量验收：Arforge CodeMode 单测 **40 pass / 0 fail / 123 断言**（含 129 次循环实际只进入 Gateway 128 次的超限回归）；真实 MCP transport 集成 **16 pass / 0 fail / 39 断言**；受影响文件 Prettier 通过。预算是 Arforge 宿主默认，不宣称底层 CodeMode 通用包有默认值；未来如需用户可调，应复用同一配置/Action budget owner，不在工具层再造第二份状态。

这只推进 R16 CodeMode 资源边界，不关闭 R16：OS 级 CPU/内存/文件描述符限制、真实 CodeMode 用户旅程与跨进程恢复仍未实现；R15、R13、R17—R30 继续开放，三平台 full sandbox 仍按 R30 后执行，未改用户数据、profile、凭据或全局 CLI。

## 2026-09-15 接续切片：R16 FileMutation 链接路径防护与重叠 move 顺序

补查发现，`apply_patch` 的 `create/delete/move` 可直接构造绝对 lexical target，不一定经过 `LocationMutation.resolve`；若只依赖底层 atomic write 的最终文件检查，父目录中的 symlink/junction 仍可能把 create/delete 导向 workspace 外。现在 Core `FileMutation` 在持有目标锁后、任何读写前统一遍历目标及其现有父级，发现链接或 junction 即返回结构化 `FSUtil.FileSystemError`，缺失的叶/父级继续允许创建；因此 write/create/remove/conditional write/remove/move/rollback 都只有一个链接边界。该检查不改变权限源，也不把链接解析成另一工作区。

同时新增反向重叠 move 的真实并发回归：带空格/Unicode 的两个路径同时互换时，按规范化 lock key 排序只允许一个 CAS 成功，另一个明确失败，最终只保留一个目标内容且测试有界退出，不发生锁死。跨卷原子 rename、Windows junction/UNC/长路径和锁定文件的宿主差异仍不冒称已通过。

增量验收：Core `file-mutation.test.ts` 定向链接边界/反向 move **3 pass / 0 fail / 10 断言**；完整文件最终 **30 pass / 0 fail / 90 断言**，包含同进程和独立进程的反向重叠 move。Core typecheck 与受影响文件 Prettier 通过；根目录 Oxlint **0 errors / 14 warnings**，告警为既有 `NodeFileSystem` 未使用、测试替身断言及 Effect 返回路径规则，无本切片错误。

本切片只关闭“工具绕过 LocationMutation 时的链接路径逃逸”这一边界，不关闭 R16：真实 OS 链接/junction/UNC/长路径/锁定/跨卷矩阵、Shell/CodeMode 完整用户旅程与 OS 资源限制、R15、R13、R17—R30 仍开放；三平台 full sandbox 继续只在 R30 后执行，未修改用户数据、profile、凭据或全局 CLI。

## 2026-09-15 接续切片：R16 缺失目标的原子 staged publish

继续审查 move 的崩溃窗口发现，目标不存在时若直接 `writeFile({ flag: "wx" })`，进程可能在目标写入中途被终止，留下半写文件。现已在 `FSUtil` 增加可复用的 `writeIfAbsentAtomic`，由 `FileGuard.atomicWrite(..., { overwrite: false })` 以临时文件写入、sync 后通过 no-replace publish；`FileMutation.create` 与 `moveIfUnchanged` 的缺失目标分支优先使用该能力，目标出现的竞争统一映射为 `TargetExistsError`，兼容替身没有该能力时仍保留旧 `wx` 路径但不能宣称具备原子 staged publish。

完整 Core `file-mutation.test.ts` **30 pass / 0 fail / 90 断言**，包含目标创建竞争、链接路径、同进程与独立进程反向 move、CAS 与回滚；Core typecheck、受影响文件 Prettier、`git diff --check` 通过。迁移 freshness 已按依赖→组合→源码快照重生成并验证 **valid=true**：Python **5099/6715/6**、TS source **1801**、composition **3/5/3**、source inputs **7708**、capability links **4 records / 4 missing evidence**。该切片仍不宣称跨卷 rename 原子性或 OS 级 crash durability：真实链接/junction/UNC/长路径/锁定/跨卷宿主矩阵与 R15、R13、R17—R30 继续开放，三平台 full sandbox 只在 R30 后执行。
