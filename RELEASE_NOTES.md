# Sikemux v0.5.0-nightly.6

Phones connect through your Sikemux account, and downloads are notarized by Apple. Nightlies are signed and delivered exactly like stable releases, but they carry unreleased work and can break. Switch back to stable in Settings → About whenever you want; you keep the build you are on until a stable release passes it.

Everything below is new since v0.5.0-nightly.5.

## Your phone

- **Phones connect through your account.** Sign in to the same Sikemux account on this computer and on your phone: the phone asks to connect, and you click Allow here. Pairing codes are gone. Remote access now needs you signed in: signing in turns it on, and signing out turns it off.
- **A phone asking to connect takes the whole window.** Pick Full control or Watch only and click Allow, or press Esc to decline, the arrow keys to choose and Return to allow. With Sikemux closed or behind another app, the notch island opens and asks instead.
- **Signing in lands on Settings → Devices**, with a code to scan with your phone's camera to get Sikemux there.

## Jira

- **A Jira Cloud plugin.** Sign in with your Atlassian account in the browser, or with an email and API token. An issues pane searches, reads, comments on, moves, assigns, creates and logs time on issues; the branch's issue shows in the top bar, and an issue lists the open project's commits that name it. Agents get the same as `jira_*` tools.

## Everything else

- **Downloads are notarized.** A fresh download opens without macOS asking you to remove its quarantine first.
- **Ports** show one line per port, with its runtime and owner marked.
- **Git** opens on the history.
- **Agents** are listed most recently active first.
- **The browser** tells agents where the files their pages download end up, and unloads tabs that have been hidden a long time when the system runs short of memory, building them again once shown.
- **Tool calls in chats** keep their targets once finished and give waits as durations.
- The notch, the chat and the agent rail use less CPU while agents work.

For the complete patch history, compare [`v0.5.0-nightly.5...v0.5.0-nightly.6`](https://github.com/nodelike/sikemux/compare/v0.5.0-nightly.5...v0.5.0-nightly.6).
