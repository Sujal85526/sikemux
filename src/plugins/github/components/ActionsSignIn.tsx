import { useRef, useState } from "react";
import { openUrl, swallow } from "../../../plugin-api/host";
import { actionsApi, failureMessage, type ActionsStatus } from "../api";
import { GithubMark } from "./ActionsIcon";

function sourceNote(status: ActionsStatus): string {
    if (status.tokenSource === "ghCli") return "The gh CLI is signed in here, so Sikemux uses its token.";
    return `${status.tokenVariable ?? "A token variable"} is set in your shell, so Sikemux uses that token.`;
}

function tokenPage(host: string): string {
    return `https://${host}/settings/tokens/new?scopes=repo,workflow&description=Sikemux`;
}

interface Props {
    status: ActionsStatus;
    onSignedIn: () => void;
}

/**
 * The token is the only thing to ask for, and often there is not even that:
 * a shell that exports one, or a signed-in `gh`, is offered as it is.
 */
export function ActionsSignIn({ status, onSignedIn }: Props) {
    const [host, setHost] = useState(status.host);
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
            if (result.ok) onSignedIn();
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
            <div className="gha-card">
                <h2 className="gha-title">
                    <GithubMark size={18} />
                    Connect to GitHub
                </h2>

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

                {borrowed && (
                    <div className="gha-callout">
                        {sourceNote(status)}
                        <button type="button" className="gha-btn primary" disabled={busy} onClick={() => void submit(undefined)}>
                            Use it
                        </button>
                    </div>
                )}

                <label className="gha-field">
                    <span>{borrowed ? "Or a token of your own" : "Personal access token"}</span>
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
                        It needs <code>repo</code> to read private repositories and <code>workflow</code> to start or re-run one. Sikemux keeps it in
                        your Keychain.
                    </small>
                </label>

                {error && (
                    <div className="gha-callout" data-tone="danger">
                        {error}
                    </div>
                )}

                <div className="gha-card-actions">
                    <button
                        type="button"
                        className="gha-link"
                        onClick={() => void openUrl(tokenPage(host.trim() || "github.com")).catch(swallow("open GitHub"))}>
                        Create a token
                    </button>
                    <button type="button" className="gha-btn primary" disabled={!canSubmit} onClick={() => void submit(token.trim())}>
                        {busy ? "Checking…" : "Sign in"}
                    </button>
                </div>
            </div>
        </div>
    );
}
