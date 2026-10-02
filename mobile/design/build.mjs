// Builds screens.html from screens.src.html: `{{IconName}}` or `{{IconName:size}}`
// becomes that icon's SVG, the same markup the phone app draws. `--serve` also
// serves the repo, since the page loads the Mac app's fonts from public/.
import { createReadStream, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../..");
const generated = resolve(here, "../app/src/ui/icons.generated.ts");
const PORT = 8791;

if (!existsSync(generated)) {
  console.error("The Mac app's icons have not been generated yet: run pnpm install in mobile/ first.");
  process.exit(1);
}
const text = readFileSync(generated, "utf8");
const icons = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("} as const") + 1));

/** Glyphs the phone app draws itself (src/ui/Icon.tsx), on the Mac's 16px grid and 1.4 stroke. */
const drawn = {
  IconLaptop: '<rect x="3" y="3.2" width="10" height="7.3" rx="1.2"/><path d="M1.6 12.6h12.8"/>',
  IconDesktop: '<rect x="1.9" y="2.4" width="12.2" height="8.6" rx="1.3"/><path d="M8 11v2.4M5.8 13.6h4.4"/>',
  IconMini: '<rect x="1.9" y="5.6" width="12.2" height="4.8" rx="1.7"/><path d="M4.4 12.4h7.2"/>',
  IconFolders: '<path d="M4 3h3l1.3 1.6H14v6"/><path d="M2 5.6h3.6l1.4 1.8H12v6H2z"/>',
};
for (const [name, paths] of Object.entries(drawn)) {
  icons[name] =
    `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" ` +
    `stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
}

function icon(_, name, size = "16") {
  const svg = icons[name];
  if (!svg) throw new Error(`screens.src.html names an icon the app does not have: ${name}`);
  return svg
    .replace(/width="\d+"/, `width="${size}"`)
    .replace(/height="\d+"/, `height="${size}"`)
    .replace("<svg ", '<svg class="ico" aria-hidden="true" ');
}

function build() {
  const source = readFileSync(resolve(here, "screens.src.html"), "utf8");
  writeFileSync(resolve(here, "screens.html"), source.replace(/\{\{(Icon\w+|Logo)(?::(\d+))?\}\}/g, icon));
}

build();
if (!process.argv.includes("--serve")) {
  console.log("Built mobile/design/screens.html");
  process.exit(0);
}

const types = { ".html": "text/html", ".woff2": "font/woff2", ".svg": "image/svg+xml", ".png": "image/png", ".css": "text/css" };
createServer((request, response) => {
  const path = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname);
  // Each visit to the page rebuilds it, so an edit shows on reload.
  if (path === "/mobile/design/screens.html") build();
  const file = normalize(join(repo, path));
  if (!file.startsWith(repo) || !existsSync(file) || !statSync(file).isFile()) {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream" });
  createReadStream(file).pipe(response);
}).listen(PORT, "127.0.0.1", () => {
  console.log(`Phone screens: http://127.0.0.1:${PORT}/mobile/design/screens.html`);
});
