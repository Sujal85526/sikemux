import { readdir, readFile } from "node:fs/promises";
import { Linter } from "eslint";
import globals from "globals";

const assetDir = new URL("../dist/assets/", import.meta.url);
const files = (await readdir(assetDir))
  .filter((name) => name.endsWith(".js"))
  .sort();

if (files.length === 0) {
  throw new Error("bundle globals: no JavaScript assets found");
}

const linter = new Linter({ configType: "flat" });
const languageGlobals = {
  ...globals.browser,
  // React and xterm use guarded references to these optional host globals.
  __REACT_DEVTOOLS_GLOBAL_HOOK__: "readonly",
  process: "readonly",
  setImmediate: "readonly",
};
const failures = [];

for (const name of files) {
  const source = await readFile(new URL(name, assetDir), "utf8");
  const messages = linter.verify(
    source,
    [
      {
        languageOptions: {
          ecmaVersion: "latest",
          sourceType: "module",
          globals: languageGlobals,
        },
        rules: { "no-undef": "error" },
      },
    ],
    { filename: name },
  );

  for (const message of messages) {
    if (message.ruleId !== "no-undef") continue;
    failures.push(
      `${name}:${message.line}:${message.column} ${message.message}`,
    );
  }
}

if (failures.length > 0) {
  throw new Error(`bundle globals:\n${failures.join("\n")}`);
}

const xtermName = files.find((name) => /^xterm-(?!webgl).*\.js$/.test(name));
if (!xtermName) throw new Error("bundle globals: xterm core asset is missing");

const xtermModule = await import(new URL(xtermName, assetDir));
const Terminal = Object.values(xtermModule).find(
  (value) =>
    typeof value === "function" &&
    ["loadAddon", "open", "resize", "write"].every(
      (method) => typeof value.prototype?.[method] === "function",
    ),
);
if (!Terminal) {
  throw new Error("bundle globals: xterm Terminal export is missing");
}

const terminal = new Terminal({ allowProposedApi: true });
let modeResponse = "";
const dataSubscription = terminal.onData((data) => {
  modeResponse += data;
});
try {
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("xterm mode-query write callback timed out")),
      1_000,
    );
    terminal.write(new TextEncoder().encode("\u001b[?2026$p"), () => {
      clearTimeout(timeout);
      resolve();
    });
  });
  if (modeResponse !== "\u001b[?2026;2$y") {
    throw new Error(
      `bundle globals: unexpected xterm mode response ${JSON.stringify(modeResponse)}`,
    );
  }
} finally {
  dataSubscription.dispose();
  terminal.dispose();
}

console.log(
  `bundle globals ok: ${files.length} JavaScript assets checked; xterm mode query completed`,
);
