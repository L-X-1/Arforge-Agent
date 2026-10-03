"""Allow ``python -m arforge`` to enter the unified TypeScript CLI."""

from arforge.cli_bridge import main


if __name__ == "__main__":
    raise SystemExit(main())
