---
title: Arforge P1 Fixes A1+A2 — Learning Injection Loop & Stub Capability Realization
category: synthesis
summary: 完成完整开发计划第一步：A1（学习注入闭环，injection_total 从硬编码 0 变为真实 SQL 计数）+ A2（_safe_modify 和 _multimodal_inspection 从 stub 重写为真实文件操作/多模态检测）。新增 22 测试，238 passed，零回归。
tags: [arforge, p1-fix, learning-system, capability, stub-fix, milestone]
sources: 1
updated: 2026-06-18
---

# Arforge P1 修复 A1+A2 — 第一步执行完成

> 执行日期: 2026-06-18
> 来源: 《Arforge-Agent-完整开发计划-2026-06-17.txt》第 15/16 部分
> 批次: 第一步（A1 + A2），P1 优先级

---

## 一、A1 — 学习注入闭环修复（P1-#5）

### 问题

- `learning_system.py:390` injection_total 硬编码为 0
- `agent_core.py:174-183` 调用了 `build_injection_context()` 但不传递大小给 `record_turn()`
- `get_stats()` 中的 `injections_per_turn` 永远为 0

### 修改

| 文件 | 改动 |
|------|------|
| `arforge/learning_system.py` | Outcome + injected_context_size 字段、CREATE_OUTCOMES 新列、_init_db migration、record_outcome INSERT、record_turn 新参数、get_stats SQL 计算、get_outcomes 提取 |
| `arforge/core/agent_core.py` | chat() 传递 injected_context_size=len(learning_ctx) |

### 新增测试

`tests/test_learning_injection_loop.py` — 7 用例：
- 写入/读取 injected_context_size
- get_stats 注入计数验证 (3/5 = 0.6)
- 全零注入验证
- stats_summary 输出
- Outcome dataclass 字段
- Schema migration
- 默认值向后兼容

---

## 二、A2 — 修复 2 个 stub Capability（P1-#8）

### _safe_modify 真实化

旧行为：返回静态 `{"available": True, "usage": "..."}`

新行为：
- 用 `rfind(":")` / `rfind("：")` 取最后冒号分隔路径和内容
- 正则提取文件路径后调用 `safe_modify_file()` 真实写入
- 返回结构化结果：success, file_path, backup_path, verification_status, diff_summary, hunks_changed

### _multimodal_inspection 真实化

旧行为：检测 Pillow/easyocr 安装状态，返回静态模式列表

新行为：
- 优先扩展名匹配文件路径（`.png/.jpg/.pdf/.docx` 等）
- 图片 → `image_adapter.inspect_image()` 返回 width/height/format
- OCR 关键词 → 附加 `extract_text_from_image()`
- 文档 → `document_adapter.read_document_text()` 返回 text_preview
- 结构化错误：文件不存在/不支持类型/无路径

### 新增测试

`tests/test_capability_stubs_fixed.py` — 15 用例：
- safe_modify: 创建文件、覆盖文件、中文关键词、全角冒号、无效格式、备份路径、hunks_changed
- multimodal_inspection: 图片元数据、无关键词路径、txt 文档、md 文档、缺失文件、无路径、不支持扩展名、OCR 关键词

---

## 三、M3 旧测试适配

`tests/test_m3_capability.py` 中 2 个测试旧断言匹配 stub 行为，已更新：
- `test_safe_modify_returns_usage` — 从检查 "available" 改为检查 "success"/"error"
- `test_multimodal_inspection_detects_pillow` — 从检查 "available"/"pillow"/"image" 改为检查 "success"/"error"/"exists"

---

## 四、验证基线

```
A1 测试:     7/7 passed
A2 测试:    15/15 passed
M3 测试:    29/29 passed（含 2 个适配）
全量 pytest: 238 passed / 2 pre-existing (文件写入确认)
Ruff:        CLEAN (0 issues)
compileall:  CLEAN
```

新增总测试: 22 用例
修改文件: 3 源码 + 1 旧测试
新增文件: 2 测试文件

---

## 五、P0/P1 进度

```
P0: 3/3 ✅
P1: 2/5 ✅  (A1 学习注入闭环 / A2 stub Capability)
P2: 0/10
完成度: 约 31% (5/16 任务)
```

## Appears in
- [[entities/arforge-agent]]
- [[synthesis/arforge-m1-m7-completion-2026-06-16]]
- [[synthesis/arforge-reasoning-layer-refactor-2026-06-18]]

## Open questions
- A3 (verify+retry) 实现是否需要修改 LoopResult 数据类
- A4 (diff_applicator) 是否需要新建 _diff_parser.py 还是内联实现
