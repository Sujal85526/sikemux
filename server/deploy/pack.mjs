// Packs the built API and web app into dist/release.tar.gz, the one file a deploy uploads.
// Run `pnpm build` first, with SIKEMUX_VERSION set to the commit being released.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const server = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const version = process.env.SIKEMUX_VERSION;
if (!version || !/^[0-9a-f]{40}$/.test(version)) {
  console.error(
    "Set SIKEMUX_VERSION to the full commit the release is built from.",
  );
  process.exit(1);
}

const out = join(server, "dist");
const release = join(out, "release");
rmSync(out, { recursive: true, force: true });
mkdirSync(release, { recursive: true });

const pieces = {
  "api/dist": join(server, "api/dist"),
  "api/migrations": join(server, "api/migrations"),
  app: join(server, "app/dist"),
};
for (const [to, from] of Object.entries(pieces)) {
  if (!existsSync(from)) {
    console.error(`${from} is missing; run pnpm build first.`);
    process.exit(1);
  }
  cpSync(from, join(release, to), { recursive: true });
}
writeFileSync(join(release, "RELEASE"), version);

// macOS tar otherwise adds ._ files that the server's tar would unpack as junk.
execFileSync("tar", ["-czf", join(out, "release.tar.gz"), "-C", release, "."], {
  stdio: "inherit",
  env: { ...process.env, COPYFILE_DISABLE: "1" },
});
console.log(`Packed server/dist/release.tar.gz for ${version}`);
