# Sikemux v0.4.3-nightly.1

The first nightly on the 0.4.3 line. Nightlies are signed and delivered exactly like stable releases, but they carry unreleased work and can break. Switch back to stable in Settings → About whenever you want; you keep the build you are on until a stable release passes it.

## New since 0.4.2

- **Your code host in the Git pane.** GitHub and Bitbucket Cloud live beside your local changes. Pull requests read like local changes and like the host's own page, with their conversation, reviews, checks and who merged them. Check a pull request out from its page, open a failing check's job, or jump from a CI annotation to its file and line. A branch shows its open pull request.
- **GitHub Actions and Bitbucket Pipelines.** GitHub runs bring their jobs, logs, artifacts, annotations and deployment approvals, with releases and an inbox beside them, and your agents can read them through tools named `github_`. Bitbucket pipelines list beside them.
- **More than one account per host,** switched per project from the Git pane. Requests hold back once a rate limit is spent.
- **A new Git pane.** Changes, History and Branches over one review. Stage or unstage a file from its row, discard every unstaged change at once, and write commits in one message box. History shows who wrote each commit, and file headers stick as the review scrolls.
- **Aura Noir** is the default theme: Aura's colours on near-black surfaces.
- **The chat.** Queued messages go out together and steer all at once, and a new session opens on the project's activity and calendar.
- **The rails.** Each rail has its own toggle, focus mode hides both, and the sessions rail opens on a masthead that carries the update.
- **The agent's browser.** `browser_act` plays several clicks, keys and typing in one call, and the mobile viewport introduces itself as an iPhone.
- Plugins read your shell's variables even when Sikemux opens from the Dock, so AWS and GitHub find their settings.

Thanks to Sujalxcode for the GitHub plugin, and to Ankit Patidar for keeping Git's state fresh.

For the complete patch history, compare [`v0.4.2...v0.4.3-nightly.1`](https://github.com/nodelike/sikemux/compare/v0.4.2...v0.4.3-nightly.1).
