---
title: Arforge P1 Fix A3 — AgentLoopV2 verify + retry loop
category: synthesis
summary: 让 AgentLoopV2 真实兑现 intent→tool→execute→verify→retry→synthesize 完整闭环。新增 _verify_tool_result（4 种工具验证规则）、_run_with_retry（指数退避重试循环）、LoopResult 扩展（verifications/retry_count）、stream 解耦（私有→公开 build_messages）、工具 prompt 去重。22 测试，全量 220 通过。
tags: [arforge, p1-fix, agent-loop, verify, retry, exponential-backoff]
sources: 1
updated: 2026-06-18
---

# Arforge P1 Fix A3 — AgentLoopV2 verify + retry

> 执行日期: 2026-06-18
> 来源: 《Arforge-Agent-完整开发计划-2026-06-17.txt》A3（P1-#4）

---

## 一、问题

`arforge/core/agent_loop_v2.py:77-131` 文档声称完整闭环：
`intent → tool → execute → verify → retry → synthesize`

实际只有 `execute → synthesize`，verify 和 retry 完全是纸面声明。

## 二、修改

### 2.1 agent_loop_v2.py（重写）

| 改动 | 说明 |
|------|------|
| `LoopResult` 新增 `verifications`、`retry_count` | 结果携带验证与重试数据 |
| `__init__` 新增 `max_retries=3` | 可配置重试上限 |
| `_verify_tool_result()` | 4 条内置规则（calculator/time/read_file/run_cmd）+ 跳过未知工具 |
| `_run_with_retry()` | execute→verify→指数退避重试循环 |
| `run()` 重构 | REGISTRY.match → _run_with_retry + trace 记录 |
| `stream()` 解耦 | `_build_messages()` → `build_messages()` 公开 API |
| `_build_tool_prompt()` 去重 | 移除工具表，只在 system prompt 注入 |

### 2.2 agent_core.py
- 新增 `build_messages()` 公开方法，包装 `_build_messages()`

## 三、验证规则

| 工具 | 方法 | 通过条件 |
|------|------|---------|
| calculator | float_parse | output 可解析为 float |
| time | iso_regex | output 含 ISO 8601 datetime |
| read_file | non_empty | output.strip() 非空 |
| run_cmd | returncode_check | meta 中有 returncode（宽松：无也通过） |
| 未知工具 | skipped | 始终通过 |

## 四、测试

`tests/test_agent_loop_verify_retry.py` — 22 用例：
- 12 个 _verify_tool_result 单元测试
- 5 个重试测试（首次成功/单次重试/重试用尽/跳过验证/指数退避）
- 5 个集成与边缘测试

## 五、基线

```
A3 测试:     22/22 passed
全量 pytest: 220 passed (排除 2 pre-existing)
Ruff:        CLEAN
compileall:  CLEAN
P1 进度:     3/5
完成度:      38% (6/16)
```

## Appears in
- [[entities/arforge-agent]]
- [[synthesis/arforge-p1-fixes-a1-a2-2026-06-18]]
