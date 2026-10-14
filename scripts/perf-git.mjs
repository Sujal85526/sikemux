import { createServer as createNetServer } from "node:net";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { webkit } from "playwright-core";
import { createServer } from "vite";

/*
 * Times the git screen on a repository with 1,500 dirty files in WebKit, the
 * engine the app runs on, and checks it against the frame targets. The machine
 * is often busy, so it tries a few runs and passes if any of them meets them.
 */

const root = resolve(import.meta.dirname, "..");
const { values: options } = parseArgs({
  options: {
    runs: { type: "string", default: "3" },
    "dirty-files": { type: "string", default: "1500" },
  },
});

const FRAME_120HZ_MS = 1000 / 120;
/** Each target is for a 120Hz display, and grows with a slower one. */
const TARGETS = [
  ["scroll p50", (result) => result.scroll.p50Ms, 9],
  ["scroll p90", (result) => result.scroll.p90Ms, 14],
  ["fling p90", (result) => result.fling.p90Ms, 20],
  ["switch longest (median)", (result) => result.switch.longestMs, 20],
  ["switch worst", (result) => result.switch.worstMs, 50],
];

/** `pnpm showcase:perf` keeps 5791, so this takes whichever port is free. */
const freePort = () =>
  new Promise((settle, fail) => {
    const probe = createNetServer().listen(0, "localhost", () => {
      const { port } = probe.address();
      probe.close(() => settle(port));
    });
    probe.on("error", fail);
  });

process.env.NODE_ENV = "production";
const server = await createServer({
  root,
  configFile: resolve(root, "showcase/vite.perf.config.ts"),
  mode: "production",
  logLevel: "silent",
  // Its own cache, so forcing a fresh one never pulls dependencies from under a running `pnpm showcase:perf`.
  cacheDir: resolve(root, "node_modules/.vite-perf-git"),
  // With no hot reload, a dependency found mid-run breaks the page, so every source is scanned up front.
  optimizeDeps: {
    force: true,
    entries: [
      "showcase/perf.html",
      "src/**/*.{ts,tsx}",
      "!src/**/*.test.{ts,tsx}",
      "!src/test/**",
    ],
  },
  server: { port: await freePort(), strictPort: true },
});
await server.listen();
const origin = `http://localhost:${server.config.server.port}`;

const browser = await webkit.launch();
const context = await browser.newContext({
  viewport: { width: 1600, height: 1000 },
  colorScheme: "dark",
});

function verdict(result) {
  const scale = Math.max(1, result.frameMs / FRAME_120HZ_MS);
  return TARGETS.map(([name, read, target]) => {
    const limit = Math.round(target * scale);
    const value = read(result);
    return { name, value, limit, ok: value <= limit };
  });
}

function print(run, result, checks) {
  const hz = Math.round(1000 / result.frameMs);
  console.log(
    `\nrun ${run}: ${result.dirtyFiles} dirty files, ${hz}Hz (frame ${result.frameMs} ms)`,
  );
  console.log(
    `  idle      over budget ${result.idle.overBudgetMs} ms, longest ${result.idle.longestMs} ms`,
  );
  console.log(
    `  open      over budget ${result.open.overBudgetMs} ms, longest ${result.open.longestMs} ms`,
  );
  for (const { name, value, limit, ok } of checks) {
    console.log(
      `  ${ok ? "pass" : "FAIL"}  ${name.padEnd(24)} ${String(value).padStart(4)} ms  (≤ ${limit})`,
    );
  }
}

/** A first load can find dependencies still to optimise, and with no hot reload the page never comes back for them. */
async function open(page) {
  for (let attempt = 1; ; attempt++) {
    await page.goto(`${origin}/showcase/perf.html`);
    try {
      await page.waitForSelector(".stage", { timeout: 60_000 });
      return await page.waitForFunction(() => window.showcase && window.perf);
    } catch (error) {
      if (attempt === 3) throw error;
    }
  }
}

let passed = false;
try {
  for (let run = 1; run <= Number(options.runs) && !passed; run++) {
    const page = await context.newPage();
    page.on("pageerror", (error) => {
      if (!error.message.startsWith("ResizeObserver loop"))
        console.error(`page error: ${error.message}`);
    });
    await open(page);
    const result = await page.evaluate(
      (dirtyFiles) => window.perf.run({ dirtyFiles }),
      Number(options["dirty-files"]),
    );
    const checks = verdict(result);
    print(run, result, checks);
    passed = checks.every((check) => check.ok);
    await page.close();
  }
} finally {
  await browser.close();
  await server.close();
}

console.log(
  passed
    ? "\ngit screen meets its targets"
    : "\ngit screen misses its targets in every run",
);
process.exit(passed ? 0 : 1);
