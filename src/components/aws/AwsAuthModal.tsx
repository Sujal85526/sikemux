import { useEffect, useRef, useState } from "react";
import { invokeCommand as invoke } from "../../api/invoke";
import * as cmd from "../../state/commands";
import { useStore } from "../../state/store";
import { IconClose } from "../Icons";
import { swallow } from "../../state/toast";
import { awsApi } from "../../api/aws";

export function AwsAuthModal() {
    const modal = useStore((s) => s.awsAuthModal);
    const cloudBrowser = useStore((s) => s.cloudBrowser);
    const cloudBrowserShortcut = useStore((s) => s.cloudBrowserShortcut);

    const [phase, setPhase] = useState<"idle" | "running" | "ok" | "fail">("idle");
    const [errOut, setErrOut] = useState("");
    const cancelledRef = useRef(false);
    const operationRef = useRef<string | null>(null);

    useEffect(() => {
        if (!modal) return;
        cancelledRef.current = false;
        setPhase("idle");
        setErrOut("");
        return () => {
            cancelledRef.current = true;
            const operationId = operationRef.current;
            operationRef.current = null;
            if (operationId) void awsApi.ssoCancel(operationId).catch(swallow("cancel AWS sign-in"));
        };
    }, [modal]);

    if (!modal) return null;

    const openInBrowser = (url: string) =>
        invoke("open_url", {
            url,
            app: cloudBrowser || null,
            shortcut: cloudBrowserShortcut || null,
        }).catch(swallow("open_url"));

    const onCancel = () => {
        cancelledRef.current = true;
        const operationId = operationRef.current;
        operationRef.current = null;
        if (operationId) void awsApi.ssoCancel(operationId).catch(swallow("cancel AWS sign-in"));
        cmd.closeAwsAuthModal();
    };

    const onSignIn = async () => {
        cancelledRef.current = false;
        setPhase("running");
        setErrOut("");
        try {
            const operationId = crypto.randomUUID();
            operationRef.current = operationId;
            if (cloudBrowser) {
                await invoke("macos_focus_app", {
                    app: cloudBrowser,
                    shortcut: cloudBrowserShortcut || null,
                }).catch(swallow("macos_focus_app"));
            }
            const ok = await cmd.runAwsSsoLogin(modal.profile, operationId);
            if (operationRef.current === operationId) operationRef.current = null;
            if (cancelledRef.current) return;
            setPhase(ok ? "ok" : "fail");
            if (ok) {
                window.setTimeout(cmd.closeAwsAuthModal, 700);
            }
        } catch (e) {
            if (cancelledRef.current) return;
            setPhase("fail");
            setErrOut(String(e));
        } finally {
            operationRef.current = null;
        }
    };

    return (
        <div className="settings-backdrop" onMouseDown={onCancel}>
            <div className="aws-auth-modal" onMouseDown={(e) => e.stopPropagation()}>
                <div className="settings-head">
                    <span className="settings-title">
                        <strong>·</strong>aws sign-in
                    </span>
                    <button className="settings-close" onClick={onCancel} title="Close">
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
