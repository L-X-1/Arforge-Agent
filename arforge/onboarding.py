"""First-run onboarding wizard — guided API Key + model configuration.

Behaviour:
1. Detect whether onboarding is needed (no API key configured)
2. Walk through: Welcome → API Key → Model → Test → Ready
3. Write .env on completion
4. Handle skip (Ctrl+C), retry, and error gracefully
"""

from __future__ import annotations

import os
from getpass import getpass
from pathlib import Path

from arforge.i18n import t, get_active_lang


# ========================================================================
# Detection
# ========================================================================

_PROVIDER_API_KEY_ENVIRONMENTS = (
    "DEEPSEEK_API_KEY",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
)


def _provider_configured() -> bool:
    """Return whether any supported active provider can create an adapter.

    The desktop settings flow stores credentials encrypted instead of exporting
    them into the CLI environment.  Looking only at ``DEEPSEEK_API_KEY`` makes
    a configured OpenAI/compatible provider look like a first run and blocks a
    non-interactive ``arforge code`` invocation inside ``getpass()``.
    """
    if any(os.getenv(name, "").strip() for name in _PROVIDER_API_KEY_ENVIRONMENTS):
        return True
    try:
        from arforge.product.model_config_runtime import get_model_config

        return bool(get_model_config().get_resolved_config().get("resolved"))
    except Exception:
        # Onboarding is also the recovery path for unreadable or incomplete
        # configuration, so configuration failures must fail closed here.
        return False


def is_first_run() -> bool:
    """Return True if no supported model provider is configured."""
    return not _provider_configured()


def onboarding_completed() -> bool:
    """Return True if a supported environment or encrypted provider is ready."""
    return _provider_configured()


# ========================================================================
# Helpers
# ========================================================================

def _env_path() -> Path:
    """Return the private per-user configuration path."""
    configured = os.environ.get("ARFORGE_HOME")
    home = Path(configured).expanduser() if configured else Path.home() / ".arforge"
    return home / ".env"


def _append_env(key: str, value: str) -> None:
    """Append or update a key=value line in the .env file."""
    if not key or any(character not in "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_" for character in key):
        raise ValueError("environment variable name is invalid")
    if "\n" in value or "\r" in value:
        raise ValueError("environment variable value must be a single line")
    env_path = _env_path()
    env_path.parent.mkdir(parents=True, exist_ok=True)
    lines: list[str] = []
    found = False
    if env_path.exists():
        lines = env_path.read_text(encoding="utf-8").splitlines()
        for i, line in enumerate(lines):
            if line.startswith(f"{key}=") or line.startswith(f"# {key}="):
                lines[i] = f"{key}={value}"
                found = True
                break
    if not found:
        lines.append(f"{key}={value}")
    env_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    try:
        env_path.chmod(0o600)
    except OSError:
        pass
    os.environ[key] = value


def _secret_input(prompt: str) -> str:
    """Read a credential without echoing it to the terminal."""
    try:
        return getpass(f"  {prompt}: ").strip()
    except (KeyboardInterrupt, EOFError):
        print()
        return ""


def _box_print(text: str, color_name: str = "") -> None:
    """Print text inside a simple Unicode box."""
    from arforge.cli_ui import box as ui_box
    print()
    print(ui_box(text, color_name=color_name))
    print()


def _colored_input(prompt: str) -> str:
    """Prompt the user for input with a colored prompt."""
    from arforge.cli_ui import bold
    try:
        return input(f"  {bold(prompt)}: ").strip()
    except (KeyboardInterrupt, EOFError):
        print()
        return ""


# ========================================================================
# Individual steps
# ========================================================================

def _step_welcome(lang: str) -> None:
    """Show welcome screen with feature highlights."""
    welcome_text = f"""{t('onboarding.welcome_subtitle', lang)}

  {t('onboarding.what_is_arforge', lang)}

    {t('onboarding.feature_chat', lang)}
    {t('onboarding.feature_tools', lang)}
    {t('onboarding.feature_memory', lang)}
    {t('onboarding.feature_privacy', lang)}

  {t('onboarding.skip_hint', lang)}"""

    _box_print(welcome_text, color_name="cyan")


def _step_api_key(lang: str) -> str | None:
    """Prompt for API key.  Returns the key or None to skip."""
    from arforge.cli_ui import muted, warn, error as err, bold

    print(bold(f"  {t('onboarding.step_api_key', lang)}"))
    print()
    print(muted(f"  {t('onboarding.api_key_guide', lang)}"))
    print()

    for attempt in range(3):
        key = _secret_input(f"{t('onboarding.enter_api_key', lang)} (sk-...)")
        if not key:
            print(err(f"  {t('onboarding.api_key_empty', lang)}"))
            if attempt < 2:
                continue
            return None
        if not key.startswith("sk-"):
            confirm_msg = "  API Key should start with sk-. Confirm? (y/n)"
            print(warn(confirm_msg))
            confirm = _colored_input("y/n").lower()
            if confirm not in {"y", "yes", "是"}:
                continue
        return key
    return None


