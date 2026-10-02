const fs = require('node:fs');
const path = require('node:path');
const { withAppBuildGradle, withProjectBuildGradle } = require('expo/config-plugins');

const MAVEN = 'https://github.com/rustls/rustls-platform-verifier/raw/maven-archive/android-release-support/maven/';
const LOCK = path.resolve(__dirname, '../../../src-tauri/Cargo.lock');

// The Kotlin half of iroh's certificate check must match the Rust crate's version exactly.
function verifierVersion() {
  const lock = fs.readFileSync(LOCK, 'utf8');
  const found = lock.match(/name = "rustls-platform-verifier-android"\nversion = "([^"]+)"/);
  if (!found) throw new Error(`rustls-platform-verifier-android is not in ${LOCK}`);
  return found[1];
}

module.exports = (config) => {
  config = withProjectBuildGradle(config, (config) => {
    if (!config.modResults.contents.includes(MAVEN)) {
      config.modResults.contents = config.modResults.contents.replace(
        /allprojects\s*\{\s*repositories\s*\{/,
        (opening) => `${opening}\n    maven { url "${MAVEN}" }`,
      );
    }
    return config;
  });
  return withAppBuildGradle(config, (config) => {
    const dependency = `implementation "org.rustls:rustls-platform-verifier:${verifierVersion()}"`;
    if (!config.modResults.contents.includes('org.rustls:rustls-platform-verifier')) {
      config.modResults.contents = config.modResults.contents.replace(
        /dependencies\s*\{/,
        (opening) => `${opening}\n    ${dependency}`,
      );
    }
    return config;
  });
};
