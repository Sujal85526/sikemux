import { useEffect, useRef, useState } from "react";
import { openUrl, swallow } from "../../../plugin-api/host";
import { resource, useResource } from "../../../plugin-api/resources";
import { SkeletonRows } from "../../../plugin-api/ui";
import { bitbucketApi, failureMessage, type BitbucketStatus, type BrowserSignIn } from "../api";
import { BitbucketMark } from "./BitbucketMark";

const API_TOKENS_PAGE = "https://id.atlassian.com/manage-profile/security/api-tokens";

/** The sign-in form wants to know whether this build can sign in through the browser, which only Bitbucket's own status says. */
const bitbucketStatusR = resource({
    kind: "host.bitbucketStatus",
    fetch: (): Promise<BitbucketStatus> => bitbucketApi.status(),
    staleAfterMs: 60_000,
});

export function BitbucketSignIn({ onSignedIn }: { onSignedIn: (account: string | null) => void }) {
    const status = useResource(bitbucketStatusR);
    if (!status.data) return <SkeletonRows rows={4} label="Connecting to Bitbucket" />;
    return <SignInForm status={status.data} onSignedIn={onSignedIn} />;
}

interface Props {
    status: BitbucketStatus;
    onSignedIn: (account: string | null) => void;
}

/** Signing in through the browser comes first; a pasted token is for workspaces that turn outside apps away. */
export function SignInForm({ status, onSignedIn }: Props) {
    const [withToken, setWithToken] = useState(!status.browserSignIn);
    const [token, setToken] = useState("");
    const [email, setEmail] = useState("");
    const [busy, setBusy] = useState(false);
    const [waiting, setWaiting] = useState<BrowserSignIn | null>(null);
    const [error, setError] = useState<string | null>(status.authFailed ? status.message : null);
    const checking = useRef(false);

    useEffect(() => () => waiting?.cancel(), [waiting]);

    const signInWithBrowser = () => {
        setError(null);
        const attempt = bitbucketApi.signInWithBrowser((url) => void openUrl(url).catch(swallow("open Bitbucket")));
        setWaiting(attempt);
        attempt.done.then(
            (result) => {
                setWaiting(null);
                if (result.ok) onSignedIn(result.account);
                else setError(result.message ?? "Bitbucket did not let that account in");
            },
            (failure: unknown) => {
                setWaiting(null);
                if (!(failure instanceof Error && failure.message === "cancelled")) setError(failureMessage(failure));
            },
        );
    };

    const canSubmit = !busy && !!token.trim();
    const submit = async () => {
        if (checking.current || !canSubmit) return;
        checking.current = true;
        setBusy(true);
        setError(null);
        try {
            const result = await bitbucketApi.signInWithToken(token.trim(), email.trim() || null);
            if (result.ok) onSignedIn(result.account);
            else setError(result.message ?? "Bitbucket turned that token down");
        } catch (failure) {
            setError(failureMessage(failure));
        } finally {
            checking.current = false;
            setBusy(false);
        }
    };

    return (
        <div className="gha-signin">
            <div className="gha-card">
                <h2 className="gha-title">
                    <BitbucketMark size={18} className="icon-bitbucket" />
                    Connect to Bitbucket
                </h2>

                {status.browserSignIn && !withToken && (
                    <div className="gha-callout">
                        {waiting
                            ? "Finish signing in in your browser, then come back here."
                            : "Sign in on bitbucket.org and Sikemux keeps you signed in."}
                        {waiting ? (
                            <button type="button" className="gha-btn" onClick={() => waiting.cancel()}>
                                Cancel
                            </button>
                        ) : (
                            <button type="button" className="gha-btn primary" onClick={signInWithBrowser}>
                                Sign in with Bitbucket
                            </button>
                        )}
                    </div>
                )}

                {withToken && (
                    <>
                        <label className="gha-field">
                            <span>Token</span>
                            <input
                                className="gha-input gha-mono"
                                type="password"
                                value={token}
                                onChange={(event) => setToken(event.target.value)}
                                onKeyDown={(event) => {
                                    if (event.key === "Enter") void submit();
                                }}
                                placeholder="ATATT… or ATCTT…"
                                autoFocus
                                spellCheck={false}
                            />
                        </label>
                        <label className="gha-field">
                            <span>Atlassian account email</span>
                            <input
                                className="gha-input"
                                type="email"
                                value={email}
                                onChange={(event) => setEmail(event.target.value)}
                                onKeyDown={(event) => {
                                    if (event.key === "Enter") void submit();
                                }}
                                placeholder="you@example.com"
                                spellCheck={false}
                                autoCapitalize="off"
                                autoCorrect="off"
                            />
                            <small className="gha-hint">
                                An API token needs the email it belongs to. Leave it empty for a repository or workspace access token. Sikemux keeps
                                the token in your Keychain.
                            </small>
                        </label>
                    </>
                )}

                {error && (
                    <div className="gha-callout" data-tone="danger">
                        {error}
                    </div>
                )}

                <div className="gha-card-actions">
                    {withToken ? (
                        <>
                            {status.browserSignIn ? (
                                <button type="button" className="gha-link" onClick={() => setWithToken(false)}>
                                    Sign in with the browser instead
                                </button>
                            ) : (
                                <button
                                    type="button"
                                    className="gha-link"
                                    onClick={() => void openUrl(API_TOKENS_PAGE).catch(swallow("open Atlassian"))}>
                                    Create an API token
                                </button>
                            )}
                            <button type="button" className="gha-btn primary" disabled={!canSubmit} onClick={() => void submit()}>
                                {busy ? "Checking…" : "Sign in"}
                            </button>
                        </>
                    ) : (
                        <button type="button" className="gha-link" disabled={!!waiting} onClick={() => setWithToken(true)}>
                            Use a token instead
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
}
