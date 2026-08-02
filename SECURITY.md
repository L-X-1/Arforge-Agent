# Security Policy

## Supported versions

Arforge Agent is currently an internal Alpha. No version is yet covered by a public security-support guarantee.

## Reporting a vulnerability

Do not open a public issue containing credentials, exploit details or private user data. Until a private security contact is configured for the project, report findings directly to the repository owner through an agreed private channel.

Include the affected version, platform, reproduction steps, impact and any safe mitigation. Remove secrets and personal data from logs before sharing them.

## Response expectations

The maintainer should acknowledge a report, assess severity, rotate exposed credentials immediately, preserve relevant evidence and publish a patched release only after the release gates in `docs/RELEASE_RUNBOOK.md` pass.

## Product security boundaries

- Tool actions are scoped to the active workspace and medium/high-risk actions require confirmation.
- Non-interactive approval fails closed unless automation explicitly opts in.
- Model API calls send user-provided context to the configured provider; users should not submit secrets they do not intend to share with that provider.
- Local user data is stored under `~/.arforge` by default and can be inventoried, exported or cleared through the CLI.
