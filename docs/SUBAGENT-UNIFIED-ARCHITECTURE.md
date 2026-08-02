# 统一子代理架构

## 决策

Arforge 只保留一个子代理 Worker Runtime。两个公开入口继续存在，但只承担适配职责：

- `spawn_subagent` / `spawn_write_subagent`：主工具循环中的轻量 Task 入口。
- `TaskDispatcher` / `MasterAgent`：带 DAG、Conversation、消息通道、并行池和持久化的编排入口。

二者共享：

1. `SubagentRoleSpec` 角色注册表；
2. 角色别名、工具白名单、权限类别、步数和 token/timeout 元数据；
3. adapter 与父级取消上下文；
4. `execute_subagent_loop` 执行内核；
5. executor 层工具白名单硬拦截。

当前单一事实源位于 `arforge/core/subagent.py`：

```text
主 Agent 工具循环 ──> spawn_* facade ───────────┐
                                                ├─> SubagentRoleSpec
MasterAgent ─> TaskDispatcher ─> SubAgent facade ┘          │
                                                           v
                                              execute_subagent_loop
                                                           │
                                                           v
                                                   run_tool_loop
```

`SubAgent` 具体类只声明 `role`；类创建时从 `SubagentRoleSpec` 绑定 tools、
capabilities、system prompt、max steps、token/timeout 和 grounding evidence。
`SubAgentPool` 的内置表同样由该注册表投影生成，不再维护第二份默认配置。

多 Agent 专属的 Task、TaskResult、Conversation、AgentChannel、TaskDispatcher、SubAgentPool 和数据库持久化保留在编排层，不在轻量入口复制。

## 兼容性

- 轻量角色名（例如 `coder`）与编排角色名（例如 `CoderAgent`）解析为同一个不可变角色规格。
- 现有 `arforge.core.subagent` API 保留，作为兼容 facade。
- 自定义 `CustomAgent.*` 继续由 pool 管理；内置角色元数据不得在 pool 中保留第二份默认表。
- 旧式覆盖 `_run` 的代理继续走 legacy adapter；agentic-first 路径统一进入共享执行内核。

## 验收条件

1. 八个编排角色与对应轻量角色返回同一个 `SubagentRoleSpec`。
2. pool、Bridge/CLI 角色列表和实际 worker 的 tools/capabilities/prompt/max_steps 一致。
3. 两个入口都调用 `execute_subagent_loop`。
4. 未授权工具同时被 schema 过滤和 executor 拦截。
5. 取消、超时、预算、进度回调和编排安全 scope 保持原行为。
6. 旧公开 API 与自定义角色测试继续通过。
