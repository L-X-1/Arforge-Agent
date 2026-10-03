# Step 7.4 — Experience Evaluation 验证证据

日期：2026-08-12

## 实现范围

- 新增 `packages/core/src/experience-evaluation.ts`，只消费离线 replay 结果，不调用模型、provider 或执行副作用。
- 固定比较三组：`without_experience`、`candidate_experience`、`active_experience`。
- 对每组测量 success rate、平均 steps、平均 tokens、平均 cost，以及 new failure count/rate。
- 要求三组使用同一 dataset ID/revision/source/case 集合；candidate/active 必须绑定 64 位 immutable experience digest。
- 输出 candidate/active 相对 without，以及 candidate 相对 active 的 delta；结果明确标注 `observational_correlation_only`，不生成 promotion 结论或因果证明。

## 验证结果

```text
bun run --cwd packages/core typecheck
passed

bun test --cwd packages/core test/experience-evaluation.test.ts
3 pass, 0 fail

bunx oxlint packages/core/src/experience-evaluation.ts packages/core/test/experience-evaluation.test.ts
0 warnings, 0 errors
```

测试覆盖：三组 replay 指标和 delta、观察性相关性声明、三组完整性、dataset 匹配、immutable digest 校验，以及负数资源指标拒绝。
