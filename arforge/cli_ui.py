"""Terminal UI primitives for Arforge CLI.

Rich terminal formatting with Unicode box-drawing, colored output, tables,
permission dialogs, progress spinners, and token bars — a consistent visual
design language for the CLI.
"""

from __future__ import annotations

import os
import shutil
import sys
import threading
import time
from dataclasses import dataclass

from arforge.locale import brand_title, version_line


# ---------------------------------------------------------------------------
# Console setup
# ---------------------------------------------------------------------------

def configure_console() -> None:
    """Set UTF-8 encoding on Windows; make stdout/stderr UTF-8 safe."""
    if sys.platform == "win32":
        os.environ.setdefault("PYTHONIOENCODING", "utf-8")
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
        except Exception:
            pass


def terminal_width() -> int:
    """Return terminal width, defaulting to 80 when unknown."""
    try:
        return shutil.get_terminal_size().columns
    except Exception:
        return 80


def supports_color() -> bool:
    """Check whether the output stream is a TTY and color hasn't been disabled."""
    return hasattr(sys.stdout, "isatty") and sys.stdout.isatty() and os.getenv("NO_COLOR") is None


# ---------------------------------------------------------------------------
# ANSI codes
# ---------------------------------------------------------------------------

_RESET = "\033[0m"
_BOLD = "1"
_DIM = "2"
_ITALIC = "3"
_UNDERLINE = "4"

# 4-bit foreground
_FG = {
    "black": "30", "red": "31", "green": "32", "yellow": "33",
    "blue": "34", "magenta": "35", "cyan": "36", "white": "37",
    "bright_black": "90", "bright_red": "91", "bright_green": "92",
    "bright_yellow": "93", "bright_blue": "94", "bright_magenta": "95",
    "bright_cyan": "96", "bright_white": "97",
}

# 4-bit background
_BG = {
    "black": "40", "red": "41", "green": "42", "yellow": "43",
    "blue": "44", "magenta": "45", "cyan": "46", "white": "47",
}


def _ansi(*codes: str) -> str:
    """Join ANSI codes into an escape sequence.  Empty → reset."""
    if not codes:
        return ""
    return f"\033[{';'.join(codes)}m"


def _color_wrap(text: str, *codes: str) -> str:
    """Wrap *text* with ANSI codes.  No-op when no TTY or NO_COLOR."""
    if not supports_color():
        return text
    prefix = _ansi(*codes) if codes else ""
    return f"{prefix}{text}{_RESET}" if prefix else text


# ---------------------------------------------------------------------------
# Public colour helpers
# ---------------------------------------------------------------------------

def bold(text: str) -> str:
    return _color_wrap(text, _BOLD)


def dim(text: str) -> str:
    return _color_wrap(text, _DIM)


def italic(text: str) -> str:
    return _color_wrap(text, _ITALIC)


def fg(text: str, color: str) -> str:
    code = _FG.get(color, "37")
    return _color_wrap(text, code)


# Semantic helpers matching the CLI palette
def info(text: str) -> str:
    return _color_wrap(text, _FG["cyan"])


def ok(text: str) -> str:
    return _color_wrap(text, _FG["green"])


def warn(text: str) -> str:
    return _color_wrap(text, _FG["yellow"])


def error(text: str) -> str:
    return _color_wrap(text, _FG["red"])


def muted(text: str) -> str:
    return _color_wrap(text, _FG["bright_black"])


def highlight(text: str) -> str:
    return _color_wrap(text, _FG["bright_cyan"])


def accent(text: str) -> str:
    """Amber accent — the warm-tinge used for titles, the ✻ thinking
    glyph, and selected items. Bright yellow reads as amber on most terminals."""
    return _color_wrap(text, _FG["bright_yellow"])


def heading(text: str) -> str:
    return _color_wrap(text, _BOLD, _FG["bright_white"])


def label(text: str) -> str:
    return _color_wrap(text, _FG["bright_blue"])


def danger(text: str) -> str:
    return _color_wrap(text, _BOLD, _FG["bright_red"])


# ---------------------------------------------------------------------------
# Print helpers (match old API for backward compat)
# ---------------------------------------------------------------------------

def print_info(message: str) -> None:
    print(info(f"  ⓘ  {message}"))


def print_ok(message: str) -> None:
    print(ok(f"  ✔  {message}"))


def print_warn(message: str) -> None:
    print(warn(f"  ⚠  {message}"))


def print_error(message: str) -> None:
    print(error(f"  ✖  {message}"), file=sys.stderr)


