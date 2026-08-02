"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  MAX_DIAGNOSTICS,
  MAX_SELECTION_CHARS,
  buildEditorContext
} = require("../ideContext");

test("builds bounded structured editor context without changing model controls", () => {
  const context = buildEditorContext({
    file: "src/app.ts",
    language: "typescript",
    selection: "x".repeat(MAX_SELECTION_CHARS + 50),
    range: {
      start: { line: 4, character: 2 },
      end: { line: 7, character: 9 }
    },
    cursor: { line: 7, character: 9 },
    diagnostics: [
      {
        severity: "error",
        message: "Type mismatch",
        source: "ts",
        code: 2322,
        range: {
          start: { line: 5, character: 1 },
          end: { line: 5, character: 8 }
        }
      }
    ]
  });

  assert.equal(context.file, "src/app.ts");
  assert.equal(context.selection.length, MAX_SELECTION_CHARS);
  assert.equal(context.range, "5:3-8:10");
  assert.equal(context.cursor, "8:10");
  assert.deepEqual(context.diagnostics, [{
    severity: "error",
    message: "Type mismatch",
    source: "ts",
    code: "2322",
    range: "6:2-6:9"
  }]);
});

test("caps diagnostics and removes empty diagnostic messages", () => {
  const diagnostics = Array.from({ length: MAX_DIAGNOSTICS + 20 }, (_, index) => ({
    severity: "warning",
    message: index === 0 ? "" : `warning-${index}`
  }));
  const context = buildEditorContext({
    file: "src/app.ts",
    cursor: { line: 0, character: 0 },
    diagnostics
  });

  assert.equal(context.diagnostics.length, MAX_DIAGNOSTICS - 1);
});
