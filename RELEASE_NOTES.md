# Sikemux v0.5.0-nightly.2

A fix for signing in on the 0.5.0 line. Nightlies are signed and delivered exactly like stable releases, but they carry unreleased work and can break. Switch back to stable in Settings → About whenever you want; you keep the build you are on until a stable release passes it.

Everything below is new since v0.5.0-nightly.1.

## Accounts

- **Signing in works.** In 0.5.0-nightly.1, finishing sign-in in the browser ended with "that does not look like a token" and left this computer signed out. It now keeps the sign-in.
- **Sign in on app.sikemux.com.** Signing in from Settings → Devices opens app.sikemux.com instead of a separate sign-in page, and goes straight back to Sikemux without asking you to allow it. If you are already signed in there, it goes straight back.

For the complete patch history, compare [`v0.5.0-nightly.1...v0.5.0-nightly.2`](https://github.com/nodelike/sikemux/compare/v0.5.0-nightly.1...v0.5.0-nightly.2).
