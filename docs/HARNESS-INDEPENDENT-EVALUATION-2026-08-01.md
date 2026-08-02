# Arforge Harness 独立复评（2026-08-02，故障注入修订）

## 结论

- 原自评的 **8/10 偏乐观**。修复前按可复现证据约为 **6.9/10**：离线契约很强，但真实模型、CI、数据库、token 上限和双代理边界存在盲点。
- 按第二轮独立取证校准后，工程 Harness 评分为 **8.8/10**。此前 9.1 对远端实模、TypeScript 行为 CI 和双代理统一程度估计偏高；本轮已补上真实 provider 传输层故障注入。
- 当前发布就绪度为 **8.0/10**。完整快照与 deterministic CI 已有远端证据；剩余门禁是远端真实模型 formal/multistack、TypeScript 行为 CI 与受保护 staging 长跑，因为仓库尚未配置对应 secret、environment 和来源声明。

确定性 `capability-eval` 证明本地组件契约；真实模型 formal/multistack 才证明模型、工具循环、隔离工作区、语言工具链和验收器能端到端协作。两类结果不能混写。

## 独立证据

| 证据 | 结果 | 说明 |
|---|---:|---|
| Python 全量回归 | 3025 passed | 414.84 秒；包含真实传输故障代理、审计 schema 与 provider 重试边界 |
| Harness 确定性契约 | 26/26 | `model_invoked=false`，没有伪装成实模分数 |
| 模块导入 | 26/26 | `python verify_modules.py` |
| doctor | 19/19 | 同时连接主库 `arforge` 和 multiagent 库 `arforge_ma` |
| PostgreSQL 迁移 | 2/2 at head | 两库均为 `0004_cache_evidence`；PostgreSQL 17 运行，临时 trust 规则为 0 |
| 完整 formal 实模 | 50/50 | 5,317,113 token，CNY 1.979121，最大单任务 170,574 token |
| 完整 multistack 实模 | 50 项均有通过证据 | 权威全套 49/50；唯一 SQL2 为 CLI 元命令导致的 verifier 假阴性，修复后原证据通过且独立实模重跑 1/1 通过 |
| 默认 eval 硬预算 | PASS | 默认每任务 300,000；1000-token 探针在 provider 调用前以 0 token fail-closed |
| Staging/故障专项回归 | 38 passed | provider 适配器、传输故障代理、STAGE-01 审计、core E2E、paced load 与证据输出 |
| Staging 来源门禁 | PASS（拒绝运行） | 缺少隔离测试凭据和“无生产凭据/数据”声明时，在模型调用前失败 |
| 真实 provider 故障注入 | PASS | HTTP 429、HTTP 503、TCP 连接中断均被识别为失败；每项一次性故障后由 Arforge 自动重试恢复，代理请求数严格为 2；留存证据 SHA-256 `6bea53f96d6b506ce721f794a9daaf0d6a37f7b35e66ded59412bcbc57d223e4` |
| 远端 deterministic CI | PASS | `master` run `30705010761`：Windows、Ubuntu、lint/brand 与 6 个 TypeScript 分片全部成功 |
| TypeScript 类型检查 | 23/23 tasks | 覆盖 workspace 包 |
| TypeScript lint | 0 errors | 仍有 18,987 warnings，属于待清债基线 |
| Python lint | PASS | `ruff check` 覆盖本轮 Python 变更 |
| 品牌审计 | PASS | 17,377 visited，15,252 scanned，0 hits |

完整 formal 证据：
`%USERPROFILE%\.arforge\formal-dogfood\formal-20260801T161316-34b452b8`。

完整 multistack 证据：
`%USERPROFILE%\.arforge\formal-dogfood\formal-multistack-20260801T170654-5e67bad8`；SQL2 修复后重跑为 `formal-multistack-20260801T173758-cdaccea2`。

## 本轮解决的三项问题

### 1. 远端 CI、formal/multistack、staging 与长跑

- 新增手动成本门禁 `formal-eval.yml`，可选择完整 formal、完整 formal-multistack 或并行执行两者。
- reusable formal job 使用 PostgreSQL 17 service，创建隔离的主库与 multiagent 库，执行迁移、doctor、每任务硬预算和证据上传。
- staging job 使用受保护的 `staging` environment，消费不少于 50 项的 formal 报告，并通过只监听 `127.0.0.1` 的反向代理注入 HTTP 429、HTTP 503 和连接中断；每项必须跨过真实 SDK HTTP/TCP 边界、不得假成功，之后还必须完成真实 provider 恢复调用。
- staging 技术采集器不会伪造 release owner review 或凭据人工复核；缺少来源声明时 fail-closed。
- 工作流没有定时触发，避免未授权的模型费用和 staging 凭据使用。

