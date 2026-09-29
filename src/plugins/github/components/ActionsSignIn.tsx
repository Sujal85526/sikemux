import { useRef, useState } from "react";
import { openUrl, swallow } from "../../../plugin-api/host";
import { resource, useResource } from "../../../plugin-api/resources";
import { SkeletonRows } from "../../../plugin-api/ui";
import { actionsApi, failureMessage, type ActionsStatus } from "../api";
import { GithubMark } from "./GithubMark";

/** The sign-in form wants to know where a borrowed token came from, which only GitHub's own status says. */
const githubStatusR = resource({
    kind: "host.githubStatus",
    fetch: (): Promise<ActionsStatus> => actionsApi.status(),
    staleAfterMs: 60_000,
});

export function GithubSignIn({ onSignedIn }: { onSignedIn: (account: string | null) => void }) {
    const status = useResource(githubStatusR);
    if (!status.data) return <SkeletonRows rows={4} label="Connecting to GitHub" />;
    return <ActionsSignIn status={status.data} onSignedIn={onSignedIn} />;
}

function sourceNote(status: ActionsStatus): string {
    if (status.tokenSource === "ghCli") return "The gh CLI is signed in here, so Sikemux uses its token.";
    return `${status.tokenVariable ?? "A token variable"} is set in your shell, so Sikemux uses that token.`;
}

function tokenPage(host: string): string {
    return `https://${host}/settings/tokens/new?scopes=repo,workflow&description=Sikemux`;
}

interface Props {
    status: ActionsStatus;
    onSignedIn: (account: string | null) => void;
}

/**
 * The token is the only thing to ask for, and often there is not even that:
 * a shell that exports one, or a signed-in `gh`, is offered as it is.
 */
export function ActionsSignIn({ status, onSignedIn }: Props) {
    const [host, setHost] = useState(status.host);
    const [editingHost, setEditingHost] = useState(status.host !== "github.com");
    const [token, setToken] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(status.authFailed ? status.message : null);

    const borrowed = status.tokenSource === "environment" || status.tokenSource === "ghCli";
    const canSubmit = !busy && !!token.trim();

    const checking = useRef(false);

    const submit = async (withToken: string | undefined) => {
        if (checking.current) return;
        checking.current = true;
        setBusy(true);
        setError(null);
        try {
            const result = await actionsApi.signIn(host.trim(), withToken);
            if (result.ok) onSignedIn(result.account);
            else setError(result.message ?? "GitHub turned that token down");
        } catch (failure) {
            setError(failureMessage(failure));
        } finally {
            checking.current = false;
            setBusy(false);
        }
    };

    return (
        <div className="gha-signin">
            <div className="signin">
                <span className="signin-mark">
                    <GithubMark size={26} />
                </span>
                <h2 className="signin-title">Connect GitHub</h2>
                <p className="signin-lede">Pull requests, Actions runs and issues for this repository, right beside your changes.</p>

                {borrowed && (
                    <>
                        <button type="button" className="gha-btn primary signin-go" disabled={busy} onClick={() => void submit(undefined)}>
                            <GithubMark size={14} />
                            {busy
                                ? "Checking…"
                                : status.tokenSource === "ghCli"
                                  ? "Continue with the gh CLI"
                                  : `Continue with ${status.tokenVariable ?? "that token"}`}
                        </button>
                        <p className="signin-note">{sourceNote(status)}</p>
                        <div className="signin-or">or paste a token</div>
                    </>
                )}

                <div className="signin-form">
                    {editingHost && (
                        <label className="gha-field">
                            <span>Host</span>
                            <input
                                className="gha-input gha-mono"
                                value={host}
                                onChange={(event) => setHost(event.target.value)}
                                placeholder="github.com"
                                spellCheck={false}
                                autoCapitalize="off"
                                autoCorrect="off"
                            />
                        </label>
                    )}
                    <label className="gha-field">
                        <span>Personal access token</span>
                        <input
                            className="gha-input gha-mono"
                            type="password"
                            value={token}
                            onChange={(event) => setToken(event.target.value)}
                            onKeyDown={(event) => {
                                if (event.key === "Enter" && canSubmit) void submit(token.trim());
                            }}
                            placeholder="ghp_… or github_pat_…"
                            autoFocus={!borrowed}
                            spellCheck={false}
                        />
                        <small className="gha-hint">
                            It needs <code>repo</code> to read private repositories and <code>workflow</code> to start or re-run one.
                        </small>
                    </label>
                    <button
                        type="button"
                        className={`gha-btn signin-go${borrowed ? "" : " primary"}`}
                        disabled={!canSubmit}
                        onClick={() => void submit(token.trim())}>
                        {busy ? "Checking…" : "Sign in with token"}
                    </button>
                </div>

                {error && (
                    <div className="gha-callout signin-error" data-tone="danger">
                        {error}
                    </div>
                )}

                <div className="signin-alt">
                    <button
                        type="button"
                        className="gha-link"
                        onClick={() => void openUrl(tokenPage(host.trim() || "github.com")).catch(swallow("open GitHub"))}>
                        Create a token
                    </button>
                    {!editingHost && (
                        <button type="button" className="gha-link" onClick={() => setEditingHost(true)}>
                            GitHub Enterprise
                        </button>
                    )}
                </div>
                <p className="signin-foot">Sikemux keeps your sign-in in the macOS Keychain.</p>
            </div>
        </div>
    );
}
