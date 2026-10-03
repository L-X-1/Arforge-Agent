# Stage 8 稳定 DeepSeek 实验 runner（2026-08-14）

本记录对应第 8.10c 的本地实现，不代表已经取得可用于退出的真实 baseline/multi-agent pass 证据。

## 实现边界

- 固定模型：`deepseek-v4-flash`。
- 固定样本：3 组；每组 1 个 baseline 请求和 2 个并发 child 请求，最多 9 次请求。
- 单次最多 512 tokens，命令预算参数必须大于 0 且不超过 ¥5。
- 只有显式 `--authorize-live`、`--samples 3`、有效 `ANTHROPIC_API_KEY` 和
  `https://api.deepseek.com` HTTPS host 同时满足时才允许 provider 调用。
- 报告只保存 response SHA-256、长度、token 统计、校验结果和脱敏错误标签，不保存模型原文或密钥。
- 只有 3/3 baseline 与 3/3 multi 样本成功，且 multi 平均 wall-clock duration 严格更低时，才生成
  `status=pass` 的 `baseline_and_multi_agent_gain` 合同证据。

## 无授权预检

执行：

```powershell
bun run audit:stage8:stable-deepseek -- `
  --output artifacts/stage8-deepseek-stable-no-auth-20260814.json
```

结果：`status=blocked`、`decision=DO_NOT_PROMOTE`、`authorization.requests_used=0`，
并明确记录 `--authorize-live` 是必需条件；`safety.secrets_printed`、
`safety.production_data_changed` 和 `safety.staging_data_changed` 均为 `false`。

目标契约测试、Oxlint 和 `packages/core` typecheck 已通过。

## 实验入口结论

稳定 runner 已具备可审计的真实实验入口。本节前面的无授权预检不是实网实验结果；本轮实际结果见下节。

## 已授权实网实验结果（2026-08-14）

用户已明确授权本轮实验，实际执行命令为：

```powershell
bun run audit:stage8:stable-deepseek -- `
  --authorize-live `
  --samples 3 `
  --budget-cny 5 `
  --output artifacts/stage8-deepseek-stable-experiment-20260814.json
```

结果摘要：

- `status=fail`，`decision=DO_NOT_PROMOTE`；
- `authorization.requests_used=9`，没有超过本轮授权上限；
- baseline：3 个样本、成功 `0/3`；multi：3 个样本、成功 `0/3`；
- 9 次尝试均记录为脱敏 `LLM.Error`，没有保存 provider 原始消息；
- 观测到的平均耗时为 baseline 82ms、multi 72ms，但由于两组成功数均为 0/3，不能据此认定量化收益；
- provider 未返回可用成本字段，报告中的 `total_cost_cny` 为 `null`，因此不能声称本次费用为零；
- `secrets_printed=false`、`production_data_changed=false`、`staging_data_changed=false`。

该报告已纳入 `artifacts/stage-8-exit-evidence.json`，其中
`baseline_and_multi_agent_gain` 为 `fail`；由于签名发布/staging/rollback 环境仍不存在，Step 8.11
继续保持 `DO_NOT_EXIT`。本轮授权的 9 次请求已用完，不再追加请求。
