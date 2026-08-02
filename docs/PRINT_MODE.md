# Non-interactive print mode

Print mode runs prompts through the same `SessionRuntime`, model routing,
reasoning-effort selection, tool registry, permission checks, compaction and
conversation history used by interactive Arforge sessions. It is intended for
shell scripts, CI jobs and editor integrations that need stable output.

## Text input and output

```powershell
arforge --print -p "Inspect this workspace and report the test command."
"Summarize this patch" | arforge --print
arforge --quiet -p "Return only the final answer."
```

`--quiet` is the final-answer-only text shortcut. Without it, answer tokens are
streamed to stdout and tool progress is written to stderr.

## JSONL streaming

Use `--output-format stream-json` for newline-delimited assistant and tool
messages:

```powershell
arforge --print -p "Read pyproject.toml" --output-format stream-json
```

Use `--input-format stream-json` to process multiple user messages in one
isolated session until stdin reaches EOF:

```json
{"role":"user","content":"Inspect the project."}
{"role":"user","content":[{"type":"text","text":"Now summarize the risks."}]}
```

```powershell
Get-Content .\prompts.jsonl |
  arforge --print --input-format stream-json --output-format stream-json
```

Tool calls use function-call records and tool results refer back to their
`tool_call_id`. Arguments and results are recursively redacted for credential
fields and bounded to keep each Bridge-compatible event below its protocol
limit. Internal reasoning is never written to the machine-readable stream.

## Permissions and exit codes

Non-interactive mode defaults to `autoApprove` so routine actions do not block
on an unavailable terminal prompt. Arforge's sandbox and risk rules remain in
force; critical actions still fail closed unless the selected permission mode
explicitly allows them.

Exit codes are stable:

- `0`: every input message completed successfully.
- `1`: invalid input, a permanent failure, cancellation, or an incomplete run.
- `75`: a transient provider, rate-limit, connection, service, or timeout
  failure that an automation may retry.

Print mode never creates a reduced model path: model-specific context limits,
automatic compaction, tools and the selected reasoning effort remain active.
