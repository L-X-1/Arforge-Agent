# Workbench: isolated HTML/CSS live preview, first increment

Date: 2026-09-14

## Delivered scope

- HTML files still open in read-only Source mode; Preview and Split are explicit actions.
- The HTML editor has a Live preview toggle. Its unsaved buffer refreshes the frame after a 200 ms debounce. Previewing never writes a file.
- Toggling preview does not remount the CodeMirror editor or intentionally reset its undo history.
- Source and preview stack in narrow containers and use separate scroll regions.
- HTML goes through inert template parsing, active-resource removal and a private DOMPurify instance. Only the sanitized fragment enters an iframe with an empty sandbox permission list.
- A leading CSP denies scripts, network connections, external styles, fonts, media, frames, object content, form submissions and base URL changes. Only inline CSS and embedded raster images are intentionally supported.
- Links, navigation attributes, document refresh metadata, nested frames, SVG/MathML, custom elements and file-upload controls are not supported by this adapter.
- The fragment parser intentionally drops html/head/body wrapper attributes. Use CSS rules targeting html/body for their styling in this increment. This is not a full-fidelity browser replacement.
- The 500,000-character preview limit is independent of the buffer. Failure is local to the preview and does not write or discard the edit.

## Security references

The iframe has neither allow-scripts nor allow-same-origin; see [MDN iframe sandbox](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe#sandbox). Its srcdoc is a rendering sink, never host innerHTML; see [MDN srcdoc security considerations](https://developer.mozilla.org/en-US/docs/Web/API/HTMLIFrameElement/srcdoc#security_considerations).

Sanitization runs in the actual browser, not server-side happy-dom. Security behavior is exercised by Chromium acceptance tests, following the [DOMPurify environment guidance](https://github.com/cure53/DOMPurify).

## Verification entry points

- html-preview-policy.test.ts and the existing registry, Markdown, text editing, history rail and keyboard resize tests.
- Application and E2E typechecks.
- html-preview.spec.ts plus existing file-preview.spec.ts, text-editor.spec.ts, history-rail.spec.ts and the isolated production streaming benchmark.

## Not yet delivered from the complete HTML plan

Arbitrary JavaScript execution, independent preview resource hosting, relative workspace CSS/script/image access, element picking, source-range mapping and AI change proposals remain follow-up increments. Browser test mocks do not certify the packaged Electron application. No running application or server is restarted for this work.
