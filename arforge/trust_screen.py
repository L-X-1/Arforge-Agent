"""Workspace trust screen — a safety check on startup.

Every time Arforge starts in a directory it hasn't seen before, the user is
shown a trust dialog listing the workspace path and a brief safety reminder.
Once trusted, the workspace is persisted so the dialog is skipped on subsequent
launches in the same directory.

Behaviour:
    First time in workspace → show trust screen → user confirms → persist → proceed
    Trusted workspace       → skip directly to main flow

Interactive controls:
    ↑/↓  Arrow keys to move selection
    Enter  Confirm selected option
    Esc    Cancel and exit
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path


# ========================================================================
# Persistence
# ========================================================================

def _trust_file() -> Path:
    from arforge.paths import data_path

    return data_path("trusted_workspaces.json")


def _load_trusted() -> set[str]:
    tf = _trust_file()
    if tf.exists():
        try:
            data = json.loads(tf.read_text(encoding="utf-8"))
            return set(data.get("workspaces", []))
        except (json.JSONDecodeError, OSError):
            pass
    return set()


def _save_trusted(workspaces: set[str]) -> None:
    tf = _trust_file()
    tf.parent.mkdir(parents=True, exist_ok=True)
    tf.write_text(
        json.dumps({"workspaces": sorted(workspaces)}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def is_workspace_trusted(path: str | Path | None = None) -> bool:
    """Return True if the current (or given) workspace has been trusted."""
    cwd = str(Path(path).resolve() if path else Path.cwd().resolve())
    return cwd in _load_trusted()


def trust_workspace(path: str | Path | None = None) -> None:
    """Persist trust for the current workspace."""
    cwd = str(Path(path).resolve() if path else Path.cwd().resolve())
    trusted = _load_trusted()
    trusted.add(cwd)
    _save_trusted(trusted)


def _auto_trust_enabled() -> bool:
    value = os.getenv("ARFORGE_TRUST_WORKSPACE", "").strip().lower()
    return value in {"1", "true", "yes", "on"}


# ========================================================================
# Screen rendering
# ========================================================================

def _terminal_width() -> int:
    try:
        import shutil
        return shutil.get_terminal_size().columns
    except Exception:
        return 80


def _clear_screen() -> None:
    """ANSI clear screen + cursor home."""
    sys.stdout.write("\033[2J\033[H")
    sys.stdout.flush()


def _hide_cursor() -> None:
    sys.stdout.write("\033[?25l")
    sys.stdout.flush()


def _show_cursor() -> None:
    sys.stdout.write("\033[?25h")
    sys.stdout.flush()


def _cursor_up(n: int = 1) -> None:
    if n > 0:
        sys.stdout.write(f"\033[{n}A")
        sys.stdout.flush()


def _read_key() -> str:
    """Read a single keypress. Returns 'up', 'down', 'enter', 'esc', or the character.

    Handles all common Windows terminal variants:
    - Windows Terminal / ConEmu / WezTerm: ANSI escape sequences (\\x1b[A etc.)
    - Traditional cmd.exe: extended key codes (\\xe0 + scan code)
    - Unix: ANSI escape sequences via termios

    Cross-platform: uses msvcrt on Windows, termios/tty on Unix.

    Key design decisions to avoid race conditions:
    - Uses BLOCKING getch() for multi-byte sequences (not kbhit() polling).
      On real consoles, all bytes of a key sequence arrive atomically; kbhit()
      polling introduces false negatives when bytes haven't reached the buffer
      by the time we check, causing arrow keys to be misread as Esc or garbage.
    - Adds a 10ms grace window only when the first byte arrives without
      follow-up bytes (slow/congested terminal edge case).
    """
    if sys.platform == "win32":
        import msvcrt
        import time as _time

        ch = msvcrt.getch()

        # Enter — both \\r (CR) and \\n (LF) accepted
        if ch in (b'\r', b'\n'):
            return "enter"

        # ── Windows extended keys (traditional cmd.exe) ──────────────────
        # Prefix \\xe0 or \\x00 followed by a scan-code byte.
        # On real hardware the two bytes always arrive together, so a
        # blocking getch() is safe and avoids the kbhit() race.
        if ch == b'\xe0' or ch == b'\x00':
            ch2 = msvcrt.getch()          # blocking — scan code MUST be next
            if ch2 == b'H':
                return "up"               # scan 72
            if ch2 == b'P':
                return "down"             # scan 80
            if ch2 == b'K':
                return "left"             # scan 75
            if ch2 == b'M':
                return "right"            # scan 77
            return ""                      # unknown extended key — ignore

        # ── ANSI escape sequences (Windows Terminal, ConEmu, WezTerm, …) ──
        # Escape-prefixed sequences: \\x1b [ <code>  or  \\x1b O <code>
        if ch == b'\x1b':
            # Give slow / congested terminals a 10ms grace window for
            # follow-up bytes to land in the input buffer.
            if not msvcrt.kbhit():
                _time.sleep(0.01)
                if not msvcrt.kbhit():
                    return "esc"          # plain Esc, no follow-up bytes

            ch2 = msvcrt.getch()          # blocking — must be [ or O
            if ch2 not in (b'[', b'O'):
                return ""                  # unknown escape sequence — ignore

            # Same grace window for the third byte (A/B/C/D)
            if not msvcrt.kbhit():
                _time.sleep(0.01)
                if not msvcrt.kbhit():
                    return ""              # incomplete CSI — ignore

            ch3 = msvcrt.getch()          # blocking — final code byte
            if ch3 == b'A':
                return "up"
            if ch3 == b'B':
                return "down"
            if ch3 == b'C':
                return "right"
            if ch3 == b'D':
                return "left"
            if ch3 == b'H':
                return "home"
            if ch3 == b'F':
                return "end"
            return ""                      # unknown CSI — ignore

        # ── Regular character ────────────────────────────────────────────
        try:
            return ch.decode("utf-8")
        except UnicodeDecodeError:
            try:
                return ch.decode("latin-1")
            except UnicodeDecodeError:
                return ""

    else:
        # ── Unix (macOS / Linux) ─────────────────────────────────────────
        import tty
        import termios
        fd = sys.stdin.fileno()
        old = termios.tcgetattr(fd)
        try:
            tty.setraw(fd)
            ch = sys.stdin.read(1)
            if ch == '\r' or ch == '\n':
                return "enter"
            if ch == '\x1b':
                import select
                # 50ms window for follow-up bytes
                if select.select([sys.stdin], [], [], 0.05)[0]:
                    ch2 = sys.stdin.read(1)
                    if ch2 in ('[', 'O'):
                        if select.select([sys.stdin], [], [], 0.05)[0]:
                            ch3 = sys.stdin.read(1)
                            if ch3 == 'A':
                                return "up"
                            if ch3 == 'B':
                                return "down"
                            if ch3 == 'C':
                                return "right"
                            if ch3 == 'D':
                                return "left"
                return "esc"
            return ch
        finally:
            termios.tcsetattr(fd, termios.TCSADRAIN, old)


def _render_trust_screen(lang: str) -> str:
    """Build the trust screen text.  Returns the full screen as a string."""
    from arforge.cli_ui import accent, bold, dim, muted, highlight
    from arforge.i18n import t

    w = min(_terminal_width(), 88)
    cwd = str(Path.cwd().resolve())

    title = t("trust.title", lang)
    accessing = t("trust.accessing", lang)
    safety = t("trust.safety", lang)
    question = t("trust.question", lang)
    hint = t("trust.hint", lang)
    arforge_notice = t("trust.notice", lang)
    security_guide = t("trust.guide", lang)
    option_yes = t("trust.option_yes", lang)
    option_no = t("trust.option_no", lang)
    confirm_hint = t("trust.confirm_hint", lang)
    footer = t("trust.footer", lang)

    # Build screen
    sep = "─" * (w - 4)

    lines = [
        "",
        f"  {accent(title)}",
        "",
        f"  {dim(sep)}",
        f"  {muted(accessing)}:",
        f"  {highlight(cwd)}",
        f"  {dim(sep)}",
        "",
        f"  {bold(safety)}: {question}",
        f"  {dim(hint)}",
        "",
        f"  {dim(arforge_notice)}",
        "",
        f"  {muted(security_guide)}",
        "",
        f"  {accent(f'  {option_yes}')}",
        f"  {dim(f'  {option_no}')}",
        "",
        f"  {dim(confirm_hint)}",
        "",
        f"  {dim(footer)}",
        "",
    ]

    return "\n".join(lines)


# ========================================================================
# Interactive flow
# ========================================================================

def show_trust_screen(lang: str = "zh") -> bool:
    """Display the trust screen and wait for user confirmation.

    Returns:
        True  — user confirmed trust, proceed.
        False — user declined, exit.

    The screen replaces the current terminal content (ANSI clear).
    If the workspace was already trusted, returns True immediately without
    showing anything.
    """
    # Short-circuit for already-trusted workspaces
    if is_workspace_trusted():
        return True

    _clear_screen()
    print(_render_trust_screen(lang))

    # Wait for input
    try:
        choice = input("  ").strip()
    except (KeyboardInterrupt, EOFError):
        print()
        return False

    if choice == "1" or choice.lower() in {"y", "yes", "是"}:
        trust_workspace()
        return True

    # Choice 2, 'n', 'no', '否', Esc, or anything else → exit
    _clear_screen()
    from arforge.i18n import t
    print(f"\n  {t('trust.exited', lang)}\n")
    return False


# ========================================================================
# Combined entry screen (Logo + Trust in one view)
# ========================================================================

def show_entry_screen(lang: str = "zh", *, quiet: bool = False) -> bool:
    """Display logo followed by trust check.  One combined entry point.

    Returns True when the user can proceed to onboarding/main flow.
    """
    if _auto_trust_enabled():
        trust_workspace()
        return True
    if is_workspace_trusted():
        if quiet or not sys.stdin.isatty():
            return True
        from arforge.logo import print_logo
        from arforge.cli_ui import muted, dim
        from arforge.i18n import t

        print_logo(clear_screen=True)
        cwd = str(Path.cwd().resolve())
        print(f"  {muted(t('trust.workspace_label', lang))} {dim(cwd)}  {dim(t('trust.workspace_trusted', lang))}")
        print()
        return True
    if not sys.stdin.isatty():
        from arforge.i18n import t
        print(t("trust.non_tty_closed", lang), file=sys.stderr)
        return False

    from arforge.logo import print_logo

    # Show logo (clears screen)
    print_logo(clear_screen=True)

    # Render the trust screen content
    from arforge.cli_ui import bold, dim, muted, highlight
    from arforge.i18n import t

    w = min(_terminal_width(), 88)
    cwd = str(Path.cwd().resolve())
    sep = "─" * (w - 4)

    accessing = t("trust.accessing", lang)
    safety = t("trust.safety", lang)
    question = t("trust.question", lang)
    hint = t("trust.hint", lang)
    arforge_notice = t("trust.notice", lang)
    security_guide = t("trust.guide", lang)
    option_yes = t("trust.option_yes", lang)
    option_no = t("trust.option_no", lang)
    confirm_hint = t("trust.confirm_hint", lang)
    footer = t("trust.footer", lang)

    # Print the static portion once
    print(f"  {dim(sep)}")
    print(f"  {muted(accessing)}:")
    print(f"  {highlight(cwd)}")
    print(f"  {dim(sep)}")
    print()
    print(f"  {bold(safety)}: {question}")
    print(f"  {dim(hint)}")
    print()
    print(f"  {dim(arforge_notice)}")
    print()
    print(f"  {muted(security_guide)}")
    print()

    # Interactive arrow-key selection
    options = [option_yes, option_no]
    selected = 0
    _hide_cursor()

    # Render initial option block
    _render_option_block(options, selected, confirm_hint, footer)

    try:
        while True:
            key = _read_key()

            if (key == "up" and selected > 0) or (key == "down" and selected < len(options) - 1):
                if key == "up":
                    selected -= 1
                else:
                    selected += 1
                # Move cursor up to the start of the option block, clear to end of screen, re-render
                _cursor_up(6)
                sys.stdout.write("\033[J")  # Clear from cursor to end of screen
                _render_option_block(options, selected, confirm_hint, footer)
                sys.stdout.flush()

            elif key == "enter":
                _show_cursor()
                print()
                if selected == 0:
                    trust_workspace()
                    return True
                else:
                    _clear_screen()
                    print(f"\n  {t('trust.exited', lang)}\n")
                    return False

            elif key == "esc":
                _show_cursor()
                _clear_screen()
                print(f"\n  {t('trust.cancelled', lang)}\n")
                return False

            # Number key fallback — instant selection without needing Enter
            elif key == "1":
                _show_cursor()
                print()
                selected = 0
                trust_workspace()
                return True

            elif key == "2":
                _show_cursor()
                print()
                _clear_screen()
                print(f"\n  {t('trust.exited', lang)}\n")
                return False

            # y/n fallback
            elif key.lower() in {"y", "是"}:
                _show_cursor()
                print()
                trust_workspace()
                return True

            elif key.lower() in {"n", "否"}:
                _show_cursor()
                print()
                _clear_screen()
                print(f"\n  {t('trust.exited', lang)}\n")
                return False

            # Ignore other keys silently

    except (KeyboardInterrupt, EOFError):
        _show_cursor()
        print()
        return False


def _render_option_block(options: list[str], selected: int, hint: str, footer: str) -> None:
    """Render the full option block: options + hint + footer.

    Caller is responsible for cursor positioning before calling this.
    After this function, the cursor is positioned at the end of the block.
    """
    from arforge.cli_ui import dim
    from arforge.cli_ui import supports_color as _color

    # Render two option lines
    for i, opt in enumerate(options):
        sys.stdout.write("\r\033[K")  # Clear line
        if i == selected:
            if _color():
                sys.stdout.write(f"  \033[1;93m▶ {opt}\033[0m\n")
            else:
                sys.stdout.write(f"  > {opt}\n")
        else:
            sys.stdout.write(f"  {dim('   ' + opt)}\n")

    # Blank line
    sys.stdout.write("\r\033[K\n")
    # Hint line
    sys.stdout.write(f"\r\033[K  {dim(hint)}\n")
    # Blank line
    sys.stdout.write("\r\033[K\n")
    # Footer line
    sys.stdout.write(f"\r\033[K  {dim(footer)}\n")
    sys.stdout.flush()
