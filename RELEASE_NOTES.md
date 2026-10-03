# Sikemux v0.5.0-nightly.1

The first nightly on the 0.5.0 line, following stable 0.4.3. Nightlies are signed and delivered exactly like stable releases, but they carry unreleased work and can break. Switch back to stable in Settings → About whenever you want; you keep the build you are on until a stable release passes it.

Everything below is new since v0.4.3-nightly.6.

## Accounts

- **Sign in to a Sikemux account.** Settings → Devices has a new account section. Sign in opens in your browser; once you finish there, this computer is registered to your account as a host, so phones signed in to the same account can find it. Signing out forgets the account but keeps the devices you already paired. The phone app is not released yet.
- **Hosts, not Macs.** Settings → Devices, pairing and the related errors now call this computer a host rather than a Mac, ready for Sikemux on Linux.

## Desk and browser

- **The desk opens and closes as a drawer.** It widens the split smoothly instead of snapping, fades as it goes, and can turn round part way if you toggle it again. Nothing on the desk rewraps while it moves.
- **A new tab is ready to type in.** Cmd+T, the tab strip's + button and the new tab palette all open the address bar over the fresh tab, as Cmd+L does.
- **Swipe the stage from over a page.** A sideways swipe that starts over a browser page now moves the stage, unless the page uses it or can go back or forward with it.
- **Pages travel with their pane.** While the stage moves, a picture of each page slides with its pane instead of the page disappearing at the edge and popping back.
- The agent's pointer in a browser tab is now a rounded purple arrow.

## Chat

- **A floating agent header.** The bar above a chat is gone: the title and menu sit in a pill at the top left, the view switch, desk and worktree controls in one at the top right, and the transcript runs up underneath them. Terminal agents start below the pills so their top row stays readable.
- The composer's project and worktree chips, pickers and YOLO toggle are now rounded pills, and their hover fades in instead of snapping.

## Rails and tabs

- **Rails slide like drawers.** Showing or hiding a rail tucks it under the stage's edge while the stage widens with it, instead of jumping, and a second toggle turns it round from where it is.
- **Focus mode is simply both rails hidden.** Hiding both rails lights the focus button, and showing either one leaves focus mode. Hidden rails can still peek out in focus mode.
- Tab tints fade on hover and selection, and the tab strip's edges fade only when tabs really run past them.

## Smoother and faster

- Browser tabs and the window draw at your display's full refresh rate, up to 120 frames a second, instead of being held to 60.
- Swiping between screens no longer stalls at the start or flashes blank at either end, and a pane keeps its texture the whole time it is on screen.
- Pages that have not changed no longer cost any work to keep their picture fresh.

For the complete patch history, compare [`v0.4.3-nightly.6...v0.5.0-nightly.1`](https://github.com/nodelike/sikemux/compare/v0.4.3-nightly.6...v0.5.0-nightly.1).
