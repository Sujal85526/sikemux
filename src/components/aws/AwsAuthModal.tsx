import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useWorkspace } from "../../state/workspace";
import { IconClose } from "../Icons";

// Sign-in flow that mirrors ~/.config/shell/bin/aws-auth:
//   1. If a `cloudBrowser` (+ optional `cloudBrowserShortcut`) is configured
//      in settings, the SSO start URL is opened there first — activating
//      the browser app + firing the workspace shortcut via osascript, so
//      the user lands on the right space.
//   2. Then `aws sso login --profile X` runs. The CLI handles its own
//      device-authorization browser-open; since the browser is already in
//      the right workspace from step (1), the device-auth click happens in
//      context.
export function AwsAuthModal() {
  const modal = useWorkspace((s) => s.awsAuthModal);
  const close = useWorkspace((s) => s.closeAwsAuthModal);
  const runAwsSsoLogin = useWorkspace((s) => s.runAwsSsoLogin);
  const cloudBrowser = useWorkspace((s) => s.cloudBrowser);
  const cloudBrowserShortcut = useWorkspace((s) => s.cloudBrowserShortcut);

  const [phase, setPhase] = useState<"idle" | "running" | "ok" | "fail">("idle");
  const [errOut, setErrOut] = useState("");

  useEffect(() => {
    setPhase("idle");
    setErrOut("");
  }, [modal?.profile]);

  if (!modal) return null;

  // Opens a URL in the configured browser, switching to the configured
  // workspace first. Used only by the SSO portal link in the modal — the
  // sign-in flow itself doesn't pre-open anything (see onSignIn).
  const openInBrowser = (url: string) =>
    invoke("open_url", {
      url,
      app: cloudBrowser || null,
      shortcut: cloudBrowserShortcut || null,
    }).catch(() => {});

  const onSignIn = async () => {
    setPhase("running");
    setErrOut("");
    try {
      // Switch to the configured browser workspace WITHOUT opening a URL —
      // `aws sso login` opens its own device-auth URL via the system
      // default browser. Pre-opening the SSO portal here would land two
      // tabs (Identity Center + device-auth), which is what the user hit.
      if (cloudBrowser) {
        await invoke("macos_focus_app", {
          app: cloudBrowser,
          shortcut: cloudBrowserShortcut || null,
        }).catch(() => {});
      }
      const ok = await runAwsSsoLogin(modal.profile);
      setPhase(ok ? "ok" : "fail");
      if (ok) {
        window.setTimeout(close, 700);
      }
    } catch (e) {
      setPhase("fail");
      setErrOut(String(e));
    }
  };

  return (
    <div className="settings-backdrop" onMouseDown={close}>
      <div
        className="aws-auth-modal"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="settings-head">
          <span className="settings-title">
            <strong>·</strong>aws sign-in
          </span>
          <button className="settings-close" onClick={close} title="Close">
            <IconClose size={11} />
          </button>
        </div>

        <div className="aws-auth-body">
          <div className="aws-auth-row">
            <span className="aws-auth-label">Profile</span>
            <span className="aws-auth-value">{modal.profile}</span>
          </div>
          {modal.ssoStartUrl && (
            <div className="aws-auth-row">
              <span className="aws-auth-label">SSO portal</span>
              <button
                type="button"
                className="aws-auth-link"
                onClick={() => modal.ssoStartUrl && openInBrowser(modal.ssoStartUrl)}
                title="Open in configured browser"
              >
                {modal.ssoStartUrl}
              </button>
            </div>
          )}

          <div className="aws-auth-steps">
            <ol>
              <li>
                Click <strong>Sign in with SSO</strong> below — your browser
                opens automatically with the device-authorization code.
              </li>
              <li>Approve the request in your Identity Center tab.</li>
              <li>
                The dialog flips to ✓ as soon as <code>sts</code> succeeds.
              </li>
            </ol>
          </div>

          {phase === "running" && (
            <div className="aws-auth-status running">
              waiting for browser approval…
            </div>
          )}
          {phase === "ok" && (
            <div className="aws-auth-status ok">authenticated ✓</div>
          )}
          {phase === "fail" && (
            <div className="aws-auth-status fail">
              login failed — try again or run{" "}
              <code>aws sso login --profile {modal.profile}</code> in a
              terminal
              {errOut && <pre className="aws-auth-err">{errOut}</pre>}
            </div>
          )}
        </div>

        <div className="aws-auth-actions">
          <button
            className="settings-btn"
            onClick={close}
            disabled={phase === "running"}
          >
            Cancel
          </button>
          <button
            className="settings-btn primary"
            onClick={onSignIn}
            disabled={phase === "running" || phase === "ok"}
          >
            {phase === "running" ? "Signing in…" : "Sign in with SSO"}
          </button>
        </div>
      </div>
    </div>
  );
}
