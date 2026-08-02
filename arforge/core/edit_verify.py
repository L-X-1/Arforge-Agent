"""G7：改后即验证（edit after-hook）。

写/改文件成功后，自动按文件类型做**语法级**校验（Python compile / JSON / YAML），
失败则把错误经 POST_TOOL_USE 的 feedback 回灌模型，让它当步用 edit_file 修复——
改完即编译/检查。

设计取舍：
  - 只做语法/可解析级检查（快、确定、无副作用），不跑风格 lint（避免噪音回灌）。
  - 只在 `arforge code` 流程安装（cli._run_code），不影响 chat/ask/多 Agent → 零回归。
  - 开关用环境变量 ``ARFORGE_EDIT_VERIFY``（默认开），不依赖 config.py。
"""

from __future__ import annotations

import json
import os
from pathlib import Path

from arforge.core.hooks import HookEvent, get_hook_manager

# 触发校验的写文件工具（create_file 仅创建空文件，无需校验）
_WRITE_TOOLS = {"write_file", "edit_file"}


def verify_path(path) -> tuple[bool, str]:
    """按扩展名做语法级校验。无法/无需校验的类型返回 ``(True, "")``。

    返回 ``(ok, message)``：ok=False 时 message 为可读的错误描述。
    """
    p = Path(path)
    if not p.is_file():
        return True, ""  # 文件不存在（可能被删/移动）→ 不校验
    ext = p.suffix.lower()
    try:
        if ext in (".py", ".pyi"):
            src = p.read_text(encoding="utf-8", errors="replace")
            compile(src, str(p), "exec")
        elif ext == ".json":
            json.loads(p.read_text(encoding="utf-8", errors="replace"))
        elif ext in (".yaml", ".yml"):
            try:
                import yaml  # 可选依赖；未安装则跳过校验
            except ImportError:
                return True, ""
            yaml.safe_load(p.read_text(encoding="utf-8", errors="replace"))
        else:
            return True, ""  # 其它类型不在语法校验范围
    except SyntaxError as exc:
        loc = f"第 {exc.lineno} 行" if exc.lineno else "未知行"
        return False, f"Python 语法错误（{loc}）：{exc.msg}"
    except json.JSONDecodeError as exc:
        return False, f"JSON 解析错误（第 {exc.lineno} 行 第 {exc.colno} 列）：{exc.msg}"
    except (ValueError, OSError) as exc:
        return False, f"{ext or '文件'} 校验失败：{exc}"
    except Exception as exc:  # noqa: BLE001  yaml.YAMLError 等
        return False, f"{ext or '文件'} 校验失败：{exc}"
    return True, ""


def verify_edit_hook(ctx) -> None:
    """POST_TOOL_USE：写文件成功后校验，失败把提示加入 feedback 回灌模型。"""
    if ctx.tool_name not in _WRITE_TOOLS:
        return
    result = ctx.tool_result
    if result is None or not getattr(result, "success", False):
        return  # 工具本身失败 → 已有错误回灌，不重复
    filename = (ctx.tool_args or {}).get("filename")
    if not filename:
        return
    try:
        from arforge.tools.file_tools import _resolve

        target = _resolve(filename)
    except Exception:  # noqa: BLE001  路径越界等 → 交给既有守卫，不在此报
        return
    ok, msg = verify_path(target)
    if not ok:
        ctx.feedback.append(
            {
                "role": "user",
                "content": (
                    f"[自动校验] 你刚写入的 {filename} 存在语法/格式问题：{msg}\n"
                    "请用 edit_file 精确修正它，不要重写整个文件，也不要忽略这个错误。"
                ),
            }
        )


def _enabled() -> bool:
    return os.environ.get("ARFORGE_EDIT_VERIFY", "1").strip().lower() not in (
        "0",
        "false",
        "no",
        "off",
    )


def install_edit_verify_hook() -> None:
    """安装改后即验证 hook（POST_TOOL_USE，观察类，priority=80）。

    受 ``ARFORGE_EDIT_VERIFY`` 控制（默认开）。由 cli._run_code 调用，仅作用于
    code 流程。CLI 单进程单次命令，不存在跨命令累积；测试用 reset_hook_manager 隔离。
    """
    if not _enabled():
        return
    mgr = get_hook_manager()
    if "edit_verify" in mgr.handler_names(HookEvent.POST_TOOL_USE):
        return
    mgr.register(HookEvent.POST_TOOL_USE, verify_edit_hook, priority=80, name="edit_verify")
