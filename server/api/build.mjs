// Bundles the API into one file, so a release needs no node_modules on the server.
import { execFileSync } from "node:child_process";
import { build } from "esbuild";

const version =
  process.env.SIKEMUX_VERSION ??
  execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();

await build({
  entryPoints: ["src/main.ts"],
  outfile: "dist/main.mjs",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  sourcemap: true,
  external: ["pg-native"],
  define: { SIKEMUX_VERSION: JSON.stringify(version) },
  banner: {
    js: "import { createRequire as sikemuxCreateRequire } from 'node:module'; const require = sikemuxCreateRequire(import.meta.url);",
  },
  logLevel: "warning",
});
console.log(`Built server/api/dist/main.mjs for ${version}`);
