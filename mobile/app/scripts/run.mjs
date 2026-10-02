#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const [platform, variant, ...rest] = process.argv.slice(2);
if (!['ios', 'android'].includes(platform) || !['development', 'production'].includes(variant)) {
  console.error('usage: run.mjs <ios|android> <development|production> [expo run args...]');
  process.exit(1);
}

const env = { ...process.env, APP_VARIANT: variant };
// A clean prebuild deletes android/local.properties, which is where Gradle found the SDK.
const androidStudioSdk = join(homedir(), 'Library/Android/sdk');
if (!env.ANDROID_HOME && existsSync(androidStudioSdk)) env.ANDROID_HOME = androidStudioSdk;
const expo = (...args) => execFileSync('npx', ['expo', ...args], { stdio: 'inherit', env });

// The native project is generated per variant, so switching variants regenerates it.
const marker = join(platform, '.sikemux-variant');
const built = existsSync(marker) ? readFileSync(marker, 'utf8').trim() : null;
if (built !== variant) {
  expo('prebuild', '--clean', '--platform', platform);
  writeFileSync(marker, `${variant}\n`);
}
expo(`run:${platform}`, ...rest);
