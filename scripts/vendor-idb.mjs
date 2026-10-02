#!/usr/bin/env node

import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const destination = join(root, "src-tauri", "sim", "idb");
const repository = "https://github.com/facebook/idb.git";
const modules = ["FBControlCore", "FBSimulatorControl", "CompanionUtilities", "SimulatorIPC", "SimulatorFrameworkBridgeProtocol"];
const shared = ["Configuration", "PrivateHeaders", "LICENSE"];

const commit = process.argv[2] || readFileSync(join(destination, "COMMIT"), "utf8").trim();
if (!/^[0-9a-f]{7,40}$/.test(commit)) {
    console.error("usage: node scripts/vendor-idb.mjs <idb commit>");
    process.exit(1);
}

function run(command, args, cwd) {
    const result = spawnSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
    if (result.status !== 0) {
        console.error(`${command} ${args.join(" ")} failed`);
        process.exit(1);
    }
    return result.stdout.trim();
}

/** The top-level `targets:` entries of an XcodeGen spec, keyed by name, each with its own lines. */
function splitTargets(spec) {
    const lines = spec.split("\n");
    const start = lines.indexOf("targets:");
    const targets = new Map();
    let current = null;
    for (const line of lines.slice(start + 1)) {
        const name = line.match(/^  ([A-Za-z][\w-]*):$/)?.[1];
        if (name) targets.set((current = name), [line]);
        else if (current) targets.get(current).push(line);
    }
    return { preamble: lines.slice(0, start + 1), targets };
}

/** Drops a nested block, such as a target's test `scheme:`, that names targets we do not vendor. */
function dropBlock(lines, header) {
    const out = [];
    let skipping = null;
    for (const line of lines) {
        const indent = line.length - line.trimStart().length;
        if (skipping !== null && line.trim() && indent <= skipping) skipping = null;
        if (skipping !== null) continue;
        if (line.trimEnd() === header) {
            skipping = indent;
            continue;
        }
        out.push(line);
    }
    return out;
}

function trimSpec(spec) {
    const { preamble, targets } = splitTargets(spec);
    const kept = modules.flatMap((name) => {
        const lines = targets.get(name);
        if (!lines) throw new Error(`idb's project.yml has no ${name} target`);
        return dropBlock(lines, "    scheme:").filter(
            (line, index, all) =>
                !line.includes("REPL/IDB/IDBAPI.swiftinterface") &&
                !(line.includes("buildPhase: resources") && all[index - 1]?.includes("REPL/IDB/IDBAPI.swiftinterface")),
        );
    });
    const header = [
        `# Trimmed from idb ${commit} by scripts/vendor-idb.mjs: only the simulator libraries`,
        "# sikemux-sim links. Regenerate with that script rather than editing.",
    ];
    return [...header, ...preamble.filter((line) => !line.startsWith("#")), ...kept, ""].join("\n").replace(/\n{3,}/g, "\n\n");
}

const checkout = mkdtempSync(join(tmpdir(), "idb-"));
try {
    run("git", ["init", "-q"], checkout);
    run("git", ["fetch", "-q", "--depth", "1", repository, commit], checkout);
    run("git", ["checkout", "-q", "FETCH_HEAD"], checkout);
    const resolved = run("git", ["rev-parse", "HEAD"], checkout);

    if (existsSync(destination)) rmSync(destination, { recursive: true });
    for (const entry of [...modules, ...shared]) {
        cpSync(join(checkout, entry), join(destination, entry), {
            recursive: true,
            filter: (path) => !/\/(README\.md|BUCK|TARGETS)$/.test(path),
        });
    }
    writeFileSync(join(destination, "project.yml"), trimSpec(readFileSync(join(checkout, "project.yml"), "utf8")));
    writeFileSync(join(destination, "COMMIT"), `${resolved}\n`);
    console.log(`✓ idb ${resolved.slice(0, 12)} vendored into ${destination.slice(root.length + 1)}`);
} finally {
    rmSync(checkout, { recursive: true, force: true });
}
