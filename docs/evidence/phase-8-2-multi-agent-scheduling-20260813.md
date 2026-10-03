# Step 8.2 多代理调度收益门禁

日期：2026-08-13；2026-08-23 独立复审并补强
状态：收益门禁与用户可解释性完成；真实自动多代理仍因缺少获批固定数据集证据而保持关闭（符合 fail-closed 设计）。

## 计划对应

本阶段严格对应 V2 的 Step 8.2：只有结构化事实表明拆分属于独立只读探索、专业工具隔离、风险隔离、长上下文隔离或真实独立节点时，才形成拆分候选；只有固定数据集上的单 Agent / 多 Agent 对比证据和已批准的策略阈值同时通过，才允许实际多 Agent 执行。缺失证据、策略或合同不一致时，统一 fail-closed 为 single-agent。

## 已实现

- 新增纯策略模块 `packages/core/src/runtime/multi-agent-scheduling.ts`，不创建第二套持久化事实源。
- 对请求做规范化 digest，限制任务数量、ID、依赖、并行度和结构化字段；自由文本模型建议不能直接获得执行资格。
- 结构化资格检查覆盖独立只读任务、专业工具隔离、风险隔离和长上下文隔离信号；写任务和有任务间依赖的请求不会自动进入多 Agent 执行。
- 建立固定数据集证据合同，比较 baseline/multi 的成功率、平均时间、平均 token、平均成本和冲突率。
- 策略阈值由调用方明确提供，不在代码中虚构通用“提升百分比”；样本数、成功率回退、时间/token/成本倍率和冲突率增量均需通过。
- 决策分为 `single`、`candidate`、`multi`：候选只能记录和测量，只有 `multi` 才能实际并行。
- `DurableWorkflowGraphRuntime` 在创建工作流时记录调度请求 digest、收益证据 digest、策略 revision、比较结果、失败检查和 decision digest 到 DurableRun checkpoint，并写入 `scheduling.gate_evaluated` 事件。
- 工作流实际并发使用 `effective_max_parallel`；没有收益证据时即使定义请求 `maxParallel > 1` 也只执行一个 Agent；通过已批准证据时才按请求并行。写节点仍保持 workspace 独占。

## 2026-08-23 质量补强

- 原判定只要 DAG 中存在任意依赖就整体拒绝拆分，导致共享前置节点后的独立只读分支永远无法成为测量候选；现改为识别 DAG 中至少一对互不可达节点。
- Workflow 投影会穿过 command/approval/checkpoint 等非 Agent 屏障保留 read-agent 的传递依赖，避免把 `read → command → read` 错判为可并行。
- `independent-dag-node` 现在是实际可达的结构化原因；五类计划允许原因均有回归覆盖，但没有证据时仍只进入 `candidate`。
- 固定数据集 evidence 现在强制 baseline/multi 使用相同样本数，evidence ID 必须唯一；ID 顺序不再改变 canonical digest，防止证据重排制造伪差异。
- Desktop/Web 工作流界面把“最大并行数”改为“请求上限”，运行详情同时展示请求值与实际值，并用中/繁/英解释候选、单执行、多执行、安全拆分条件和未通过门禁。
- CLI 同样明确 `--max-parallel` 只是请求上限，并在人类可读输出中展示实际调度值与失败门禁。

## 关键 fail-closed 行为

| 场景 | 决策 | 实际执行 |
|---|---|---|
| 两个独立只读任务，无固定数据集证据 | `candidate` | single-agent |
| 有证据但无批准策略 | `candidate` | single-agent |
| evidence request digest 不匹配 | `candidate` | single-agent |
| 成功率/时间/token/成本/冲突任一项超过策略 | `single` | single-agent |
| 全部样本、证据和策略检查通过 | `multi` | multi-agent |
| 写任务或任务间依赖 | `single` | single-agent；写隔离仍由后续 Step 8.4 负责 |

## 验证结果

| 检查 | 结果 |
|---|---:|
| multi-agent scheduling unit/integration tests | 12 pass，0 fail，66 expect |
| Step 8.1 DurableRun/Workflow/ActionGateway regression | 134 pass，0 fail，653 expect |
| Arforge TaskTool/event-manifest regression | 23 pass，0 fail，89 expect |
| `bun run typecheck` | 22/22 packages 成功 |
| `bun run lint` | 0 errors；5717 warnings（当前全仓基线量级） |
| workflow scheduling event sequence | `graph.created=1`，`scheduling.gate_evaluated=2` |

### 2026-08-23 新鲜复跑

| 检查 | 结果 |
|---|---:|
| Core scheduling + DurableWorkflow | 17 passed，0 failed，88 expects |
| App workflow presentation | 5 passed，0 failed，33 expects |
| CLI help contract | 1 passed，0 failed，40 snapshots，46 expects |
| Core/App/Arforge typecheck | 3 packages successful |

## 未宣称内容与后续边界

- 本阶段没有宣称全量 `packages/arforge` 测试通过；本记录只引用新鲜的 targeted gates、全仓 typecheck 和 lint 结果。
- 本阶段没有执行真实模型调用，也没有自动制造收益阈值；真实 baseline 数据集和 promotion threshold 仍需产品/工程负责人批准后填入。当前 Server 也不注入 evidence/policy，因此产品运行时按设计保持 single-agent，而不是虚构“多代理已启用”。
- “Step 8.3 尚未开始”是 2026-08-13 原始记录的时点状态；本次复审只收敛 Step 8.2，不重写后续步骤各自证据。
- 没有新增数据库 migration；调度合同和证据摘要作为 DurableRun checkpoint/event 的受限状态保存。
