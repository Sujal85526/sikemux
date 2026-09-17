# Sikemux v0.4.0-nightly.5

The fifth nightly build. Nightlies are signed and delivered exactly like stable releases, but they carry unreleased work and can break. Switch back to stable in Settings → About whenever you want; you keep the build you are on until a stable release passes it.

## The browser sidecar starts again

- The shipped sidecar could not run at all. It is one PyInstaller file that unpacks its Python library to a temporary folder and loads it from there, and bundling signs it with the hardened runtime, which only lets a process load libraries from its own team. An unpacked library belongs to no team, so it died on startup with "different Team IDs" and any agent reaching for a browser tool got nothing back.
- The bundle now carries an entitlements file saying that load is allowed.
- This has been broken in every nightly that bundled the sidecar. It only showed now because the previous build restored the wiring that tells an agent the browser tools exist — until then nothing ever launched it, so a sidecar that could not start looked exactly like one nobody called.
- The build starts the bundled sidecar and fails if it cannot. The smoke test that ran before it exercised the copy built beside the bundle, which is signed without the hardened runtime and starts whether or not the shipped one would.

For the complete patch history, compare [`v0.4.0-nightly.4...v0.4.0-nightly.5`](https://github.com/nodelike/sikemux/compare/v0.4.0-nightly.4...v0.4.0-nightly.5).
