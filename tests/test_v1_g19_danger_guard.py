"""v1-G19 高危操作守卫——安全回归测试。

G19 的目标（高危命令即使 auto 模式也不自动执行）已被 basic_tools 的
ALLOWED_BINARIES 白名单 + DENY_ARG_PATTERNS 危险参数守卫 + shell 元字符拒绝
**硬拦截**实现，且优于"二次确认"（auto 也绝不放行）。

本测试锁定这些关键安全行为，防止未来修改 basic_tools 时悄悄削弱安全网。
被拒命令返回 returncode=126 + success=False + stderr 含原因。
"""

from __future__ import annotations

from arforge.tools.basic_tools import run_command_no_shell


def _run(cmd):
    return run_command_no_shell(cmd)


# -- DENY_ARG_PATTERNS：不可逆/破坏性参数 -------------------------------------


def test_rm_denied_not_in_whitelist():
    # rm 不在白名单 → 白名单层先硬拒（比 DENY 模式更早触发，是更强的保护）。
    r = _run("rm -rf /")
    assert r["returncode"] == 126 and not r["success"]
    assert "allow" in r["stderr"].lower()


def test_rm_variant_denied():
    r = _run("rm --no-preserve-root -rf /home")
    assert r["returncode"] == 126  # rm 不在白名单


def test_force_push_denied():
    r = _run("git push --force origin feature")
    assert r["returncode"] == 126
    assert "force" in r["stderr"].lower()


def test_force_push_short_flag_denied():
    r = _run("git push -f origin feature")
    assert r["returncode"] == 126


def test_protected_branch_push_denied():
    for branch in ("main", "master", "trunk", "release"):
        r = _run(f"git push origin {branch}")
        assert r["returncode"] == 126, branch
        assert "protected" in r["stderr"].lower()


# -- 白名单：破坏性/未知二进制不在白名单 -------------------------------------


def test_destructive_binaries_blocked():
    for cmd in ("format c:", "shutdown -h now", "mkfs.ext4 /dev/sda", "diskpart", "reg delete x"):
        r = _run(cmd)
        assert r["returncode"] == 126, cmd
        assert not r["success"], cmd


def test_unknown_binary_blocked():
    for cmd in ("curl http://evil.example", "wget http://x", "ssh user@host", "nc -l 4444"):
        r = _run(cmd)
        assert r["returncode"] == 126, cmd
        assert "allow" in r["stderr"].lower(), cmd


# -- shell 元字符（重定向/逻辑连接/命令替换）------------------------------


def test_shell_metachars_rejected():
    for cmd in (
        "echo hi > /etc/passwd",
        "ls && rm x",
        "cat a; rm c",
        "echo $(rm -rf /)",
        "echo `rm x`",
    ):
        r = _run(cmd)
        assert r["returncode"] == 126, cmd


# -- 白名单内安全命令仍放行（不误杀）----------------------------------------


def test_safe_command_allowed():
    r = _run(["python", "--version"])
    assert r["returncode"] == 0 and r["success"]


def test_git_status_not_blocked_by_guard():
    # git 在白名单、status 非破坏 → 不应被安全守卫以 126 拒（实际退出码取决于环境）。
    r = _run("git status")
    assert r["returncode"] != 126
