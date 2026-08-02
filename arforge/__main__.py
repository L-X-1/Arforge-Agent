"""Allow ``python -m arforge`` to behave like the installed CLI command."""

from arforge.cli import main


if __name__ == "__main__":
    raise SystemExit(main())
