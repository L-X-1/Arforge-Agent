# Eval、Staging 与远端 CI 操作手册

## 本地完整评测

默认 eval runner 对每个任务强制执行正数 token 预算，默认值为 `300000`。
预算可以通过 CLI 或环境变量调整，任务级 CLI 值优先：

```powershell
arforge eval --suite formal --token-budget 300000
arforge eval --suite formal-multistack --token-budget 300000
```

超额任务会被标记为失败，并在结果与 formal evidence 中写入
`token_budget_exceeded`、实际 token 数和预算值。工具循环会把单次最大输出收紧到
剩余额度，返回后仍做一次强制超额判定。

## PostgreSQL

server 模式必须同时验证主库和 multiagent 库：

```powershell
arforge doctor --json
arforge db-current main
arforge db-current multiagent
```

只配置 `ARFORGE_DB_URL` 时，multiagent 数据库由主库名派生为 `<主库>_ma`；显式
`ARFORGE_MULTIAGENT_DB_URL` 优先。`doctor` 只有在两套连接都成功时才会把数据库
检查判为通过。

## 远端 formal / multistack

在 GitHub Actions 手动运行 `Formal model evaluation`：

- 先把 `DEEPSEEK_API_KEY` 配置为仓库或 `staging` environment secret；工作流不会
  从开发者本机复制凭据，也不会在缺少 secret 时降级成伪模型评测；

- `suite=all`：并行执行两套完整的 50 项真实模型评测；
- `token_budget`：每任务硬预算；
- `run_staging=true`：formal 成功后继续真实 staging、负载与长跑验收。

远端 job 使用 PostgreSQL 17 service，分别创建 `arforge` 和
`arforge_multiagent`，应用全部迁移，先运行 `doctor`，再执行评测。无论评测是否
通过都会保留 JSON、formal dogfood 和失败工作区证据。

## Staging 与长跑

staging job 读取完整 formal JSON 作为不少于 50 次的长跑证据，并实际执行：

1. provider 冒烟，以及经本机回环 HTTP/TCP 反向代理注入的 429、503、连接中断；
   每个故障先在零重试阶段证明异常分类和无假成功，再以一次性故障证明 Arforge
   自己的重试层能够自动恢复（代理侧请求数必须为 2），最后完成清洁 provider 调用；
2. 完整 core eval 隔离工作区 E2E；
3. 并发度至少 2、请求至少 100、实测持续至少 15 分钟的 paced provider load；
4. 错误率不高于 2%、P95 延迟在 `(0, 10000] ms`；
5. formal 长跑成功率不低于 85%。

受保护的 GitHub `staging` environment 必须配置以下 variables；缺少任意一项会
在模型调用前失败：

```text
ARFORGE_STAGING_CREDENTIAL_SCOPE
ARFORGE_STAGING_ENVIRONMENT_ID
ARFORGE_STAGING_WORKSPACE_PROFILE
ARFORGE_STAGING_TEST_CREDENTIALS=1
ARFORGE_STAGING_PRODUCTION_CREDENTIALS_ABSENT=1
ARFORGE_STAGING_PRODUCTION_DATA_ABSENT=1
```

技术采集器不会自动伪造 release owner review 或凭据人工复核。
`arforge staging-audit` 因此会继续保持 fail-closed，直到审核人提供结构化且带哈希
绑定的人工证据。

故障代理只监听 `127.0.0.1`，不会记录 Authorization、请求正文或响应正文；证据仅
保留场景、HTTP 状态/异常类型、代理请求数和请求正文 SHA-256。回环 endpoint 强制
忽略宿主机 `HTTP(S)_PROXY`，公网 provider 调用仍遵守原有网络配置。可以在配置好
测试凭据的主机上独立执行并保留证据：

```powershell
python scripts/run_provider_fault_probe.py --output .arforge/validation/provider-fault-probe.json
```

`write_staging_load_evidence.py` 不再能用 `--failure-recovery-reviewed` 单独制造技术
通过；它还必须消费上述探针产生且通过 schema 校验的 `--fault-injection-evidence`。

该工作流只允许手动 dispatch，没有定时触发；这是为了让真实模型成本、staging
凭据范围和 15 分钟负载窗口都由发布负责人显式批准。
