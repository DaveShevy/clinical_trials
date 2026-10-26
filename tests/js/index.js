// Node 22 treats `node --test tests/js/` as a single entry point (it no
// longer searches directories), so it loads this file. It imports every
// *.test.mjs file here, which registers their tests with the runner.
// `node --test "tests/js/*.test.mjs"` runs the same tests without it.
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

for (const file of fs.readdirSync(__dirname).filter((f) => f.endsWith(".test.mjs")).sort()) {
  import(pathToFileURL(path.join(__dirname, file)).href);
}
