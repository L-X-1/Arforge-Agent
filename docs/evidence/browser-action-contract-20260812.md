# Step 6.8 — Browser/Web Action 阶段记录

日期：2026-08-12
计划：`Arforge-最终详细实施计划-V2-2026-08-11.md`，Step 6.8
分支：`codex/phase-0-checkpoint`
状态：本地 Browser/Web Action 安全合同与验证门禁已落地；未执行 Git push。

## 已落地

- 新增 `arforge/browser_policy.py`，对 navigation/read、form/touch、download、upload、destructive click/submit 做确定性风险分类；动作批次上限 24。
- 初始 URL 和 redirect 只允许 `http(s)`/workspace-local `file`；默认 same-origin，跨 origin 必须显式 allowlist；file redirect 不能逃出 workspace；URL 用户名、密码和 credential query 参数被拒绝。
- Chromium 每次启动使用临时空 profile；下载只进入临时 download path，并返回文件大小/hash observation；不读取或持久化用户 cookie/profile。
- 页面正文以 `UNTRUSTED_PAGE_CONTENT` 标记；在执行动作前检测高风险 prompt injection，命中时 fail-closed 阻止动作。
- destructive browser action 需要独立 fresh approval；`interact_browser` 保持 schema-level confirmation，upload/download 也属于高风险动作。
- DOM、screenshot hash、visible text、console/network/runtime 信息均是 observation；截图摘要不等于执行完成。
- `expected_state` 支持 URL exact/prefix、DOM text presence/absence、readyState；只有独立 final-state verifier 才能把动作 observation 作为完成证据。
- Agent 完成门禁拒绝 `Final state verification: FAILED`，不会以“点击成功”代替最终状态证明。

## Fresh verification

```powershell
python -m ruff check arforge/browser_policy.py arforge/browser_runtime.py arforge/tools/browser_tools.py arforge/core/agentic.py tests/test_browser_policy.py
python -m pytest -q tests/test_p0_2_agentic_loop.py tests/test_browser_policy.py tests/test_reliability_guardrails.py
```

结果：ruff 通过；相关 Agent/browser 回归 84/84 通过。真实本地 Edge/CDP E2E 通过：

- local HTML target：`arforge/acceptance/projects/devops_delivery_platform/site/index.html`
- `wait:50` action 执行完成；final URL 仍在 workspace-local `file` origin
- runtime issues：0
- screenshot observation：available，返回 sha256 摘要
- credential scope：`ephemeral-empty-profile`
- expected DOM text + `readyState=complete`：`PASSED`

## 未宣称完成的边界

- 当前阶段没有把 Playwright 引入生产执行路径；Playwright 继续作为 App E2E 资产，生产 browser executor 使用既有 Chromium/CDP runtime。
- 尚未进行真实第三方网站、登录 cookie、跨 origin OAuth 或破坏性线上动作测试；这些需要明确的目标站点、凭据范围和 fresh approval，不能由本地 fixture 推断。
- 下载产物当前保存在临时 profile 的受控目录，进程结束后清理；若后续产品要求交付下载文件，需单独定义目标路径和文件交付 verifier。
