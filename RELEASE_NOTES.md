# Sikemux v0.2.1

Sikemux 0.2.1 fixes the in-app update experience. Slow downloads could previously look stuck on “Installing…” even while the signed archive was still arriving from GitHub.

## Fixed

- Separate update preparation, download, signature verification and installation, and restart into accurate UI states.
- Show absolute download progress and a percentage whenever the server provides the archive size.
- Prevent the periodic update check from overwriting an update already in progress.
- Deduplicate concurrent install attempts and keep failures visible and retryable.
- Bound update checks and downloads with explicit network timeouts.
- Record structured native diagnostics for update download and installation boundaries.

## Upgrade note

The update from 0.2.0 to 0.2.1 is initiated by the updater UI already shipped in 0.2.0, so this one upgrade may still show the generic “Installing…” state while it downloads. Updates initiated from 0.2.1 onward show real progress and distinct install and restart phases.

The published automatic-update feed continues to target Apple Silicon macOS.

For the complete patch history, compare [`v0.2.0...v0.2.1`](https://github.com/nodelike/sikemux/compare/v0.2.0...v0.2.1).
