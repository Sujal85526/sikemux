#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tauriDir = join(root, "src-tauri");
const simDir = join(tauriDir, "sim");
const idbDir = join(simDir, "idb");
const buildDir = join(simDir, ".build");
const args = process.argv.slice(2);
const name = "sikemux-sim";
const deploymentTarget = "15.0";

const privateModules = [
  "AXRuntime",
  "CoreSimulatorUtilities",
  "DTXConnectionServices",
  "SimulatorKit",
  "AccessibilityPlatformTranslation",
  "CoreSimDeviceIO",
  "CoreSimulator",
  "SimulatorApp",
];
// CoreSimulator comes with Xcode and is loaded only if it is there, so the
// helper starts on a Mac without Xcode and can say what is missing.
const weakLibraries = ["CoreSimulator", "AccessibilityPlatformTranslation"].map(
  (library) => join(idbDir, "PrivateHeaders", library, `${library}.tbd`),
);
const swiftModules = [
  "CompanionUtilities",
  "SimulatorIPC",
  "SimulatorFrameworkBridgeProtocol",
];

function fail(message) {
  console.error(`Simulator helper build failed: ${message}`);
  process.exit(1);
}

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: options.capture ? ["ignore", "pipe", "inherit"] : "inherit",
  });
  if (result.error) fail(`${command}: ${result.error.message}`);
  if (result.status !== 0)
    fail(`${command} exited with status ${result.status}`);
  return result.stdout?.trim() ?? "";
}

function option(flag) {
  const exact = args.indexOf(flag);
  if (exact >= 0) return args[exact + 1] ?? "";
  return (
    args.find((arg) => arg.startsWith(`${flag}=`))?.slice(flag.length + 1) ?? ""
  );
}

function hostTriple() {
  const details = run("rustc", ["-vV"], { capture: true });
  const host = details.match(/^host:\s*(\S+)$/m)?.[1];
  if (!host) fail("could not determine the Rust host target");
  return host;
}

function filesIn(dir, extension) {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(extension))
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
}

function fingerprint(paths) {
  const hash = createHash("sha256");
  for (const path of paths)
    for (const file of statSync(path).isDirectory()
      ? filesIn(path, "")
      : [path]) {
      hash.update(relative(root, file));
      hash.update(readFileSync(file));
    }
  return hash.digest("hex");
}

const target = option("--target") || hostTriple();
if (!target.includes("apple-darwin")) {
  console.log(`- ${name} skipped: the iOS Simulator is macOS only`);
  process.exit(0);
}

const archs = {
  "aarch64-apple-darwin": ["arm64"],
  "x86_64-apple-darwin": ["x86_64"],
  "universal-apple-darwin": ["arm64", "x86_64"],
}[target];
if (!archs) fail(`unsupported target ${target}`);

const developerDir = run("xcode-select", ["-p"], { capture: true });
const sdk = run("xcrun", ["--sdk", "macosx", "--show-sdk-path"], {
  capture: true,
});
const privateFlags = [
  "-F",
  join(developerDir, "Library", "PrivateFrameworks"),
  "-Xcc",
  `-I${join(idbDir, "PrivateHeaders")}`,
  ...privateModules.flatMap((module) => [
    "-Xcc",
    `-fmodule-map-file=${join(idbDir, "PrivateHeaders", module, "module.modulemap")}`,
  ]),
];