def _step_model(lang: str) -> str:
    """Prompt for model selection.  Returns model name."""
    from arforge.cli_ui import bold, muted, ok, highlight

    print(bold(f"  {t('onboarding.step_model', lang)}"))
    print()
    print(muted(f"  {t('onboarding.model_description', lang)}"))
    print()
    print(f"    {highlight('[1]')} deepseek-v4-flash — product test baseline")
    print(f"    {highlight('[2]')} deepseek-v4-pro   — official flagship model")
    print()

    model_map = {
        "1": "deepseek-v4-flash",
        "2": "deepseek-v4-pro",
    }

    for _ in range(3):
        choice = _colored_input(f"{t('onboarding.select_model', lang)} (默认: 1)")
        if not choice:
            choice = "1"
        if choice in model_map:
            model = model_map[choice]
            print(ok(f"  {t('onboarding.model_selected', lang)}: {model}"))
            return model
        print("  请输入 1 或 2")

    return "deepseek-v4-flash"


def _step_test(lang: str, key: str, model: str) -> bool:
    """Test the API connection.  Returns True on success."""
    from arforge.cli_ui import Spinner, ok, error as err, warn

    print()
    with Spinner(t('onboarding.testing', lang)):
        try:
            # Try a minimal API call
            from arforge.models.deepseek_adapter import DeepSeekAdapter
            # Override env for this test
            old_key = os.environ.get("DEEPSEEK_API_KEY")
            old_model = os.environ.get("DEEPSEEK_MODEL")
            os.environ["DEEPSEEK_API_KEY"] = key
            os.environ["DEEPSEEK_MODEL"] = model
            try:
                # Construct after applying the temporary values: adapters read
                # credentials and the selected model during initialization.
                adapter = DeepSeekAdapter()
                messages = [{"role": "user", "content": "Hi"}]
                _ = adapter.generate(messages, max_tokens=32)
                print(ok(f"\n  {t('onboarding.test_success', lang)}"))
                return True
            finally:
                if old_key:
                    os.environ["DEEPSEEK_API_KEY"] = old_key
                else:
                    os.environ.pop("DEEPSEEK_API_KEY", None)
                if old_model:
                    os.environ["DEEPSEEK_MODEL"] = old_model
                else:
                    os.environ.pop("DEEPSEEK_MODEL", None)
        except Exception as exc:
            # Sanitise: strip any API-key-like strings from error messages
            from arforge.security_guard import sanitize_log_message
            safe_msg = sanitize_log_message(str(exc))
            print(err(f"\n  {t('onboarding.test_failed', lang)}: {safe_msg}"))
            print(warn(f"  {t('onboarding.test_failed_detail', lang)}"))
            return False


def _step_ready(lang: str) -> None:
    """Show completion screen."""
    _box_print(t('onboarding.ready_message', lang), color_name="green")


# ========================================================================
# Main wizard
# ========================================================================

def run_onboarding(lang: str | None = None) -> bool:
    """Run the first-run onboarding wizard.

    Returns True if onboarding completed successfully.
    Returns False if the user skipped or setup failed.
    """
    lang = lang or get_active_lang()

    # Welcome
    _box_print(t('onboarding.welcome_title', lang), color_name="cyan")
    _step_welcome(lang)

    # Step 1: API Key
    api_key = _step_api_key(lang)
    if not api_key:
        from arforge.cli_ui import warn
        print(warn("\n  API Key not configured. You can configure it later:\n"
                   "  1) Create a .env file with DEEPSEEK_API_KEY=sk-...\n"
                   "  2) Run arforge doctor to check configuration"))
        return False

    # Save key immediately
    _append_env("DEEPSEEK_API_KEY", api_key)

    # Step 2: Model
    model = _step_model(lang)
    _append_env("DEEPSEEK_MODEL", model)

    # Step 3: Test connection
    _step_test(lang, api_key, model)

    # Step 4: Ready
    _step_ready(lang)

    # Reload config so the agent can use the new values
    try:
        from dotenv import load_dotenv
        load_dotenv(_env_path(), override=True)
    except Exception:
        pass

    return True


# ========================================================================
# Quick-start (non-interactive)
# ========================================================================

def ensure_configured() -> bool:
    """Check configuration; if missing, offer to run the wizard.

    Returns True when the agent is ready to use.
    """
    if onboarding_completed():
        return True

    from arforge.cli_ui import warn, info

    print()
    warn("  DeepSeek API Key not configured. Arforge needs an API Key to call the model.")
    info("  Starting setup wizard…")
    print()

    return run_onboarding()