# ---------------------------------------------------------------------------
# Box drawing (╔═╗║╚╝)
# ---------------------------------------------------------------------------

_BOX = {
    "tl": "╔", "tr": "╗", "bl": "╚", "br": "╝",
    "h": "═", "v": "║",
    # Light variant for nested / secondary panels
    "tl2": "┌", "tr2": "┐", "bl2": "└", "br2": "┘",
    "h2": "─", "v2": "│",
}

_SEPARATOR = "─" * min(terminal_width(), 80)


def box(text: str, title: str = "", style: str = "heavy", color_name: str = "") -> str:
    """Wrap *text* in a Unicode box.  *style*: 'heavy' or 'light'."""
    suffix = "" if style == "heavy" else "2"
    tl, tr, bl, br = (_BOX[f"{c}{suffix}"] for c in ("tl", "tr", "bl", "br"))
    h, v = _BOX[f"h{suffix}"], _BOX[f"v{suffix}"]

    lines = text.split("\n")
    width = min(max((len(_strip_ansi(line)) for line in lines), default=40) + 4, terminal_width() - 2)

    # Title bar
    title_str = ""
    if title:
        title_str = f" {title} "
        # Build top border with embedded title
        top = tl + title_str + h * max(0, width - len(_strip_ansi(title_str)) - 2) + tr
    else:
        top = tl + h * (width - 2) + tr

    bottom = bl + h * (width - 2) + br

    out_lines = [top]
    for line in lines:
        visible_len = len(_strip_ansi(line))
        pad = max(0, width - visible_len - 4)
        out_lines.append(f"{v} {line}{' ' * pad} {v}")
    out_lines.append(bottom)

    result = "\n".join(out_lines)
    if color_name and supports_color():
        result = _color_wrap(result, _FG.get(color_name, "37"))
    return result


def panel(text: str, title: str = "", kind: str = "info") -> str:
    """A box with colour-coded border by *kind*.

    Kinds: info (cyan), ok (green), warn (yellow), error (red), neutral (white).
    """
    color_map = {"info": "cyan", "ok": "green", "warn": "yellow", "error": "red", "neutral": ""}
    return box(text, title=title, color_name=color_map.get(kind, ""))


def section_header(title: str) -> str:
    """A left-aligned section rule: ``── title ──────``.

    Replaces the old centred ``═══ title ═══`` double-line divider with a
    quieter amber-tinted single line. Returns a single string (same shape as
    before) so every existing call site keeps working; only the visual weight
    changes — more whitespace-friendly and on-brand with the amber accent.
    """
    w = terminal_width()
    label = _strip_ansi(title)
    # Reserve a little room after the title, then fill the rest of the line.
    tail = max(4, w - len(label) - 6)
    return f"{accent('──')} {heading(title)} {dim('─' * tail)}"


