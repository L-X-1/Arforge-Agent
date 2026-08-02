# Signed Windows Beta release

## Intent

Produce a limited-distribution Windows Beta candidate whose Electron application
executables and NSIS installer are signed by a publicly trusted code-signing
identity held in a cloud HSM. No public GitHub Release or website publication is
part of this phase.

## Supported signing provider

The first production path is DigiCert KeyLocker because its KSP/SMCTL client has
an explicit Electron Builder integration. Microsoft Artifact Signing remains a
future provider option, but its Public Trust onboarding is not currently
available to a mainland-China legal identity.

## Required external inputs

- A validated IV, OV, or EV public code-signing certificate in DigiCert KeyLocker.
- A KeyLocker keypair alias with a default certificate.
- A DigiCert Software Trust API key and client-authentication certificate.
- A GitHub environment named `desktop-release-candidate` with required reviewers,
  self-review prevention, deployment branch restrictions, and admin bypass
  disabled where the repository plan supports those controls.
- An expected Windows signer subject stored as a GitHub environment variable.

The public code-signing private key must never be exported into the repository,
workflow, runner filesystem, or a GitHub secret. The short-lived client
authentication certificate is not the code-signing private key and must be
removed from the runner after the signing step.

## Scenarios

### Signed candidate succeeds

Given a clean reviewed commit and a protected environment approval, when the
signed-candidate workflow builds the Beta channel, Electron Builder delegates
each Windows signing operation to SMCTL. The workflow must then prove that the
final NSIS installer has a valid Authenticode signature, has an RFC 3161
timestamp certificate, and matches the expected signer subject.

### Missing or wrong signing identity fails closed

If the provider credentials, keypair alias, expected signer subject, valid
signature, or timestamp certificate is absent, the workflow must fail and must
not upload a distributable candidate.

### Evidence remains manual until reviewed

Technical evidence alone does not open the release gate. A release owner must
review the protected-environment run and the certificate custody record and bind
that review to the workflow run, commit, signer thumbprint, timestamp identity,
and installer hash.

## Acceptance criteria

- The repository no longer requires a nonexistent MSI artifact for signing.
- Beta CI invokes a cloud-HSM signer from inside Electron Builder.
- The final retained NSIS file hash matches the signed-candidate evidence.
- PowerShell reports `Status=Valid` and a non-null timestamp certificate.
- The evidence records the cloud provider and `private_key_export_blocked=true`.
- Signing credentials are scoped to `desktop-release-candidate` and the runner
  client-authentication file is deleted even when the job fails.
- The workflow only uploads a private Actions artifact; public release remains
  out of scope.
