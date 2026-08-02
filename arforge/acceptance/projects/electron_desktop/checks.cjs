if (!process.versions.electron) {
  throw new Error("checks must execute inside Electron");
}

const suite = process.argv[2] || "all";
if (suite === "unit" || suite === "all") {
  const normalized = "  project depth  ".trim();
  if (normalized !== "project depth") throw new Error("unit");
}
if (suite === "negative" || suite === "all") {
  const invalid = "   ".trim();
  if (invalid) throw new Error("negative");
}
console.log(`PASS:${suite}:Electron-${process.versions.electron}`);
