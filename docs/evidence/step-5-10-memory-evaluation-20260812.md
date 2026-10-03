# Step 5.10 — Memory Evaluation

日期：2026-08-12
计划：`Arforge-最终详细实施计划-V2-2026-08-11.md`  12.阶段 5 / Step 5.10
状态：Evaluation contract 与外部 Memory evaluation report 已完成；Memory-native governance annotations 仍按边界标记为 not_measured。

## 指标合同

`packages/schema/src/memory-evaluation.ts` 与 `packages/core/src/memory-evaluation.ts` 覆盖：

- recall@K、MRR、false recall；
- cross-scope leak、stale/conflicting recall；
- deletion/forget propagation；
- prompt-injection contamination；
- latency、input tokens、cost；
- downstream task delta。

每个指标都有 `measured` / `not_measured` 状态、可选 numerator/denominator 和 note。评测没有提供的治理 annotations 不会被当成零，也不会填默认阈值。`compare` 只有收到显式 thresholds 才会返回 promoted/rejected，否则是 not-evaluated。

## 外部数据边界

数据集使用已下载并 MD5 校验的官方 BEIR SciFact test split（20 query 子集、qrels、5,183 corpus rows）。官方压缩包下载地址为 <https://public.ukp.informatik.tu-darmstadt.de/thakur/BEIR/datasets/scifact.zip>，官方与本地下载 MD5 均为 `5f7d1de60b170fc8027bb7898e2efca1`。

基线报告 `artifacts/external-query-sets/beir-scifact/baseline-recall-at-10.json` 与 Memory evaluation report `artifacts/external-query-sets/beir-scifact/memory-evaluation-v1.json` 均由本地脚本生成，raw content 未持久化。当前 external baseline 是 `@arforge-ai/core CodeRetrieval` 的 retrieval adapter，不是已迁移 Memory active rows；20 个 query、K=10 的结果为 recall@10 `11/23 = 0.4782608695652174`、MRR `0.50625`、false recall rate `189/200 = 0.945`、平均延迟 `10699.3 ms`。因此 cross-scope、stale/conflict、forget/delete、prompt-injection、input token、cost、downstream/task 等没有外部 annotations 的指标会明确 `not_measured`。Step 5.11 完成 additive lifecycle/provenance migration 后再运行 Memory-native candidate/active evaluation。

## 验证

`packages/core/test/memory-evaluation.test.ts` 覆盖外部 recall/MRR/false recall/latency、治理 annotations、阈值 compare 和 dataset provenance。
