# Step 6.9 — Desktop/Native Action 阶段记录

日期：2026-08-12
计划：`Arforge-最终详细实施计划-V2-2026-08-11.md`，Step 6.9
分支：`codex/phase-0-checkpoint`
状态：Desktop/Native Action 本地合同、恢复语义与回归门禁已落地；未执行 Git push。

## 已落地

- Core 新增 typed native action contract：`actionID`、`traceID`、`senderID`、`kind`、`name`、canonical input digest；payload 不进入 receipt/journal。
- native action runtime 采用 Core 私有 WeakMap capability；capability 只在 main/Core 回调边界出现，preload 只暴露 `NativeActionReceipt` 监听器，不能制造或接收 capability。
- 所有 Desktop 写能力 IPC 均由 main process 重建并校验 typed request，再经过 `proposed → executing → observed → settled` 状态链；参数非法时 fail-closed。
- 已接入 20 个 Desktop 写能力入口：server/onboarding/store、directory picker、open link/path、notification、window、zoom/titlebar/menu、updater、relaunch。
- WSL 的 7 个写能力入口也经过同一 runtime：install WSL/distro/Arforge、terminal、add/remove/start server。
- action 分类覆盖 filesystem/process/window/clipboard/notification；菜单 copy/cut/paste 归入 clipboard，其余窗口菜单动作归入 window。
- native journal 使用 append-only JSONL，仅保存 digest、receipt 状态和错误码；不保存路径、store value、URL 或 secret 原文。OS keychain/secret 仍与该日志分离。
- main 启动时调用 Core `recover()`；若上次进程在 `proposed/executing/observed` 中断，则写成 `recovery_required`，不会自动重放；同一 actionID 不能再次执行。
- receipt 通过 `native-action-receipt` 回传 renderer，保留 sender 的 `actionID/traceID` 关联。

## Fresh verification

```powershell
bun run --cwd packages/core typecheck
bun run --cwd packages/desktop typecheck
bun test --cwd packages/core test/runtime/native-action.test.ts
bun test --cwd packages/desktop src/main/native-action-boundary.test.ts src/preload/ipc-ownership.test.ts
bun test --cwd packages/desktop src/main/relaunch.test.ts src/main/store-mutation.test.ts src/main/updater-controller.test.ts src/main/wsl/servers.test.ts src/main/native-action-boundary.test.ts src/preload/ipc-ownership.test.ts
bunx prettier --check packages/core/src/runtime/native-action.ts packages/core/src/runtime/index.ts packages/core/test/runtime/native-action.test.ts packages/desktop/src/main/native-action-bridge.ts packages/desktop/src/main/native-action-boundary.test.ts packages/desktop/src/main/ipc.ts packages/desktop/src/main/index.ts packages/desktop/src/main/wsl/ipc.ts packages/desktop/src/preload/index.ts packages/desktop/src/preload/types.ts packages/desktop/src/preload/ipc-ownership.ts
bunx oxlint packages/core/src/runtime/native-action.ts packages/core/test/runtime/native-action.test.ts packages/desktop/src/main/native-action-bridge.ts packages/desktop/src/main/native-action-boundary.test.ts packages/desktop/src/main/ipc.ts packages/desktop/src/main/index.ts packages/desktop/src/main/wsl/ipc.ts packages/desktop/src/preload/index.ts packages/desktop/src/preload/types.ts packages/desktop/src/preload/ipc-ownership.ts
```

结果：Core 类型检查通过；Desktop 类型检查通过；Core native action 测试 4/4 通过；Desktop boundary/ownership 测试 3/3 通过；相关 Desktop 回归 27/27 通过；Prettier 通过；oxlint 0 errors（仅保留既有代码 warning）。其中 Core 测试包含真实 JSONL journal 的 main-process reload recovery 场景。

## 未宣称完成的边界

- 尚未执行真实打包安装器、OS keychain 读写或跨平台原生窗口矩阵；这些属于后续 Desktop 发布/平台验证，不以本地 IPC 单元测试代替。
- 本阶段只处理已有 Electron main/native bridge 写操作；通用 External API Action 按计划进入 Step 6.10。