function buildIdb(arch, out) {
  const triple = `${arch}-apple-macos${deploymentTarget}`;
  const include = join(out, "include");
  const modules = join(out, "modules");
  const lib = join(out, "lib");
  const objects = join(out, "objects");
  rmSync(out, { recursive: true, force: true });
  for (const dir of [include, modules, lib, objects])
    mkdirSync(dir, { recursive: true });

  const swiftc = (moduleName, sources, extra) =>
    run("xcrun", [
      "swiftc",
      "-sdk",
      sdk,
      "-target",
      triple,
      "-swift-version",
      "6",
      "-Osize",
      "-parse-as-library",
      "-module-name",
      moduleName,
      "-module-cache-path",
      join(out, "cache"),
      "-I",
      modules,
      "-I",
      include,
      ...privateFlags,
      "-emit-module",
      "-emit-module-path",
      join(modules, `${moduleName}.swiftmodule`),
      "-emit-library",
      "-static",
      ...extra,
      ...sources,
    ]);

  for (const module of swiftModules)
    swiftc(module, filesIn(join(idbDir, module), ".swift"), [
      "-o",
      join(lib, `lib${module}.a`),
    ]);

  // FBControlCore is part Swift, part Objective-C, and each half imports the
  // other: Swift builds against the Objective-C headers and writes the header
  // the Objective-C files then import.
  const coreDir = join(idbDir, "FBControlCore");
  const coreHeaders = join(include, "FBControlCore");
  mkdirSync(coreHeaders, { recursive: true });
  for (const header of filesIn(coreDir, ".h"))
    copyFileSync(header, join(coreHeaders, basename(header)));
  writeFileSync(
    join(coreHeaders, "module.modulemap"),
    'module FBControlCore {\n  umbrella header "FBControlCore.h"\n  export *\n  module * { export * }\n}\n',
  );
  swiftc("FBControlCore", filesIn(coreDir, ".swift"), [
    "-import-underlying-module",
    "-emit-objc-header",
    "-emit-objc-header-path",
    join(coreHeaders, "FBControlCore-Swift.h"),
    "-o",
    join(objects, "libFBControlCoreSwift.a"),
  ]);
  // Compiled from copies beside nothing else, so a quoted import finds the same
  // staged header the module does instead of a second copy of it.
  const sources = join(out, "sources");
  mkdirSync(sources, { recursive: true });
  const objcObjects = filesIn(coreDir, ".m").map((original) => {
    const source = join(sources, basename(original));
    copyFileSync(original, source);
    const object = join(objects, `${basename(source, ".m")}.o`);
    run("xcrun", [
      "clang",
      "-c",
      "-isysroot",
      sdk,
      "-target",
      triple,
      "-Os",
      "-fobjc-arc",
      "-fobjc-arc-exceptions",
      "-fmodules",
      `-fmodules-cache-path=${join(out, "cache")}`,
      "-fmodule-name=FBControlCore",
      "-DNDEBUG",
      "-I",
      include,
      "-I",
      coreHeaders,
      source,
      "-o",
      object,
    ]);
    return object;
  });
  run("libtool", [
    "-static",
    "-o",
    join(lib, "libFBControlCore.a"),
    join(objects, "libFBControlCoreSwift.a"),
    ...objcObjects,
  ]);

  swiftc(
    "FBSimulatorControl",
    filesIn(join(idbDir, "FBSimulatorControl"), ".swift"),
    ["-o", join(lib, "libFBSimulatorControl.a")],
  );
}

function buildHelper(arch) {
  const out = join(buildDir, arch);
  const stamp = join(out, "idb.fingerprint");
  const current = fingerprint([idbDir, fileURLToPath(import.meta.url)]);
  if (!existsSync(stamp) || readFileSync(stamp, "utf8") !== current) {
    console.log(
      `- building idb for ${arch} (once per change to src-tauri/sim/idb)`,
    );
    buildIdb(arch, out);
    writeFileSync(stamp, current);
  }
  const lib = join(out, "lib");
  const binary = join(out, name);
  run("xcrun", [
    "swiftc",
    "-sdk",
    sdk,
    "-target",
    `${arch}-apple-macos${deploymentTarget}`,
    "-swift-version",
    "5",
    "-Osize",
    "-module-cache-path",
    join(out, "cache"),
    "-I",
    join(out, "modules"),
    "-I",
    join(out, "include"),
    ...privateFlags,
    "-L",
    lib,
    ...readdirSync(lib).map((file) => `-l${file.slice(3, -2)}`),
    ...weakLibraries.flatMap((library) => [
      "-Xlinker",
      "-weak_library",
      "-Xlinker",
      library,
    ]),
    // The libraries add Objective-C categories that nothing references by name.
    "-Xlinker",
    "-all_load",
    ...filesIn(join(simDir, "Sources", "SikemuxSim"), ".swift"),
    "-o",
    binary,
  ]);
  return binary;
}

const built = archs.map(buildHelper);
const destination = args.includes("--dev")
  ? join(tauriDir, "target", "debug", name)
  : join(tauriDir, "binaries", `${name}-${target}`);
mkdirSync(dirname(destination), { recursive: true });
if (built.length === 1) copyFileSync(built[0], destination);
else run("lipo", ["-create", ...built, "-output", destination]);
chmodSync(destination, 0o755);
run("strip", ["-x", destination]);

const loadCommands = run("otool", ["-l", destination], { capture: true });
const toolchainPaths = [
  ...loadCommands.matchAll(/^\s+path (\/Applications\/\S+) \(offset \d+\)$/gm),
].map((match) => match[1]);
for (const path of new Set(toolchainPaths))
  run("install_name_tool", ["-delete_rpath", path, destination]);

// Like the voice helper, a release publishes this beside the app, so it is
// signed here the way the bundler signs what it ships.
if (!args.includes("--dev")) {
  const identity = process.env.APPLE_SIGNING_IDENTITY || "-";
  run("codesign", [
    "--force",
    "--identifier",
    "com.nodelike.sikemux.sim",
    "--options",
    "runtime",
    "--entitlements",
    join(tauriDir, "Entitlements.plist"),
    ...(identity === "-" ? [] : ["--timestamp"]),
    "--sign",
    identity,
    destination,
  ]);
}

if (target === hostTriple() || target === "universal-apple-darwin") {
  const version = run(destination, ["--version"], { capture: true });
  if (!version.startsWith(name))
    fail(`unexpected --version output: ${version}`);
}

const size = (statSync(destination).size / 1024 / 1024).toFixed(1);
console.log(
  `✓ ${name} ready: ${destination.slice(root.length + 1)} (${size} MB)`,
);
