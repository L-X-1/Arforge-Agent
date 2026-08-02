"""闭环 demo：Arforge Agent 在授权下真实操作电脑（在桌面生成 txt 文件）。

证明"模型自主决策 → 调用工具 → 真实文件操作"端到端打通（最小闭环）。

运行（授权 = 两个环境变量；ARFORGE_AUTO_APPROVE=1 代表你授予写权限）：
  ARFORGE_AUTO_APPROVE=1  python examples/agentic_demo.py

注：使用项目配置的模型（DEEPSEEK_MODEL，默认 deepseek-v4-flash）与数据库（ARFORGE_DB_URL）。
"""

from __future__ import annotations

import os

import arforge.tools.basic_tools  # noqa: F401  导入触发工具注册
import arforge.tools.file_tools  # noqa: F401
import arforge.tools.task_tools  # noqa: F401
from arforge.core.agent_core import ArforgeAgent
from arforge.core.agent_loop_v2 import AgentLoopV2
from arforge.models.deepseek_adapter import DeepSeekAdapter


def main() -> str:
    target = os.path.join(os.path.expanduser("~"), "Desktop", "arforge_demo.txt").replace("\\", "/")

    adapter = DeepSeekAdapter()  # 使用配置的模型（DEEPSEEK_MODEL）
    agent = ArforgeAgent(reasoning_enabled=False, multiagent_enabled=False)
    agent._adapter = adapter

    task = (
        "请在我的电脑上创建一个文本文件。"
        f"调用 write_file 工具：filename='{target}'，"
        "content='这个文件由 Arforge Agent 自主调用工具创建。Hello from Arforge Agent!'。"
        "完成后用一句话确认。"
    )
    print("任务：", task)
    print("-" * 70)

    result = AgentLoopV2(agent).run_agentic(task, max_steps=6)

    print("Agent 回答：", result.answer)
    print("工具调用：", [(c["tool"], "成功" if c["success"] else "失败") for c in result.tool_calls])
    summary = (result.observability or {}).get("summary", {})
    print("可观测：", {k: summary.get(k) for k in ("llm_calls", "tool_calls", "total_tokens", "cost_cny")})
    print("-" * 70)
    exists = os.path.exists(target) or os.path.exists(target.replace("/", os.sep))
    print(f"桌面文件已创建：{exists}  ->  {target}")
    return target


if __name__ == "__main__":
    main()
