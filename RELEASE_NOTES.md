# Sikemux v0.4.0-nightly.8

The eighth nightly build. Nightlies are signed and delivered exactly like stable releases, but they carry unreleased work and can break. Switch back to stable in Settings → About whenever you want; you keep the build you are on until a stable release passes it.

A short one, mostly about the transcript and what survives a restart.

## The transcript

- A file the transcript names opens where files open, and its icon reads at the size of the words beside it rather than towering over them.
- A big picture shrinks into a preview instead of being refused, and the checkerboard behind an image preview is gone.
- A queued message holding a URL no longer shoves the pane off screen.
- A running shell is marked with a terminal glyph, and so are the leftover shells in the agent list, which used to wear an amber dot as though something were wrong.

## After a restart

- An agent's browser tabs are still there, and the app no longer opens onto half a dead pane.

## Elsewhere

- A file dropped anywhere in the window lands somewhere.
- A pane nobody is looking at stops animating.
- The git screen keeps one handle, in the rail, and the status mark takes the close button's slot.

For the complete patch history, compare [`v0.4.0-nightly.7...v0.4.0-nightly.8`](https://github.com/nodelike/sikemux/compare/v0.4.0-nightly.7...v0.4.0-nightly.8).
