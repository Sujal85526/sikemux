# Sikemux v0.3.0

Sikemux 0.3.0 is a full pass over the desktop shell. The window, rails, tabs, panels, pickers, and dialogs now share one spacing scale, two corner radii, and a single set of themed controls, so the application reads as one surface instead of a stack of separately styled panes.

## Shell

- Rebuild the desktop shell and agent rail around even gutters, a flush top bar, and a compact project tab navigator.
- Use Figtree for application chrome, with one font shared across the row names in both rails.
- Sit the macOS traffic lights on the top bar's centre line and move the brand to the foot of the rail.
- Paint a single surface in the centre so the stage, pane, and terminal viewport stop stacking tints, and honour the window-opacity setting across rails and panes alike.
- Drop every backdrop blur; overlay scrims keep their dimming, which is what separates an overlay from the app behind it.
- Settle on two radii — one for controls, one for panels — and round the surfaces that predated them.

## Shared controls

- Replace platform widgets with themed application controls, and add themed tooltips, scrollbars, skeletons, and iconised error states.
- Share one panel vocabulary and one dialog surface across features, covered by primitive tests.
- Add icons and tooltips to find bars and shared buttons, and make the theme palette rows readable.

## Agents

- Toggle YOLO from the agent picker itself, with providers shown in their brand colours.
- Always resume restored agent tabs, and show the working mark only while an agent is actually working.
- Rest rail and picker rows below full ink so hover and selection have something to mark, and drop the NAV / OPEN / ESC hint chips from every picker.
- Read the agent limits as a rail section rather than a card.

## Git

- Give the git view a fixed 30% column with focus-driven panels that size to their content, and drop the terminal from the view.
- Tint whole diff lines instead of words, flatten the toolbar, and tighten its chips.

## Rundeck

- Round the Rundeck pane so the deploy composer and execution meta bar match the rest of the app.
- Mark the active row in the project tree and step list with a ring instead of an edge bar, and gutter the project tree column.

## Upgrade note

This release changes appearance only. Projects, sessions, themes, and resumable agent sessions carry over untouched.

The published automatic-update feed continues to target Apple Silicon macOS.

For the complete patch history, compare [`v0.2.3...v0.3.0`](https://github.com/nodelike/sikemux/compare/v0.2.3...v0.3.0).