def rule(label: str = "") -> str:
    """A single thin horizontal rule, optionally with an embedded amber label.

    ``────── label ──────``  (centred) when a label is given, else a plain
    dim rule. Lighter than ``section_header`` for inline sub-dividers.
    """
    w = terminal_width()
    if not label:
        return dim("─" * w)
    text = _strip_ansi(label)
    side = max(3, (w - len(text) - 4) // 2)
    return f"{dim('─' * side)}  {accent(label)}  {dim('─' * side)}"


def muted_rule(width: int | None = None) -> str:
    """A quiet dim rule line (no label). Defaults to terminal width."""
    return dim("─" * (width if width is not None else terminal_width()))


def thinking_status(symbol: str, label: str, elapsed: float | None = None) -> str:
    """Render a thinking status line.

    ``  ✻ 常规思考 · 耗时 1.2s`` — amber glyph, dim label, muted elapsed time.
    Pass ``elapsed=None`` to omit the timing suffix.
    """
    elapsed_part = f" · {label_elapsed()}{elapsed:.1f}s" if elapsed is not None else ""
    return f"  {accent(symbol)} {dim(label)}{dim(elapsed_part)}"


def reasoning_panel(title: str, content: str) -> str:
    """Render a single reasoning section as a light-bordered card.

    Matches the Plan component's card visual hierarchy — amber title with a dot
    marker, dimmed monospace body, rounded light box border (┌─/└─).

    The caller is responsible for printing the returned string.
    """
    # Strip trailing blank lines to keep the box tight.
    lines = [line for line in content.splitlines() if line.strip()] or [content.strip()]
    if not lines or all(not line.strip() for line in lines):
        return ""

    h = _BOX["h2"]
    v = _BOX["v2"]
    # Estimate width from longest visible line + padding, capped to terminal.
    max_len = max((len(_strip_ansi(line)) for line in lines), default=40)
    w = min(max_len + 6, terminal_width() - 2)

    # Title bar: dot + amber label, right-padded with light horizontal rule.
    title_str = f" {accent('●')} {accent(title)} "
    visible_title = len(_strip_ansi(title_str))
    top = _BOX["tl2"] + title_str + h * max(0, w - visible_title - 2) + _BOX["tr2"]
    bottom = _BOX["bl2"] + h * (w - 2) + _BOX["br2"]

    out: list[str] = [top]
    for line in lines:
        visible = len(_strip_ansi(line))
        pad = max(0, w - visible - 4)
        out.append(f"{dim(v)} {dim(line)}{' ' * pad} {dim(v)}")
    out.append(dim(bottom))
    return "\n".join(out)


def field_row(key: str, value: str, key_color: str = "accent") -> str:
    """A left-aligned ``key  value`` row. The key is dimmed/amber, the value
    highlighted — a field line (2-space indent)."""
    key_styled = accent(key) if key_color == "accent" else muted(key)
    return f"  {key_styled}  {highlight(value)}"


def label_elapsed() -> str:
    """Localised 'elapsed' word for the thinking status line."""
    try:
        from arforge.i18n import t
        return f"{t('repl.elapsed')} "
    except Exception:  # noqa: BLE001
        return ""


# ---------------------------------------------------------------------------
# Tables
# ---------------------------------------------------------------------------

def table(headers: list[str], rows: list[list[str]], col_align: list[str] | None = None) -> str:
    """Render an ASCII table with aligned columns.

    *headers* are styled in bold.  *col_align*: list of '<' / '>' / '^' per column.
    """
    if not rows and not headers:
        return ""

    all_rows = [headers, *rows] if headers else rows
    ncols = max(len(r) for r in all_rows) if all_rows else 0
    if ncols == 0:
        return ""

    # Normalise rows
    norm = [list(r) + [""] * (ncols - len(r)) for r in all_rows]
    # Compute column widths (accounting for ANSI codes)
    widths = [0] * ncols
    for r in norm:
        for i, cell in enumerate(r):
            widths[i] = max(widths[i], len(_strip_ansi(str(cell))))

    align = (col_align or ["<"] * ncols) + ["<"] * (ncols - len(col_align or []))

    def _fmt_cell(cell: str, width: int, al: str) -> str:
        stripped = _strip_ansi(str(cell))
        pad = width - len(stripped)
        if al == ">":
            return (" " * pad) + str(cell)
        elif al == "^":
            left, right = pad // 2, pad - pad // 2
            return (" " * left) + str(cell) + (" " * right)
        else:
            return str(cell) + (" " * pad)

    lines: list[str] = []
    # Separator line
    sep = "─┼─".join("─" * w for w in widths)
    lines.append("┌─" + sep.replace("┼", "┬") + "─┐")

    for ri, r in enumerate(norm):
        cells = " │ ".join(_fmt_cell(str(c), w, al) for c, w, al in zip(r, widths, align))
        lines.append(f"│ {cells} │")
        if ri == 0 and headers:
            # Header divider
            lines.append("├─" + sep.replace("┼", "┼") + "─┤")

    lines.append("└─" + sep.replace("┼", "┴") + "─┘")
    return "\n".join(lines)


def key_value(items: list[tuple[str, str]], indent: int = 2) -> str:
    """Render key: value pairs with the key dimmed and value highlighted."""
    prefix = " " * indent
    max_key = max((len(_strip_ansi(k)) for k, _ in items), default=0)
    lines: list[str] = []
    for k, v in items:
        lines.append(f"{prefix}{muted(k.ljust(max_key))}  {highlight(v)}")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Progress / spinner
# ---------------------------------------------------------------------------

_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]


