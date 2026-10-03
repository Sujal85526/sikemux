import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";

const ROOT = new URL("..", import.meta.url).pathname;
const OUT = join(ROOT, "brand");
const WORDMARK = join(ROOT, "src-tauri/icons/sikemux.icon/Assets/wordmark.svg");

const shapes = readFileSync(WORDMARK, "utf8")
  .match(/<g transform="translate\(0, 30\)">([\s\S]*?)<\/g>/)[1]
  .replace(/ fill="#FFFFFF"/g, "")
  .replace(/\s+/g, " ")
  .trim();

const COLORS = { white: "#ffffff", black: "#000000", purple: "#a277ff" };
const GROUNDS = {
  dark: ["#1a1a26", "#0c0b14", "#040408"],
  dev: ["#452f80", "#24184a", "#140c2a"],
};

const markSvg = (fill) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="82 24 265 265"><g fill="${fill}">${shapes}</g></svg>\n`;

const iconSvg = (ground, { rounded }) => {
  const [top, middle, bottom] = GROUNDS[ground];
  const corner = rounded ? ` rx="230" ry="230"` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
<defs><linearGradient id="ground" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${top}"/><stop offset="0.55" stop-color="${middle}"/><stop offset="1" stop-color="${bottom}"/></linearGradient></defs>
<rect width="1024" height="1024"${corner} fill="url(#ground)"/>
<svg x="176" y="176" width="672" height="672" viewBox="82 24 265 265"><g fill="#ffffff">${shapes}</g></svg>
</svg>
`;
};

const write = (path, text) => {
  mkdirSync(join(OUT, path, ".."), { recursive: true });
  writeFileSync(join(OUT, path), text);
};

const svgs = {};
for (const [name, fill] of Object.entries(COLORS))
  svgs[`mark/mark-${name}.svg`] = markSvg(fill);
for (const ground of Object.keys(GROUNDS)) {
  svgs[`icon/icon-${ground}-rounded.svg`] = iconSvg(ground, { rounded: true });
  svgs[`icon/icon-${ground}-square.svg`] = iconSvg(ground, { rounded: false });
}

rmSync(OUT, { recursive: true, force: true });
for (const [path, text] of Object.entries(svgs)) write(path, text);

const pngs = [];
for (const name of Object.keys(COLORS))
  for (const size of [64, 256, 1024])
    pngs.push([`mark/mark-${name}.svg`, `mark/mark-${name}-${size}.png`, size]);
for (const ground of Object.keys(GROUNDS))
  for (const shape of ["rounded", "square"])
    for (const size of [256, 1024])
      pngs.push([
        `icon/icon-${ground}-${shape}.svg`,
        `icon/icon-${ground}-${shape}-${size}.png`,
        size,
      ]);
pngs.push(["icon/icon-dark-square.svg", "social/avatar-400.png", 400]);

const browser = await chromium.launch({ channel: "chrome" });
for (const [source, target, size] of pngs) {
  const page = await browser.newPage({
    viewport: { width: size, height: size },
  });
  const svg = svgs[source].replace(
    "<svg ",
    `<svg width="${size}" height="${size}" `,
  );
  await page.setContent(
    `<html><body style="margin:0;background:transparent">${svg}</body></html>`,
  );
  await page.screenshot({ path: join(OUT, target), omitBackground: true });
  await page.close();
}
await browser.close();

const APP = process.env.SIKEMUX_APP ?? "/Applications/Sikemux.app";
const renderAppIcon = `
import AppKit
let size = Int(CommandLine.arguments[2])!
let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
NSWorkspace.shared.icon(forFile: "${APP}").draw(in: NSRect(x: 0, y: 0, width: size, height: size))
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: CommandLine.arguments[1]))
`;
const scratch = mkdtempSync(join(tmpdir(), "sikemux-brand-"));
writeFileSync(join(scratch, "render.swift"), renderAppIcon);
mkdirSync(join(OUT, "macos"), { recursive: true });
for (const size of [128, 256, 512, 1024])
  execFileSync("swift", [
    join(scratch, "render.swift"),
    join(OUT, `macos/app-icon-${size}.png`),
    String(size),
  ]);
rmSync(scratch, { recursive: true, force: true });

console.log(`brand assets written to ${OUT}`);
