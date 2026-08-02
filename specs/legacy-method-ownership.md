# 旧 Bridge 191 方法 → 统一 Arforge 运行时归属

更新时间：2026-07-28

## 目的

旧 Python/Tauri 入口不能仅凭“新工程看起来有类似功能”就删除。本门禁把当前
Python Bridge 暴露的每一个方法分配给唯一运行时所有者，并在代码变化后自动
检测遗漏、重复和证据路径失效。

权威实现：

- `packages/agent-python/src/legacy-ownership.ts`
- `packages/agent-python/test/legacy-ownership.test.ts`
- 执行入口：`bun run fusion:capabilities`

测试直接从 `arforge.bridge` 的当前方法常量提取集合，不读取手工维护的 191 项
快照。因此旧 Bridge 新增或删除方法时，归属门禁会立即失败。

## 当前结果

| 归属 | 覆盖语义 | 方法数 | 处理原则 |
| --- | --- | ---: | --- |
| Python capability adapter | 一对一受限 API | 61 | 只保留显式只读与 15 个受控管理方法 |
| TypeScript Core/Server/Desktop | 一对一 API | 72 | 新架构直接拥有持久化、权限与 UI |
| TypeScript mature runtime | 语义替代 | 58 | 不复制旧命令名，验证用户行为等价或更强 |
| 未归属 | — | 0 | 门禁非零即失败 |
| 合计 | — | 191 | 每个方法恰好一个所有者 |

## TypeScript 原生纵向能力

| 纵向能力 | 方法数 | 覆盖 | 主要证据 |
| --- | ---: | --- | --- |
| Session 生命周期 | 19 | 一对一 API | Core Session、生成客户端、Desktop Operations |
| Schedule / Trigger / Wait / Team | 20 | 一对一 API | 四个 Core 服务及 Operations UI |
| Chat / Operation / History | 13 | 语义替代 | Session runner、队列、后台任务、会话搜索 |
| Question | 3 | 一对一 API | Question 服务与问题停靠 UI |
| Approval / Diff / Tool / File | 18 | 语义替代 | Permission、Snapshot、Tool、FileMutation |
| Task Graph | 4 | 一对一 API | revisioned durable task graph |
| Goal | 10 | 一对一 API | session-owned Goal queue |
| Feedback / Memory / Learning 写操作 | 10 | 一对一 API | Core 治理服务与 Operations UI |
| Settings / Presentation / Model | 27 | 语义替代 | Settings、Keybind、Model registry、UI |
| Run recovery | 2 | 一对一 API | Session revert、Run History |
| Git / Worktree | 4 | 一对一 API | mature Git 与 managed worktree |
| 合计 | 130 | 72 一对一，58 语义替代 | — |

## 解释边界

该检查能够证明：

1. 完整旧方法集没有无人负责的能力；
2. Python 能力边界不会意外重新获得产品会话写权限；
3. 每个 TypeScript 归属都有仍存在的实现证据；
4. 文档中的 61/130/191 数字不会静默漂移。

该检查不能单独证明：

1. 所有 Desktop 控件都能被用户实际点击；
2. PostgreSQL 管理员尚未激活的 Workflow Graph 表已经部署；
3. 旧 profile 已完成可逆归档；
4. Tier 2 已获得所有者逐路径删除批准。

所以 Tier 2 仍保留。后续门禁是 58 个语义替代的 Desktop 可达性与状态闭环
验收，而不是继续增加抽象的“功能已迁移”描述。
