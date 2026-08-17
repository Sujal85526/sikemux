# Sikemux v0.3.1

Sikemux 0.3.1 repairs automatic updates and makes a failed check visible.

## Updates

- Fail over to the next release-asset address instead of stalling on one that never answers. GitHub resolves its asset host to four addresses; when a network silently drops the connection to one of them, the check previously waited out its entire timeout and reported nothing, so a dead check looked exactly like being up to date.
- Check for updates on demand from Settings → About, and hear about it when a user-initiated check fails.
- Record every check — background ones included — beside the channel setting, so a quiet failure is visible rather than silent.
- Check immediately after switching channel instead of waiting out the poll interval.

## Upgrade note

An installed copy older than 0.3.1 cannot pick this fix up through the updater it repairs; install this build directly once, and later updates arrive on their own.

The published automatic-update feed continues to target Apple Silicon macOS.

For the complete patch history, compare [`v0.3.0...v0.3.1`](https://github.com/nodelike/sikemux/compare/v0.3.0...v0.3.1).
