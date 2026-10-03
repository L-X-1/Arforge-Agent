# Step 8.4 多代理写冲突控制证据

日期：2026-08-23
状态：本地实现与定向验证完成

## 计划对应

本阶段对应 V2 Step 8.4：child 默认只读；写 child 只能进入独立 worktree 或 workspace-exclusive lane；合并是单独的 L2/L3 Action；同文件并发改动不得自动覆盖；父级 verifier 必须验证合并后的整体结果。

## 已实现

### 1. 默认只读与最小父级权限

- Workflow 定义中省略或填写未知 `access` 时统一降级为 `read`；只有显式 `access: "write"` 才能获得写权限。
- Durable Workflow 即使运行在 `fullAccess` 会话中，只读图的父 Run 仍固定为 L0，并且只下放 workspace read capability。
- SQLite 与 PostgreSQL 均新增迁移，把 `workflow_graph_nodes.access` 的数据库默认值从 `write` 改为 `read`；生成的 schema/migration 清单已同步。
- 生产 API 只实例化 `DurableWorkflowGraphRuntime`。旧 `WorkflowGraphRuntime` 没有生产调用者，并已标记为迁移/测试兼容入口，不能作为第二个生产写入或 lease authority。

### 2. 主机级写入隔离

- `packages/core/src/runtime/write-conflict-control.ts` 使用带 heartbeat、stale recovery 和 ownership token 的 `Flock` 文件锁实现 host-wide workspace-exclusive lane，不再依赖单进程 Promise 队列。
- 同一 workspace 的写节点在不同 runtime 实例、不同 Bun 进程之间仍互斥；读节点不获取写锁。
- `isolated-worktree` 使用 child-specific lane key；当前 Durable Workflow 的生产默认路径采用 workspace-exclusive lane。
- 获取锁超时、中止或锁状态异常均 fail-closed 为 `WriteConflictError`，不会无锁继续执行。

### 3. 规范化写入回执与冲突门禁

- 写回执绑定 parent/child/node/workspace/isolation/base HEAD/result HEAD/files/tests，并以 canonical digest 防止字段、顺序或摘要漂移。
- 路径按 Windows 安全边界执行大小写不敏感别名检查；同一路径的大小写变体、no-op modified、非法 digest、超长/重复测试名均被拒绝。
- active claims 规范化并稳定排序；任意同文件重叠都会阻止自动合并，不因来路不可信的相同 child ID 跳过检查。
- base HEAD 过期、child tests 失败、L2/L3 授权不匹配时不会产生可执行 merge plan。

### 4. 独立 L2/L3 Merge Action

- `evaluateMerge` 只生成不可变的 canonical merge plan，不伪造 Action ID，也不直接产生文件副作用。
- `bindMergeAction` 将 plan 绑定到真实父 Session Run、稳定 Action ID、ActionGateway authorization plan、资源集合和 intent digest。
- `executeMergeAction` 只能通过 `ActionGateway.Interface` 执行；它验证不可伪造 grant，并在授权完成后、调用 merge adapter 前重新读取 HEAD，关闭审批到副作用之间的 stale-base 竞态。
- merge 后再次核对 HEAD、diff digest、changed paths，并重新运行批准的测试集合；任一检查失败都会让 Durable Action 失败。

### 5. Durable parent verifier

- `verifyParentMergeDurably` 从 `DurableAction` 和 `DurableRun` 读取真实 Action 状态、observation、intent digest 与父 Run 状态，不接受调用方伪造的 settled/verifying 标志。
- 父 verifier 再次核对 Action ID、intent digest、HEAD、diff、changed paths 和测试集合，只有全部一致才通过。
- 真实 ActionGateway 集成测试覆盖成功合并，以及授权后发现 HEAD 已漂移或父 workspace 存在未提交改动时 apply 次数保持为 0 的失败路径。

## 验证结果

| 检查 | 结果 |
|---|---:|
| Step 8.4 + Durable Workflow + Flock + migration 回归 | 58 passed，0 failed，220 expects |
| ActionGateway + Authorizer + DurableRun/Action + 调度/verifier 扩展回归 | 233 passed，0 failed，1007 expects |
| `packages/core` typecheck (`tsgo --noEmit`) | passed |
| SQLite migration/schema check | passed；No schema changes |
| PostgreSQL migration generation check | passed |
| 本阶段 9 个相关文件定向 oxlint | 0 warnings，0 errors |

验证命令覆盖：

- `test/runtime/write-conflict-control.test.ts`
- `test/runtime/write-conflict-action-gateway.test.ts`
- `test/durable-workflow.test.ts`
- `test/workflow-graph.test.ts`
- `test/util/flock.test.ts`
- `test/database-migration.test.ts`

## 明确边界

- 当前生产 Durable Workflow 采用计划允许的 workspace-exclusive 方案；`isolated-worktree` 合同与合并门禁已实现，但没有替换现有 Git worktree 管理器。
- `executeMergeAction` 接收受控 repository adapter；实际 Git 命令仍由上层受授权 adapter 提供，核心模块本身不会绕过 ActionGateway 直接调用 Git 或覆盖文件。
- workspace key 采用规范化绝对/Windows 路径的 lexical identity；项目/location 层仍负责在进入运行时前解析真实 workspace 根目录。
- 仓库当前根 `.oxlintrc.json` 使用旧版 `options.typeAware` 位置，安装的 oxlint 1.60 会拒绝解析。为不改动无关脏文件，本阶段使用 `--disable-nested-config` 做定向 lint，并由独立 `tsgo --noEmit` 提供类型检查；不能据此声称全仓 lint 已通过。
- 未执行外部网络调用、发布、部署或 git push。
