# Internal Alpha release specification

## Goal

Produce a traceable Windows Desktop installer for controlled internal testing without representing it as a signed or public release.

## Required behavior

- The Alpha uses the existing `dev` channel and isolated `ai.arforge.desktop.dev` identity.
- A normal Alpha build refuses a dirty Git working tree.
- A local rehearsal may allow a dirty tree, but retained evidence records `source.dirty=true`.
- The installer is retained with a manifest and SHA-256 checksum file in one directory.
- Verification fails for a changed installer, changed manifest, missing file, path traversal, or relabeling as public distribution.
- GitHub packaging is manual-only, unsigned, internal-only, and retained for a bounded period.
- Desktop behavior contracts pass before packaging.

## Non-goals

- Code signing, timestamping, public GitHub Releases, website deployment and automatic updates.
- Public registration, multi-tenant authorization, billing or production user data.

## Acceptance

The procedure in `docs/INTERNAL_ALPHA_RELEASE.md` completes on an isolated Windows environment and records the commit, artifact SHA-256, tester, timestamp and result.
