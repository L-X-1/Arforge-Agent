# Arforge-Agent fusion architecture audit

This document defines the source-level acceptance boundary for the unified
private product in `E:\Arforge-Agent`. It deliberately does not treat release
packaging, signing, publishing, hosted documentation or public deployment as
requirements.

## Canonical runtime

| Surface | Canonical implementation |
|---|---|
| CLI and local server | `packages/arforge/src/index.ts` |
| Desktop main process | `packages/desktop/src/main/index.ts` |
| Desktop renderer | `packages/desktop/src/renderer/index.tsx` |
| Shared application | `packages/app/src/entry.tsx` |
| Restricted Python capabilities | `packages/agent-python` and the root `arforge/` capability engine |

The root `dev`, `cli`, `dev:desktop` and `dev:web` scripts point only to these
current implementations. Legacy Python CLI and Tauri scripts are explicitly
named `legacy:*`; they are retained only as Tier 2 behavior references until
the owner approves their exact deletion list.

## Automated source boundary

Run:

```powershell
cd E:\Arforge-Agent
.\.tools\bun-1.3.14\bun.exe run fusion:audit
```

The audit verifies:

- the repository root is `Arforge-Agent`;
- default product scripts and their entrypoint files are present and current;
- every workspace package is private, `UNLICENSED`, uniquely named and free
  from repository, homepage, author, funding and publishing metadata;
- product-facing manifests use `1.0.0-test.1`;
- first-party LICENSE/LICENCE/COPYING/NOTICE files are absent;
- no first-party reparse point escapes the repository;
- runtime source contains no absolute or resolving relative dependency on the
  external reference tree;
- local relative references such as `packages/desktop -> packages/arforge`
  are resolved before classification and are therefore not false positives.

`ghostty-web` and `gitlab-ai-provider` are intentionally retained package
identities. They are private vendored compatibility packages: terminal imports
and GitLab provider discovery use these protocol names. They are not Arforge
product branding and renaming them would break compatibility without adding
ownership or isolation.

## Unified gate

Run:

```powershell
.\.tools\bun-1.3.14\bun.exe run fusion:verify
```

This executes, in order:

1. repository fusion boundary;
2. private brand boundary;
3. all 191 legacy Bridge method ownership checks;
4. workspace type checks.

The verifier injects the repository-pinned Bun directory into child-process
`PATH`, so Turbo uses the same toolchain instead of depending on a machine-wide
Bun installation.

## Current evidence

Evidence recorded on 2026-07-28:

- fusion audit: 0 findings, 28 manifests, 6,461 files visited, 5,793 text files
  scanned, 0 first-party reparse points;
- brand audit: 0 findings;
- legacy ownership: 191 of 191 methods have exactly one owner;
- workspace type checking: 23 typecheck tasks across 27 packages passed;
- Core: 1,116 passed, 7 conditional skips, 0 failed across 161 test files;
- App: 686 passed, 0 failed across 102 test files;
- Python capability engine: 2,984 passed, 7 conditional skips, 0 failed
  across all 268 test files;
- running Electron interaction: menu dismissal, session operations and model
  switching verified with real Chromium input events.

The Python full-text code search was also moved from an unpruned `Path.rglob`
walk to the shared project scanner. On the fused workspace, the M4 code
intelligence acceptance suite improved from more than six minutes without
completion to 16.1 seconds while retaining all 25 assertions. Dependency
stores, toolchains, build output and runtime artifacts are no longer indexed
as owned source.

Generated dependency stores and downloaded toolchains retain their own legal
files. They are not first-party Arforge source and are excluded from this
source-ownership assertion.
