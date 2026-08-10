import { readdir, readFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";

const assetDir = new URL("../dist/assets/", import.meta.url);
const files = await readdir(assetDir);

async function size(name) {
  const bytes = await readFile(new URL(name, assetDir));
  return { raw: bytes.byteLength, gzip: gzipSync(bytes).byteLength };
}

async function matching(pattern) {
  const names = files.filter((name) => pattern.test(name));
  const sizes = await Promise.all(names.map(size));
  return {
    names,
    raw: sizes.reduce((total, item) => total + item.raw, 0),
    gzip: sizes.reduce((total, item) => total + item.gzip, 0),
  };
}

const budgets = [
  {
    label: "startup JS",
    pattern: /^index-.*\.js$/,
    raw: 470_000,
    gzip: 150_000,
  },
  {
    label: "CodeMirror lazy chunk",
    pattern: /^codemirror-.*\.js$/,
    raw: 900_000,
    gzip: 320_000,
  },
  {
    label: "xterm core lazy chunk",
    pattern: /^xterm-(?!webgl).*\.js$/,
    raw: 430_000,
    gzip: 115_000,
  },
  { label: "all JavaScript", pattern: /\.js$/, raw: 2_350_000, gzip: 750_000 },
  {
    label: "application CSS",
    pattern: /^index-.*\.css$/,
    raw: 220_000,
    gzip: 37_000,
  },
];

let failed = false;
for (const budget of budgets) {
  const actual = await matching(budget.pattern);
  if (actual.names.length === 0) {
    console.error(`performance budget: ${budget.label} chunk is missing`);
    failed = true;
    continue;
  }
  const withinBudget = actual.raw <= budget.raw && actual.gzip <= budget.gzip;
  const summary = `${budget.label}: raw ${actual.raw}/${budget.raw}, gzip ${actual.gzip}/${budget.gzip}`;
  if (withinBudget) console.log(`performance budget ok: ${summary}`);
  else {
    console.error(
      `performance budget exceeded: ${summary} (${actual.names.join(", ")})`,
    );
    failed = true;
  }
}

if (failed) process.exitCode = 1;
