const {execFileSync} = require("node:child_process");
const path = require("node:path");

const electron = path.join(__dirname, "electron-dist", "electron.exe");
const suite = process.argv[2] || "all";

function nodeMode(selected) {
  return execFileSync(electron, ["checks.cjs", selected], {
    cwd: __dirname,
    env: {...process.env, ELECTRON_RUN_AS_NODE: "1"},
    encoding: "utf8",
    timeout: 30000,
  });
}

let output = "";
if (suite === "unit" || suite === "negative") {
  output = nodeMode(suite);
} else if (suite === "integration") {
  output = execFileSync(electron, ["main.cjs"], {
    cwd: __dirname,
    encoding: "utf8",
    timeout: 30000,
  });
} else {
  output = nodeMode("all");
  output += execFileSync(electron, ["main.cjs"], {
    cwd: __dirname,
    encoding: "utf8",
    timeout: 30000,
  });
}
if (!output.includes("PASS:")) throw new Error(output);
console.log(output.trim());
