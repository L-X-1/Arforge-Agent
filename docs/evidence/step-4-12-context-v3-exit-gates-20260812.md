# Step 4.12 Context V3 退出门禁证据

日期：2026-08-12

计划位置：`Arforge-最终详细实施计划-V2-2026-08-11.md`，Step 4.12

状态：已完成本地退出门禁；candidate promotion threshold 仍由后续变更单独提供

## 已通过门禁

- 外部 web/MCP/file/memory/tool output 不能获得 instruction authority：Context Firewall registry/trust/sensitivity 回归通过；
- Context Package 可重放并保留可解释 omission：digest、manifest、budget omission、tamper detection 回归通过；
- model switch/process recovery 可从 durable Session/Run/Checkpoint/Evidence 重编译：Step 4.10 回归通过；
- Golden Evaluation 不退化：`runtime/golden.test.ts`、`runtime/evaluation.test.ts`、`runtime/migration.test.ts` 共 27 pass、0 fail、514 assertions；
- Step 4.1–4.11 相关联合回归：62 pass、0 fail、216 assertions；root typecheck 22/22；涉及新增文件 lint 0 warnings。
- 真实外部 retrieval baseline 已执行：20 个 query、5,183 个 corpus 文档、339 条 test qrels；官方压缩包 MD5 与下载文件均为 `5f7d1de60b170fc8027bb7898e2efca1`；当前 `CodeRetrieval` hashing baseline Recall@10 为 `11/23 = 0.4782608696`，query hit rate@10 为 `0.55`。

## 外部数据 provenance

本次使用 BEIR SciFact test split：

- 下载地址：`https://public.ukp.informatik.tu-darmstadt.de/thakur/BEIR/datasets/scifact.zip`；
- 数据集说明：`https://github.com/beir-cellar/beir/wiki/Datasets-available`；
- 评估脚本：`packages/core/script/external-beir-scifact-eval.ts`；
- 本地摘要：`artifacts/external-query-sets/beir-scifact/baseline-recall-at-10.json`；
- 原始 corpus/queries/qrels 只保留在本地 ignored artifact，摘要不保存原始文本。

该 baseline 只证明当前 retrieval 在一个有公开 qrels 的外部数据集上可测量，不等于 candidate 已被 promotion。后续 Context 改动必须在同一 dataset revision 上重跑 baseline/candidate comparison，并由项目规则提供 threshold；本阶段没有虚构 threshold。

## 安全说明

数据许可需按 SciFact 声明处理：claims/evidence annotations 为 CC BY 4.0，corpus abstracts 属于 Semantic Scholar S2ORC 并标注 ODC-By 1.0；仅用于本地评估，未上传或分发原始数据。当前实现和测试不包含 API key、真实 prompt 或 provider header。
