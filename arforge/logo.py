"""Terminal ASCII logo for Arforge Agent.

Renders a stylised banner with colour gradients matching the Arforge brand.
"""
from __future__ import annotations

from arforge.cli_ui import supports_color, fg as _fg, bold as _bold, dim as _dim
from arforge.locale import VERSION, STAGE


# ========================================================================
# Logo variants
# ========================================================================

LOGO_MAIN = r"""
   █████╗ ██████╗ ███████╗ ██████╗ ██████╗  ██████╗ ███████╗
  ██╔══██╗██╔══██╗██╔════╝██╔═══██╗██╔══██╗██╔════╝ ██╔════╝
  ███████║██████╔╝█████╗  ██║   ██║██████╔╝██║  ███╗█████╗
  ██╔══██║██╔══██╗██╔══╝  ██║   ██║██╔══██╗██║   ██║██╔══╝
  ██║  ██║██║  ██║██║     ╚██████╔╝██║  ██║╚██████╔╝███████╗
  ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝      ╚═════╝ ╚═╝  ╚═╝ ╚═════╝ ╚══════╝
"""

LOGO_SUBTITLE = r"""
  AI DEVELOPMENT AGENT
"""

LOGO_COMPACT = r"""
    ╭──────────────────────────────────────────╮
    │     A R F O R G E    A G E N T           │
    │     智能开发代理 · 本地优先 · CLI          │
    ╰──────────────────────────────────────────╯
"""


# ========================================================================
# Rendering
# ========================================================================

def render_logo(compact: bool = False) -> str:
    """Return the full-colour logo as a string.

    Set *compact* to True for a single-line box variant.
    """
    if compact:
        return _render_compact()
    return _render_full()


def _render_full() -> str:
    """Full banner logo with ASCII art."""
    lines: list[str] = []

    # Top padding
    lines.append("")

    # ASCII logo with gradient
    logo_lines = LOGO_MAIN.strip("\n").split("\n")
    for li, line in enumerate(logo_lines):
        # Gradient from cyan to bright cyan
        t = li / max(len(logo_lines) - 1, 1)
        if supports_color():
            if t < 0.33:
                colored = _fg(line, "cyan")
            elif t < 0.66:
                colored = _fg(line, "bright_cyan")
            else:
                colored = _fg(line, "bright_blue")
            lines.append(f"  {colored}")
        else:
            lines.append(f"  {line}")

    lines.append("")

    for line in LOGO_SUBTITLE.strip("\n").split("\n"):
        lines.append(f"  {_bold(line)}")

    lines.append("")

    # Version + provider-neutral runtime tagline.
    tagline = f"  {_dim('v' + VERSION + ' ' + STAGE + '  ·  ' + '智能开发代理运行时')}"
    lines.append(tagline)
    lines.append(f"  {_dim('本地优先 · 隐私至上 · 持续学习')}")
    lines.append("")

    return "\n".join(lines)


def _render_compact() -> str:
    """Compact single-box logo for tight terminals."""
    lines = LOGO_COMPACT.strip("\n").split("\n")
    result: list[str] = [""]
    for line in lines:
        result.append(f"  {_fg(line, 'cyan')}")
    result.append("")
    return "\n".join(result)


def render_splash(duration_ms: int = 0) -> str:
    """Render the splash/loading screen shown briefly on startup.

    If *duration_ms* > 0, includes a subtle loading indicator.
    """
    return render_logo()


def print_logo(compact: bool = False, clear_screen: bool = True) -> None:
    """Print the logo to stdout.

    When *clear_screen* is True, the terminal is cleared first so the logo
    appears as a fresh screen.
    """
    import sys
    if clear_screen:
        # ANSI clear screen + move cursor to home
        sys.stdout.write("\033[2J\033[H")
        sys.stdout.flush()
    print(render_logo(compact=compact))
