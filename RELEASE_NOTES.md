# Sikemux v0.5.3-nightly.3

The third nightly on the 0.5.3 line. Nightlies are signed and delivered exactly like stable releases, but they carry unreleased work and can break. Switch back to stable in Settings → About whenever you want; you keep the build you are on until a stable release passes it.

## New since nightly.2

- **Usage limits work again.** The plan limits lookup answers in about half a second instead of timing out, no longer starts your MCP servers or scans a week of transcripts, and stops asking again and again after a failure, which had Anthropic answering 429.
- **Who wrote what.** Every agent commit ends in a footer the host signs, naming the agent, its CLI and Sikemux's versions, and a commit holding several writers' lines carries a note of whose lines are whose. History, the commit header and a commit's diff show those agents and open their sessions. Changes made outside the edit tools, and files you save yourself, go on record too, and agents can ask `who_wrote` who changed something and how to reach them.
- **Move a chat to another account,** even in the middle of a turn, from an account picker in the composer.
- **Long chats.** The app takes up a long chat instead of restarting its agent, and pages back through it, keeping only what subagents said.
- **Tabs and the rail** lead with the chat's title, the agent's name dim after it, and an agent's project sits on a second line. The Terminal and Agents rows are back in the project tree. Inbox items are plain two-line agent rows.
- **Jira.** An open issue resizes from its edge, reads in a centred column, and has an Activity section with comments, all activity and history.
- Agents see the pull requests a commit came in through on GitHub and Bitbucket.
- SSH tabs are named after the host.
- A Claude prompt sent again after a restart is answered, and editing a message older than the replay keeps the history before it.

For the complete patch history, compare [`v0.5.3-nightly.2...v0.5.3-nightly.3`](https://github.com/nodelike/sikemux/compare/v0.5.3-nightly.2...v0.5.3-nightly.3).
