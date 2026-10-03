# Video-inspired Arforge workbench

The accepted plan is to extend the Electron/Solid workbench with prompt history
navigation, file previews and editing, HTML selection, Office adapters, browser
views and correctly scoped AI collaboration.

The first implementation increment delivers the explicitly requested current-
conversation prompt rail and keyboard-accessible panel sizing. It reuses existing
message anchors, history pagination and the existing file/panel architecture.

Acceptance scenarios:
- Each visible marker represents a human prompt in the current session.
- Hover/focus previews that prompt and a bounded assistant reply excerpt.
- Clicking reveals the prompt in the virtualized timeline without switching sessions.
- New assistant output does not steal the viewport after a history jump.
- Earlier history can be loaded; failure is visible and retryable.
- Marker rendering is bounded for long conversations; keyboard navigation reaches
  turns outside the mounted marker window.
- Horizontal and vertical splitters support arrows, Home/End and visible focus.

Remaining work continues through the accepted P2-P8 preview, document, browser,
coordination and packaging stages. This increment does not claim those features.

The next increment introduces a shared preview registry and per-file failure
boundary in both existing file-view layouts. Existing source/media renderers and
line-comment context behavior remain in place. HTML and Markdown are source-only;
Office/PDF adapters are explicitly unavailable rather than presented as working.

Preview acceptance scenarios:
- Windows paths and MIME metadata route to the appropriate preview category.
- Opening HTML source never executes that document's scripts in the host window.
- Unsupported binary/Office formats show a bounded notice, not encoded contents.
- A failed file read offers retry without taking down the conversation or sidebar.
- Refresh reloads the file through the existing file service, without writing it.
- Renderer exceptions are isolated by a per-document error boundary.

Workspace-shared tabs, richer Markdown/HTML rendering, Office adapters and actual
document editing remain separate pending increments, not delivered by this shell.

The next read-only Markdown increment adds an explicit Source/Preview switch for
plain Markdown (not MDX), using the existing parser, highlighter and sanitizer.
Additional document isolation removes forms, resource URLs and unsafe navigation;
images remain placeholders until a scoped local-resource resolver is integrated.
HTTP links open through the platform only after an explicit click. Rich preview
is bounded to 500,000 characters; source viewing remains available. Refresh keeps
the selected viewing mode. Editing, saving and precise selection mapping are not
part of this increment.

Markdown also offers a read-only Split mode: source and rendered output use
independent, keyboard-focusable scroll regions. Wide preview containers place
them side by side; narrow containers stack them. Refresh preserves Split mode.
This does not add editing, synchronized scrolling or persistent pane positions.