class Spinner:
    """Animated spinner shown during long operations.

    Usage::

        with Spinner("Thinking…"):
            result = do_work()
    """

    def __init__(self, message: str = "Thinking…", delay: float = 0.08):
        self.message = message
        self.delay = delay
        self._running = False
        self._thread: threading.Thread | None = None

    def _spin(self) -> None:
        i = 0
        while self._running:
            frame = _SPINNER_FRAMES[i % len(_SPINNER_FRAMES)]
            sys.stdout.write(f"\r  {info(frame)} {self.message}  ")
            sys.stdout.flush()
            time.sleep(self.delay)
            i += 1
        # Clear the spinner line
        sys.stdout.write("\r" + " " * (len(self.message) + 10) + "\r")
        sys.stdout.flush()

    def start(self) -> None:
        if not supports_color() or not sys.stdout.isatty():
            print(f"  … {self.message}")
            return
        self._running = True
        self._thread = threading.Thread(target=self._spin, daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._running = False
        if self._thread is not None:
            self._thread.join(timeout=0.5)

    def __enter__(self):
        self.start()
        return self

    def __exit__(self, *args):
        self.stop()


def progress_bar(current: int, total: int, width: int = 30, label: str = "") -> str:
    """Render a progress bar: [████████░░░░] 80% label"""
    ratio = max(0.0, min(1.0, current / total)) if total > 0 else 0.0
    filled = int(width * ratio)
    bar = "█" * filled + "░" * (width - filled)
    pct = f"{ratio:.0%}"
    lbl = f" {label}" if label else ""
    return f"[{bar}] {pct}{lbl}"


# ---------------------------------------------------------------------------
# Token budget bar
# ---------------------------------------------------------------------------

def token_bar(used: int, total: int, width: int = 30) -> str:
    """Render a token usage bar: [████████░░░░░░░░] 45%  120k/256k"""
    if total <= 0:
        return muted(f"  [{'─' * width}] no limit")
    ratio = max(0.0, min(1.0, used / total))
    filled = int(width * ratio)
    bar = "█" * filled + "░" * (width - filled)
    used_str = _format_number(used)
    total_str = _format_number(total)
    return f"  [{bar}] {ratio:.0%}  {used_str}/{total_str}"


def _format_number(n: int) -> str:
    if n >= 1_000_000:
        return f"{n / 1_000_000:.1f}M"
    if n >= 1_000:
        return f"{n / 1_000:.0f}k"
    return str(n)


# ---------------------------------------------------------------------------
# Permission / confirmation dialog
# ---------------------------------------------------------------------------

@dataclass
class PermissionPrompt:
    operation: str
    risk: str  # low / medium / high / critical
    details: str = ""
    path: str = ""
    auto_approved: bool = False

    @property
    def risk_color(self) -> str:
        return {"low": "green", "medium": "yellow", "high": "red", "critical": "bright_red"}.get(self.risk, "white")

    @property
    def risk_icon(self) -> str:
        return {"low": "●", "medium": "◐", "high": "◆", "critical": "▲"}.get(self.risk, "●")


def permission_dialog(prompt: PermissionPrompt) -> str:
    """Render a permission dialog inside a box."""
    risk_color = prompt.risk_color
    risk_text = _color_wrap(f"{prompt.risk.upper()}", _BOLD, _FG[risk_color])
    icon = _color_wrap(prompt.risk_icon, _FG[risk_color])

    lines = [
        f"{icon}  {bold(prompt.operation)}",
        f"   Risk: {risk_text}",
    ]
    if prompt.path:
        lines.append(f"   Path: {muted(prompt.path)}")
    if prompt.details:
        lines.append(f"   {dim(prompt.details)}")
    if prompt.auto_approved:
        lines.append(f"   {ok('Auto-approved (ARFORGE_AUTO_APPROVE=1)')}")

    return box("\n".join(lines), title="Permission Required", style="light", color_name=risk_color)


def request_user_confirm(prompt: PermissionPrompt) -> bool:
    """Show permission dialog and ask for confirmation.  Returns True to proceed."""
    # Critical risk is always blocked
    if prompt.risk == "critical":
        print(permission_dialog(prompt))
        print(error("  Critical risk operations are blocked by default."))
        return False

    # Check auto-approve env
    if os.getenv("ARFORGE_AUTO_APPROVE") == "1":
        prompt.auto_approved = True

    print(permission_dialog(prompt))

    if prompt.auto_approved:
        return True

    try:
        answer = input(f"  {bold('Proceed?')} [{ok('y')}/{error('n')}]: ").strip().lower()
        return answer in {"y", "yes"}
    except (KeyboardInterrupt, EOFError):
        return False




def print_banner(extra_lines: list[str] | None = None) -> None:
    """Print the Arforge welcome banner in the standard CLI style."""
    from arforge.i18n import t

    term_w = min(terminal_width(), 80)
    brand = brand_title()
    version = version_line()

    print()
    print(accent(f"  {brand}".ljust(term_w)))
    print(muted(f"  {version}"))
    print(muted_rule(term_w - 2))
    if extra_lines:
        for line in extra_lines:
            print(muted(f"  {line}"))
        print(muted_rule(term_w - 2))

    print(f"  {accent('❯')} {muted(t('banner.tip_help'))}")
    print(f"  {accent('✻')} {muted(t('banner.tip_chat'))}")
    print(f"  {accent('🌐')} {muted(t('banner.tip_lang'))}")
    print()


def print_version() -> None:
    """Print version info."""
    print(heading(f"  {brand_title()}"))
    print(f"  {version_line()}")


def print_separator(label: str = "") -> None:
    """Print a horizontal separator, optionally with a label."""
    w = terminal_width()
    if label:
        side = (w - len(label) - 4) // 2
        print(dim(f"{'─' * side}  {label}  {'─' * side}"))
    else:
        print(dim("─" * w))


# ---------------------------------------------------------------------------
# Status icon helpers
# ---------------------------------------------------------------------------

def status_icon(ok_val: bool, warning: bool = False) -> str:
    """Return a coloured status icon."""
    if ok_val and not warning:
        return ok("✔")
    if ok_val and warning:
        return warn("⚠")
    return error("✖")


def bullet(text: str, color_name: str = "white") -> str:
    """Render a bullet point with coloured text."""
    return f"  {_color_wrap('●', _FG[color_name])} {text}"


# ---------------------------------------------------------------------------
# Structured output renderers
# ---------------------------------------------------------------------------

def render_check_list(checks: list[tuple[str, bool, str, bool]]) -> str:
    """Render a diagnostic check list.

    Each item: (name, ok, detail, warning).
    """
    lines: list[str] = []
    for name, ok_val, detail, is_warn in checks:
        icon = status_icon(ok_val, is_warn)
        lines.append(f"  {icon}  {bold(name)}: {dim(detail)}")
    return "\n".join(lines)


def render_summary(ok_count: int, warn_count: int, fail_count: int) -> str:
    """Render a summary line with counts."""
    parts = []
    if ok_count:
        parts.append(ok(f"{ok_count} OK"))
    if warn_count:
        parts.append(warn(f"{warn_count} WARN"))
    if fail_count:
        parts.append(error(f"{fail_count} FAIL"))
    return "  " + "  │  ".join(parts)


def render_timing(elapsed_ms: int) -> str:
    """Render elapsed time in human-readable form."""
    if elapsed_ms < 1000:
        return muted(f"{elapsed_ms}ms")
    return muted(f"{elapsed_ms / 1000:.1f}s")


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _strip_ansi(text: str) -> str:
    """Strip ANSI escape sequences from *text*."""
    import re
    return re.sub(r"\033\[[0-9;]*m", "", text)


# ---------------------------------------------------------------------------
# Stream helpers
# ---------------------------------------------------------------------------

def print_stream_chunk(chunk: str) -> None:
    """Print a chunk of streaming output with flush."""
    print(chunk, end="", flush=True)


def print_stream_done(duration_ms: float = 0) -> None:
    """Print completion marker after streaming output.

    The elapsed label is localised via the i18n system rather than hardcoded.
    """
    if duration_ms > 0:
        from arforge.i18n import t
        label = f"{t('repl.elapsed')} {duration_ms / 1000:.1f}s"
        print(f"\n\n  {accent('●')} {dim(label)}")
    print()


# ---------------------------------------------------------------------------
# Help text builder
# ---------------------------------------------------------------------------

def format_command_help(commands: list[tuple[str, str, str]]) -> str:
    """Format a command help listing.

    Each item: (command, args, description).
    """
    max_cmd = max((len(c) + len(a) for c, a, _ in commands), default=0) + 4
    lines: list[str] = []
    for cmd, args, desc in commands:
        cmd_part = f"  {highlight(cmd)} {muted(args)}"
        pad = max(0, max_cmd - len(_strip_ansi(cmd_part)))
        lines.append(f"{cmd_part}{' ' * pad}{dim(desc)}")
    return "\n".join(lines)


def format_flag_help(flags: list[tuple[str, str]]) -> str:
    """Format a flag/option help listing."""
    max_flag = max((len(f) for f, _ in flags), default=0) + 4
    lines: list[str] = []
    for flag, desc in flags:
        flag_part = f"  {highlight(flag)}"
        pad = max(0, max_flag - len(_strip_ansi(flag_part)))
        lines.append(f"{flag_part}{' ' * pad}{dim(desc)}")
    return "\n".join(lines)
