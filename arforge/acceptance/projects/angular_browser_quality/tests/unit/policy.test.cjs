const test = require("node:test");
const assert = require("node:assert/strict");

function normalizeTitle(value) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new Error("title is required");
  return normalized;
}

test("title policy normalizes and rejects invalid input", () => {
  assert.equal(normalizeTitle("  depth  "), "depth");
  assert.throws(() => normalizeTitle("   "), /required/);
});
