# Arforge Scripts

Development and maintenance scripts live under `scripts/dev/`.

User-facing operational entry points live directly under `scripts/`.

The repository layout and the boundary between durable source, curated evidence,
local owner data, and rebuildable output are documented in
[`docs/REPOSITORY_STRUCTURE.md`](../docs/REPOSITORY_STRUCTURE.md).

- `run_desktop.ps1`: launch the installed, release, or development Desktop with an explicit workspace.
- `write_governance_evidence.py`: package GOV-01 PostgreSQL restore, credential rotation, external-copy, protected-remote and legacy-file decision proof files into audit-consumable JSON. It requires real retained inputs and does not perform the underlying governance work.
- `run_provider_fault_probe.py`: inject HTTP 429, HTTP 503 and a connection drop through a loopback HTTP/TCP proxy, then retain redacted evidence for the real-provider recovery call.
- `write_staging_load_evidence.py`: package STAGE-01 provider smoke, staging E2E, load and dogfood run metadata plus release-owner proof files into audit-consumable JSON. It requires real run IDs, metrics and retained transport-fault evidence and does not perform the validation runs.
- `write_ship_gate_evidence.py`: package SHIP-01 final immutable release approval evidence. It requires a clean release manifest, matching artifact hashes, passing prior-gate evidence and retained rollback/release-notes approval proof files.
