"""模型调用韧性层 — 指数退避重试 + 超时 + 降级。

为所有 ModelAdapter 的底层 provider 调用提供统一容错策略：
- 指数退避重试（base * multiplier^attempt + jitter），仅对可恢复异常重试
- 超时由调用方通过 provider SDK 的 timeout 参数传入
- 重试耗尽后抛 ModelCallError，由上层（Agent loop）决定降级行为

设计为纯函数 + 装饰器双形态，便于在 adapter 内按调用点包装，也便于单测
（注入会抛异常的 fake provider + 可注入的 sleep 即可验证退避与放弃逻辑）。
"""

from __future__ import annotations

import functools
import random
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import TypeVar

T = TypeVar("T")


class ModelCallError(RuntimeError):
    """provider 调用在重试耗尽后仍失败时抛出，携带最后一次原始异常。"""

    def __init__(self, message: str, attempts: int, last_error: Exception | None = None):
        super().__init__(message)
        self.attempts = attempts
        self.last_error = last_error


@dataclass
class RetryPolicy:
    """重试策略参数。默认值面向 LLM API：少量重试 + 秒级退避。"""

    max_retries: int = 3
    base_delay: float = 0.5
    max_delay: float = 8.0
    multiplier: float = 2.0
    jitter: bool = True

    def delay_for(self, attempt: int) -> float:
        """第 attempt 次失败后的退避秒数（attempt 从 0 计）。"""
        delay = min(self.max_delay, self.base_delay * (self.multiplier ** attempt))
        if self.jitter:
            delay += random.uniform(0.0, self.base_delay)
        return delay


# 默认仅对这些异常重试：网络/超时/限流/服务端错误。
# 用类名匹配（含基类链），避免在未安装 openai 时硬依赖其异常类型。
_RETRYABLE_NAMES = (
    "APITimeoutError",
    "APIConnectionError",
    "InternalServerError",
    "RateLimitError",
    "Timeout",
    "ConnectionError",
)


def is_retryable(exc: BaseException, retryable_names: tuple[str, ...] = _RETRYABLE_NAMES) -> bool:
    """按异常类名（含其基类链）判断是否可重试，解耦具体 SDK 依赖。"""
    for klass in type(exc).__mro__:
        if klass.__name__ in retryable_names:
            return True
    return False


def call_with_retry(
    fn: Callable[[], T],
    policy: RetryPolicy | None = None,
    *,
    retryable_names: tuple[str, ...] = _RETRYABLE_NAMES,
    sleep: Callable[[float], None] = time.sleep,
    label: str = "model_call",
) -> T:
    """执行 fn，对可重试异常做指数退避重试；耗尽后抛 ModelCallError。

    sleep 可注入以便测试（避免真实等待）。
    """
    policy = policy or RetryPolicy()
    last_error: Exception | None = None
    for attempt in range(policy.max_retries + 1):
        try:
            return fn()
        except Exception as exc:  # noqa: BLE001 — 由 is_retryable 精细判定
            last_error = exc
            exhausted = attempt >= policy.max_retries
            if exhausted or not is_retryable(exc, retryable_names):
                raise ModelCallError(
                    f"{label} failed after {attempt + 1} attempt(s): {exc}",
                    attempts=attempt + 1,
                    last_error=exc,
                ) from exc
            sleep(policy.delay_for(attempt))
    raise ModelCallError(f"{label} failed", attempts=policy.max_retries + 1, last_error=last_error)


def with_retry(policy: RetryPolicy | None = None, *, label: str = "model_call"):
    """装饰器形态：包装一个会发起 provider 调用的方法/函数。"""

    def decorator(fn: Callable[..., T]) -> Callable[..., T]:
        @functools.wraps(fn)
        def wrapper(*args, **kwargs) -> T:
            return call_with_retry(lambda: fn(*args, **kwargs), policy=policy, label=label)

        return wrapper

    return decorator
