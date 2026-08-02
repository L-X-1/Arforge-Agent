"""结构化(JSON)输出辅助 — P0-4。

让模型以 JSON 返回，替代脆弱的字符串解析（如"行首是数字""``` 分割"）。
优先用 provider 的 response_format=json_object，并提供从文本中稳健抽取 JSON 的兜底
（处理被散文包裹、带 markdown 围栏、含嵌套括号/字符串的情况）。
"""

from __future__ import annotations

import json
import re
from typing import Any


def extract_json(text: str) -> Any:
    """从模型输出文本中稳健地抽取 JSON 对象/数组；失败返回 None。

    依次尝试：整体解析 → 去除 ``` 围栏 → 抓取第一个括号平衡的 {...} 或 [...] 块。
    """
    if not text:
        return None
    text = text.strip()

    # 1) 直接解析
    try:
        return json.loads(text)
    except (json.JSONDecodeError, TypeError):
        pass

    # 2) 去 markdown 代码围栏
    fence = re.search(r"```(?:json)?\s*(.+?)```", text, re.S)
    if fence:
        try:
            return json.loads(fence.group(1).strip())
        except (json.JSONDecodeError, TypeError):
            pass

    # 3) 抓取第一个括号平衡的块（正确处理字符串内的括号与转义）
    for opener, closer in (("{", "}"), ("[", "]")):
        start = text.find(opener)
        if start == -1:
            continue
        depth = 0
        in_str = False
        esc = False
        for i in range(start, len(text)):
            ch = text[i]
            if in_str:
                if esc:
                    esc = False
                elif ch == "\\":
                    esc = True
                elif ch == '"':
                    in_str = False
                continue
            if ch == '"':
                in_str = True
            elif ch == opener:
                depth += 1
            elif ch == closer:
                depth -= 1
                if depth == 0:
                    candidate = text[start : i + 1]
                    try:
                        return json.loads(candidate)
                    except (json.JSONDecodeError, TypeError):
                        break
    return None


def generate_structured(
    adapter,
    messages: list,
    *,
    required_keys: list[str] | None = None,
    max_tokens: int | None = None,
    temperature: float | None = None,
) -> dict | None:
    """请模型返回 JSON 并解析为 dict。

    用 response_format=json_object 提升成功率；解析失败用 extract_json 兜底。
    指定 required_keys 且结果缺键时返回 None（由调用方决定降级），避免脆弱假设。
    """
    try:
        text = adapter.generate(
            messages,
            max_tokens=max_tokens,
            temperature=temperature,
            response_format={"type": "json_object"},
        )
    except TypeError:
        # 适配器不支持 response_format → 退化为普通生成
        try:
            text = adapter.generate(messages, max_tokens=max_tokens, temperature=temperature)
        except Exception:
            return None
    except Exception:
        # provider 调用失败（网络/限流/降级等）→ 返回 None，由调用方走启发式回退
        return None

    data = extract_json(text)
    if not isinstance(data, dict):
        return None
    if required_keys and not all(k in data for k in required_keys):
        return None
    return data
