import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { chromium } from "playwright-core";
import { createServer } from "vite";

const root = resolve(import.meta.dirname, "..");
const { values: options } = parseArgs({
  options: {
    out: { type: "string", default: join(homedir(), "Downloads") },
    width: { type: "string", default: "1600" },
    height: { type: "string", default: "900" },
  },
});

const server = await createServer({
  configFile: resolve(root, "showcase/vite.config.ts"),
  logLevel: "warn",
});
await server.listen();

const browser = await chromium.launch({
  channel: "chrome",
  headless: false,
  args: [`--window-size=${options.width},${Number(options.height) + 90}`],
});
const context = await browser.newContext({
  viewport: { width: Number(options.width), height: Number(options.height) },
  deviceScaleFactor: 2,
  colorScheme: "dark",
});
const page = await context.newPage();
await page.clock.setFixedTime(new Date("2026-09-26T09:41:00"));

await page.exposeFunction("showcaseDownload", async () => {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-");
  const name = `sikemux-${stamp}.png`;
  await page.evaluate(() =>
    document.documentElement.classList.add("is-capturing"),
  );
  await page.screenshot({ path: join(options.out, name) });
  await page.evaluate(() =>
    document.documentElement.classList.remove("is-capturing"),
  );
  console.log(`saved ${join(options.out, name)}`);
  return name;
});

await page.goto(
  `http://localhost:${server.config.server.port}/showcase/twitter.html`,
);
console.log("Pick a view and press Download. Close the window to stop.");

await new Promise((done) => page.on("close", done));
await browser.close();
await server.close();
