"""Locale and display text helpers — integrated with the i18n system."""

from __future__ import annotations

BRAND_NAME = "Arforge Agent"
BRAND_NAME_ZH = "Arforge Agent"
VERSION = "1.0.0-test.1"
STAGE = "Alpha"


def brand_title() -> str:
    return BRAND_NAME if BRAND_NAME_ZH == BRAND_NAME else f"{BRAND_NAME}（{BRAND_NAME_ZH}）"


def version_line() -> str:
    return f"{brand_title()} v{VERSION} {STAGE}"


def get_lang() -> str:
    """Return the active UI language ('zh' or 'en'), delegating to i18n."""
    from arforge.i18n import get_active_lang
    return get_active_lang()


def set_lang(lang: str) -> str:
    """Set and persist the active UI language."""
    from arforge.i18n import set_active_lang
    return set_active_lang(lang)
