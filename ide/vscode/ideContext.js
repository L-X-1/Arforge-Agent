"use strict";

const MAX_SELECTION_CHARS = 20000;
const MAX_DIAGNOSTICS = 100;
const MAX_DIAGNOSTIC_MESSAGE_CHARS = 2000;

function positionText(position) {
  return `${Number(position?.line || 0) + 1}:${Number(position?.character || 0) + 1}`;
}

function rangeText(range) {
  if (!range) return "";
  return `${positionText(range.start)}-${positionText(range.end)}`;
}

function buildEditorContext(input) {
  const selection = String(input.selection || "").slice(0, MAX_SELECTION_CHARS);
  const diagnostics = (input.diagnostics || []).slice(0, MAX_DIAGNOSTICS).map((item) => ({
    severity: ["error", "warning", "information", "hint"].includes(item.severity)
      ? item.severity
      : "information",
    message: String(item.message || "").slice(0, MAX_DIAGNOSTIC_MESSAGE_CHARS),
    ...(item.source ? { source: String(item.source).slice(0, 256) } : {}),
    ...(item.code ? { code: String(item.code).slice(0, 256) } : {}),
    ...(item.range ? { range: rangeText(item.range) } : {})
  })).filter((item) => item.message);
  return {
    file: String(input.file || ""),
    language: String(input.language || "").slice(0, 256),
    cursor: positionText(input.cursor),
    ...(selection ? { selection, range: rangeText(input.range) } : {}),
    ...(diagnostics.length ? { diagnostics } : {})
  };
}

module.exports = {
  MAX_SELECTION_CHARS,
  MAX_DIAGNOSTICS,
  buildEditorContext,
  positionText,
  rangeText
};
