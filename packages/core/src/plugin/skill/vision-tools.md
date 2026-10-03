# Vision Evidence Pipeline for Arforge

Use this skill whenever the task requires *seeing* an image: identifying,
understanding, describing, OCR'ing screenshots or design mockups, locating UI
elements, pixel-level restoration, or comparing images. You must convert the
image into text evidence before reasoning. Never claim to see image content
you did not observe through tools.

> The names below (glance, ground, detect, trace, pixel_diff, dominant_colors)
> are **pipeline steps**, not callable tool names. Execute them with whatever
> tools are available in the current runtime (multimodal diagnosis, read-only
> scripts, shell commands) and cite the outputs you actually produced.

## Evidence pipeline

1. **glance** — establish basic facts with the multimodal diagnosis tool
   (MultimodalDiagnosis.diagnose): image metadata (bytes, width, height,
   format), source type (image_ocr / document / missing / unsupported), and
   extracted text. Record all of it verbatim before reasoning.
2. **ground** — anchor every claim to observable text: quote OCR lines, file
   references, and signal values with their line numbers. Do not infer layout
   from vague memory of common designs.
3. **detect** — identify UI elements from grounded evidence: OCR text blocks,
   their relative order, labels, button captions, and input placeholders.
   State which elements are *observed* versus *inferred*.
4. **trace** — when the task connects an image to code, use the diagnosis
   signals (file_line, file_reference, missing_import, exception) and matches
   to locate the relevant files, then read the code before changing anything.
5. **pixel_diff** — for pixel-level comparisons, run a bounded local script
   (Python with Pillow when available) that loads both images, aligns them,
   and reports per-region difference statistics (bounding boxes, changed
   pixel counts, percentage). Quote the numbers instead of eyeballing.
6. **dominant_colors** — for palette extraction, run a bounded local script
   that quantizes the image and reports the top color clusters with hex
   values and coverage percentages. Quote the hex values in your answer.

## Rules

- Every vision claim must cite the tool output that produced it. If a tool
  cannot read the image (missing file, unsupported format), say so and stop
  rather than inventing content.
- Keep scripts read-only, timeout-bounded, and inside the workspace; never
  write into the source image.
- Use the smallest pipeline that answers the question. A simple "what is in
  this image" needs glance; pixel-exact restoration needs pixel_diff and
  dominant_colors; locating a UI element in code needs trace.
- Arforge safety, permission, and tool contracts take precedence over this
  skill text.