本地已完成完整 formal 与完整 multistack。完整快照已推送，远端 `master` 由零父提交 `b5e4e23461568bcc9e7dfeb261c462f574b65c70` 重建，随后运行的 [deterministic CI 30705010761](https://github.com/L-X-1/Arforge-Agent/actions/runs/30705010761) 全绿。远端真实模型 formal/multistack 与 staging load 尚未执行，原因是 GitHub 当前没有 `DEEPSEEK_API_KEY`、受保护的 `staging` environment 及六项隔离来源变量；系统保持 fail-closed，未把本机密钥上传到仓库。

真实故障证据留存在 `docs/evidence/provider-fault-probe-20260802.json`：429 映射为 `RateLimitError`，503 映射为 `InternalServerError`，连接中断映射为 `RemoteProtocolError`；零重试检测阶段三项均为一次代理请求、`false_success=false`，随后一次性故障阶段均由 Arforge 自动重试并以两次代理请求恢复，最终清洁调用为 `content_valid=true`、`finish_reason=stop`。证据只保留请求正文 SHA-256，不保留 API key、Authorization 或提示正文。

### 2. 本机 PostgreSQL 不可达

- 修正了用户 `.env` 中过期的 `ARFORGE_MULTIAGENT_DB_URL`，避免其覆盖由主库安全派生的连接。
- 恢复主库与 multiagent 库连接并迁移到同一 head。
- `doctor` 从只检查 URL 形式升级为同时探测两套真实 PostgreSQL 连接，错误信息隐藏凭据。
- 派生 multiagent URL 时保留 authority 原始字节，避免百分号编码密码被 SQLAlchemy 二次转义。
- 密码修复使用的窄范围临时 trust 规则已经删除，当前 HBA 中相关规则为 0。

### 3. 默认 eval runner 缺少硬 token 预算

- `EvalTask`、CLI `--token-budget` 和 `ARFORGE_EVAL_TOKEN_BUDGET` 统一接入每任务预算，默认 300,000。
- 每次模型调用前估算 prompt、tools schema 和安全余量，只把剩余额度交给 completion；无法容纳下一次调用时，在计费前停止。
- provider 返回后仍执行强制超额判定，结果、JSON、EvalCase 与 formal evidence 均记录预算和停止原因。
- 已验证工作若只差最终措辞，可复用已经交付的消息安全收尾；未验证写入则继续 fail-closed。
- 1000-token 真实探针为 1 步、0 token、0 次计费调用，证明不是仅做事后统计。

## 长跑中新发现并修复

1. **Windows 工作区二进制假失败**：安全层允许 `contract.exe`，但 `CreateProcess` 无法按指定 `cwd` 解析 `.\contract.exe`。执行器现在在确认目标仍位于活动工作区后，将其解析成绝对路径；C/C++ 实模任务已复验通过。
2. **原生测试证据未识别**：成功运行 `contract.exe` / `regression.exe` 过去不能作为预算收尾的验证证据。现已纳入原生测试命令识别，C5 在 274,585/300,000 token 下正常收尾。
3. **SQLite CLI 元命令假阴性**：模型生成的 `.bail on` 可由 `sqlite3` CLI 正常执行，但 Python verifier 将其当 SQL 解析。verifier 现在剥离 CLI 元命令后再做独立数据库约束检查；原 SQL2 证据与独立重跑均通过。
4. **生成物清理导致假未验证**：删除 `.class`、`.exe` 等构建产物不再让先前通过的测试证据失效。

## 评分

| 维度 | 权重 | 修复前 | 修复后 |
|---|---:|---:|---:|
| 核心工具循环与自修复 | 20% | 8.8 | 9.3 |
| 安全与权限边界 | 15% | 8.2 | 8.8 |
| 评测有效性 | 15% | 6.5 | 8.9 |
| Provider 与运行时兼容 | 10% | 6.0 | 9.0 |
| 多 Agent 一致性 | 10% | 7.2 | 8.5 |
| 可观测性与故障隔离 | 10% | 6.5 | 9.0 |
| CI 与可复现性 | 15% | 4.5 | 8.2 |
| Token/上下文效率 | 5% | 6.0 | 8.3 |
| **加权总分** | **100%** | **6.9** | **8.8** |

## 仍然存在的发布边界

1. **远端真实模型长跑没有运行证据**：deterministic CI 已全绿，但仓库没有 `DEEPSEEK_API_KEY`，因此不能声称远端 formal/multistack 已通过。
2. **真实 staging 负载未获授权**：仓库没有受保护的 `staging` environment 或隔离来源声明。系统正确拒绝自称“staging 已通过”。
3. **STAGE-01 人工门禁仍开放**：技术采集器不会伪造 release owner review；最终发布仍需人工审核并绑定候选提交哈希。
4. **TypeScript 行为测试未进入远端 CI**：当前 CI 有 lint、brand 和 typecheck，但没有执行 Bun 单元/集成测试。
5. **双代理统一契约仍偏浅**：两个入口共享 canonical worker loop，但 `ma4` 主要依赖源码入口检查，编排与生命周期仍有两套外壳。
6. **Lint 债务仍高**：0 error 不等于 0 debt；18,987 warnings 需要建立可下降的基线。
7. **token 总量仍大**：硬上限解决失控费用，不等于自动提高效率；formal 与 multistack 应继续按类别追踪正确率、token 和成本趋势。

## 发布前下一步

1. 由仓库管理员配置 Actions secret `DEEPSEEK_API_KEY`，创建受保护的 `staging` environment，并填写 `ARFORGE_STAGING_CREDENTIAL_SCOPE`、`ARFORGE_STAGING_ENVIRONMENT_ID`、`ARFORGE_STAGING_WORKSPACE_PROFILE`、`ARFORGE_STAGING_TEST_CREDENTIALS`、`ARFORGE_STAGING_PRODUCTION_CREDENTIALS_ABSENT`、`ARFORGE_STAGING_PRODUCTION_DATA_ABSENT`。
2. 手动运行 `Formal model evaluation`，先执行完整 formal/multistack；核对费用和 artifact 后再以 `run_staging=true` 执行 100 请求/15 分钟长跑。
3. 由 release owner 补充带候选提交哈希绑定的人工审核证据，关闭最终 STAGE-01 门禁。
