// What the agent tool surface costs. Tool schemas are sent on every request, so
// their size is a running tax; the guide is fetched once, on demand. Run this
// when changing a description to see the bill before and after.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const manifest = JSON.parse(
  await readFile(resolve(root, "browser/tools.json"), "utf8"),
);
const guide = await readFile(
  resolve(root, `browser/${manifest.guide.file}`),
  "utf8",
);

// The guide tool is served locally rather than over the harness socket, but its
// schema is sent with all the others, so the bill includes it.
const served = [
  ...manifest.tools,
  { ...manifest.guide, properties: {}, required: [] },
];
const schemas = served.map((tool) => ({
  name: tool.name,
  description: tool.description,
  inputSchema: {
    type: "object",
    properties: tool.properties,
    required: tool.required,
    additionalProperties: false,
  },
}));

const perRequest = JSON.stringify(schemas).length;
const prose = served.reduce(
  (total, tool) => total + tool.description.length,
  0,
);
const approxTokens = (bytes) => Math.round(bytes / 4);

console.log(`tools               ${served.length}`);
console.log(
  `sent every request  ${perRequest} bytes  (~${approxTokens(perRequest)} tokens)`,
);
console.log(
  `  of which prose    ${prose} bytes  (~${approxTokens(prose)} tokens)`,
);
console.log(
  `read once, on call  ${guide.length} bytes  (~${approxTokens(guide.length)} tokens)  ${manifest.guide.file}`,
);
console.log("\nlongest descriptions");
for (const tool of [...served]
  .sort((a, b) => b.description.length - a.description.length)
  .slice(0, 5)) {
  console.log(`  ${String(tool.description.length).padStart(4)}  ${tool.name}`);
}
