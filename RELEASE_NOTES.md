# Sikemux v0.2.2

Sikemux 0.2.2 fixes terminal panes that could stop rendering when interactive programs such as Vim queried terminal capabilities. The shell or editor process kept running underneath, but the visible terminal output queue could become permanently stalled.

## Fixed

- Preserve xterm's terminal mode-query handler in production builds by switching JavaScript minification from esbuild to Terser.
- Keep terminal output flowing when Vim and other interactive applications issue DEC private-mode queries.
- Check every generated JavaScript asset for undeclared runtime globals during production builds.
- Exercise the exact xterm mode-query path in the built bundle so this failure cannot silently return.

## Upgrade note

No Vim, shell, or dotfile changes are required. Install the update and restart Sikemux to replace the affected production bundle.

The published automatic-update feed continues to target Apple Silicon macOS.

For the complete patch history, compare [`v0.2.1...v0.2.2`](https://github.com/nodelike/sikemux/compare/v0.2.1...v0.2.2).
