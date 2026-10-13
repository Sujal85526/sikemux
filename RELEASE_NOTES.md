# Sikemux v0.5.3-nightly.1

The first nightly on the 0.5.3 line. Nightlies are signed and delivered exactly like stable releases, but they carry unreleased work and can break. Switch back to stable in Settings → About whenever you want; you keep the build you are on until a stable release passes it.

## New since 0.5.2

- **Updates keep your agents running.** Updating Sikemux carries running chat agents over to the new version, keeps agents' desk tabs and simulators, and tells agents their tabs survive. An agent that cannot be carried over is waited on before the restart, or you can force the update.
- **Share a chat.** Share a chat read-only from the Mac. Anyone with the link watches it live, in Sikemux, on their phone or in the browser at app.sikemux.com. It is encrypted end to end, so the server only relays it.
- **Skills.** Sikemux keeps a skills library that every agent loads beside its own skills, whether it runs in a chat, a terminal or from a paired phone. Make, install, remove and move skills in Settings → Skills, and agents can do the same with a skills tool. A skill an agent saves in its own global folder can be moved into Sikemux.
- **Muse Code** joins the agents, driven natively over its own session protocol.
- **Linux.** Every release now ships a deb, an rpm and an AppImage. Linux installs are sent to the releases page for updates, WebKit keeps drawing on the GPU with NVIDIA on Wayland, and the close button closes the window.
- **Dictation** shows the words being dictated, dimmed, inside the message box, Enter ends dictation and leaves the words there, and a dictation you started by clicking keeps going when you press another key.
- **Bitbucket for agents.** Agents can comment on, review, open, merge and decline pull requests, create, close and reopen issues, and rerun or stop pipelines. A folder of repositories offers the tools for the remotes inside it.
- **Jira boards** can be narrowed to picked people, your issues, unassigned cards or words on a card, and an opened issue closes from its header. Agents' Jira search can return each issue's latest comments and page through results.
- **PDFs** open in macOS's own PDF view, so they pinch, scroll and sit on the app's ground.
- The Git pane's navigation moves into a labelled header.
- The live stack folds subagents, shells and monitors one group at a time, and an agent waiting on its subagents shows as working.
- Escape clears a selection, and stops a running turn only from an empty box.
- A Claude workflow's agents show under its task row, and subagent and shell counts read in plain text, not muted.
- Jira, Bitbucket, GitLab and AWS show their official marks.

Thanks to Krisna Satria for the Linux packages and fixes, Sujal Rajput for the dictation preview and fixes, and Ankit Patidar for the Jira board filters and the Escape fix.

For the complete patch history, compare [`v0.5.2...v0.5.3-nightly.1`](https://github.com/nodelike/sikemux/compare/v0.5.2...v0.5.3-nightly.1).
