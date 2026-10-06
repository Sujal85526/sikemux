# Sikemux v0.5.0-nightly.7

Keep more than one Claude or Codex account, and let chats carry on with the next one when one runs out. Nightlies are signed and delivered exactly like stable releases, but they carry unreleased work and can break. Switch back to stable in Settings → About whenever you want; you keep the build you are on until a stable release passes it.

Everything below is new since v0.5.0-nightly.6.

## Accounts

- **More than one Claude or Codex account.** The agent rail's footer lists every account you keep: who it is signed in as, its plan and how much is left. Add one there, sign in and out through the agent's own login, and pick the one new chats start on. Sikemux never reads a credential.
- **Chats move on at a usage limit.** With two or more accounts, turn on the switch and a chat that runs out of usage carries on with the next signed-in account. You can move a chat to another account yourself too; the move shows in the chat.
- **Signing in again reaches open chats.** A chat no longer keeps failing with "Authentication required" after you sign in again in a terminal. A turn that needs a sign-in offers one, then sends your message again.

## The desk

- **One kind of tab at a time.** Three icons beside the tab strip pick pages, files or terminals, and each kind comes back to the tab it last showed. A kind an agent is busy in takes the agent's colour.
- The desk's edge steps round the switcher in its corner, and the ⌘L address moves and fades with the desk.

## Your phone

- **Phones resume your recent chats**, send photos and files with a message, see running subagents, steer a running turn, stop tasks and switch YOLO. Update the phone app to get these.

## Everything else

- **The notch island** shows a mark and a count for every state your agents are in, not only the most pressing, so finished agents no longer go unnoticed. Agent rows in the island and the rail show running subagents.
- **Voice captions** float above a chat's composer instead of covering its buttons, and scroll with the newest words.
- Switching to another project's tabs no longer shrinks the old ones away.
- Showing and hiding the rails and the desk, and resizing splits, is smoother.

For the complete patch history, compare [`v0.5.0-nightly.6...v0.5.0-nightly.7`](https://github.com/nodelike/sikemux/compare/v0.5.0-nightly.6...v0.5.0-nightly.7).
