# TUI Layout Refresh

## Goal

Refactor the canonical `@arforge-ai/tui` interface into a keyboard-first AI coding
workspace with the information hierarchy of modern coding agents such as Claude
Code, while retaining Arforge's own colors, terminology, plugin slots, and SDK
boundaries.

## Design Direction

- Dense, dark-first terminal UI with minimal motion and strong text contrast.
- The prompt is the primary action, not the logo.
- Working directory, agent, model, and activity remain visible.
- User prompts, assistant output, tool activity, and completion metadata have
  distinct but lightweight hierarchy.
- All displayed shortcuts come from the configured keymap.
- The layout must remain usable at 72 columns and scale cleanly beyond 120 columns.

## Claude Code Reference Pass

The user-provided `20260802_144111.mp4` is the visual reference for the second
iteration. The reusable patterns observed in the recording are:

- A compact three-line product identity block at the start of the transcript:
  plain `ARFORGE` wordmark, one product-introduction line, then one workspace line.
- Full-width, low-contrast user prompt bands instead of card-like chat bubbles.
- Lightweight `Thought for …` and running summaries that preserve transcript flow.
- A bottom composer framed by two horizontal rules, with a plain `>` prompt marker
  and one dense mode/shortcut line below it.
- Product identity scrolls with the transcript; the input remains the fixed anchor.

Arforge keeps its own brand mark, semantic colors, Chinese labels, configured
shortcuts, agent/model selection, permissions, plugin slots, and tool renderers.

## Scenarios

### Home

- Given a user opens the TUI, the interface shows a compact Arforge identity,
  current agent/model, a clear task question, and the prompt without requiring
  scrolling.
- Given a narrow terminal, secondary copy compresses before the prompt loses usable
  width.

### Session

- Given an active session, the interface shows the ARFORGE wordmark and activity
  state in a persistent header.
- Given enough width, the header also shows the working directory, agent, model,
  and the discoverable `/move` workspace action.
- Given a busy or retrying session, status is communicated with both text and color.

### Conversation

- User messages are introduced by a prompt marker and retain file/queue metadata.
- Assistant messages show agent/model identity before streamed content and completion
  metadata after content.
- Tool, reasoning, permission, question, and plugin rendering behavior remains intact.

### Prompt

- The composer uses top and bottom rules with a leading `>` prompt marker.
- Agent/mode metadata lives in the footer instead of competing with typed content.
- Submit, newline, command palette, usage, interrupt, retry, and workspace feedback
  continue to use configured shortcuts and live state.

## Verification

- Add deterministic character-frame coverage for the new Home and Session chrome.
- Run package-local TUI tests and typecheck.
- Run the Arforge CLI interactively and capture Home and Session layouts at practical
  Windows Terminal dimensions.
- Confirm the root repository has no unrelated TUI changes before delivery.
