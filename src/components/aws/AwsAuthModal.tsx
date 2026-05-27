import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import * as cmd from "../../state/commands";
import { useStore } from "../../state/store";
import { IconClose } from "../Icons";
import { swallow } from "../../state/toast";

// Sign-in flow that mirrors ~/.config/shell/bin/aws-auth:
//   1. If a `cloudBrowser` is configured, activate it (and run the optional
//      workspace shortcut) so the device-auth tab lands in the right space.
//   2. Then `aws sso login --profile X` runs.
export function AwsAuthModal() {
    const modal = useStore((s) => s.awsAuthModal);
    const cloudBrowser = useStore((s) => s.cloudBrowser);
    const cloudBrowserShortcut = useStore((s) => s.cloudBrowserShortcut);

    const [phase, setPhase] = useState<"idle" | "running" | "ok" | "fail">("idle");
    const [errOut, setErrOut] = useState("");
    // When the user clicks Cancel mid-sign-in we want to instantly dismiss
    // the modal even though the `aws sso login` subprocess is still running
    // (Tauri's aws_sso_login command has no abort handle today — the bash
    // CLI is happy to finish in the background). This flag stops the
    // resolved-after-cancel callback from trying to setState on an unmounted
    // / re-opened modal.
    const cancelledRef = useRef(false);

    useEffect(() => {
        // Reset phase every time the modal opens (any profile). Without this,
        // closing during "running" then re-opening the SAME profile would
        // re-display the stale "running" phase since the dep array only fires
        // on profile change.
        if (modal) {
            cancelledRef.current = false;
            setPhase("idle");
            setErrOut("");
        }
    }, [modal]);

    if (!modal) return null;

    const openInBrowser = (url: string) =>
        invoke("open_url", {
            url,
            app: cloudBrowser || null,
            shortcut: cloudBrowserShortcut || null,
        }).catch(swallow("open_url"));

    const onCancel = () => {
        // Mark the in-flight call as aborted so its eventual resolution
        // doesn't fire setPhase on an unmounted component. Then dismiss.
        cancelledRef.current = true;
        cmd.closeAwsAuthModal();
    };

    const onSignIn = async () => {
        cancelledRef.current = false;
        setPhase("running");
        setErrOut("");
        try {
            // Switch to the configured browser workspace WITHOUT opening a URL —
            // `aws sso login` opens its own device-auth URL via the system default
            // browser. Pre-opening the SSO portal would land two tabs.
            if (cloudBrowser) {
                await invoke("macos_focus_app", {
                    app: cloudBrowser,
                    shortcut: cloudBrowserShortcut || null,
                }).catch(swallow("macos_focus_app"));
            }
            const ok = await cmd.runAwsSsoLogin(modal.profile);
            if (cancelledRef.current) return;
            setPhase(ok ? "ok" : "fail");
            if (ok) {
                window.setTimeout(cmd.closeAwsAuthModal, 700);
            }
        } catch (e) {
            if (cancelledRef.current) return;
            setPhase("fail");
            setErrOut(String(e));
        }
    };

    return (
        <div className="settings-backdrop" onMouseDown={cmd.closeAwsAuthModal}>
            <div className="aws-auth-modal" onMouseDown={(e) => e.stopPropagation()}>
                <div className="settings-head">
                    <span className="settings-title">
                        <strong>·</strong>aws sign-in
                    </span>
                    <button className="settings-close" onClick={cmd.closeAwsAuthModal} title="Close">
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
                                title="Open in configured browser">
                                {modal.ssoStartUrl}
                            </button>
                        </div>
                    )}

                    <div className="aws-auth-steps">
                        <ol>
                            <li>
                                Click <strong>Sign in with SSO</strong> below — your browser opens automatically with the device-authorization code.
                            </li>
                            <li>Approve the request in your Identity Center tab.</li>
                            <li>
                                The dialog flips to ✓ as soon as <code>sts</code> succeeds.
                            </li>
                        </ol>
                    </div>

                    {phase === "running" && <div className="aws-auth-status running">waiting for browser approval…</div>}
                    {phase === "ok" && <div className="aws-auth-status ok">authenticated ✓</div>}
                    {phase === "fail" && (
                        <div className="aws-auth-status fail">
                            login failed — try again or run <code>aws sso login --profile {modal.profile}</code> in a terminal
                            {errOut && <pre className="aws-auth-err">{errOut}</pre>}
                        </div>
                    )}
                </div>

                <div className="aws-auth-actions">
                    <button className="settings-btn" onClick={onCancel}>
                        Cancel
                    </button>
                    <button className="settings-btn primary" onClick={onSignIn} disabled={phase === "running" || phase === "ok"}>
                        {phase === "running" ? "Signing in…" : "Sign in with SSO"}
                    </button>
                </div>
            </div>
        </div>
    );
}
