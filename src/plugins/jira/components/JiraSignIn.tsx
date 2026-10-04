import { useRef, useState } from "react";
import { openUrl, swallow } from "../../../plugin-api/host";
import { SignInScreen } from "../../../plugin-api/ui";
import { failureMessage, jiraApi, type JiraStatus } from "../api";
import { JiraMark } from "./JiraMark";

const API_TOKENS_PAGE = "https://id.atlassian.com/manage-profile/security/api-tokens";

export function JiraSignIn({ status, onSignedIn }: { status: JiraStatus | undefined; onSignedIn: (status: JiraStatus) => void }) {
    const [site, setSite] = useState("");
    const [email, setEmail] = useState("");
    const [token, setToken] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(status?.authFailed ? status.message : null);
    const checking = useRef(false);

    const canSubmit = !busy && !!site.trim() && !!email.trim() && !!token.trim();
    const submit = async () => {
        if (checking.current || !canSubmit) return;
        checking.current = true;
        setBusy(true);
        setError(null);
        try {
            onSignedIn(await jiraApi.signIn(site.trim(), email.trim(), token.trim()));
        } catch (failure) {
            setError(failureMessage(failure));
        } finally {
            checking.current = false;
            setBusy(false);
        }
    };
    const onEnter = (event: { key: string }) => {
        if (event.key === "Enter") void submit();
    };

    return (
        <SignInScreen
            mark={<JiraMark size={26} />}
            title="Connect Jira"
            lede="The tickets you are working on, beside the code, and tools for your agents to read and update them."
            foot="Sikemux keeps your API token in the macOS Keychain.">
            <div className="signin-form">
                <label className="signin-field">
                    <span>Jira site</span>
                    <input
                        className="signin-input"
                        value={site}
                        onChange={(event) => setSite(event.target.value)}
                        onKeyDown={onEnter}
                        placeholder="your-team.atlassian.net"
                        autoFocus
                        spellCheck={false}
                        autoCapitalize="off"
                        autoCorrect="off"
                    />
                </label>
                <label className="signin-field">
                    <span>Atlassian account email</span>
                    <input
                        className="signin-input"
                        type="email"
                        value={email}
                        onChange={(event) => setEmail(event.target.value)}
                        onKeyDown={onEnter}
                        placeholder="you@example.com"
                        spellCheck={false}
                        autoCapitalize="off"
                        autoCorrect="off"
                    />
                </label>
                <label className="signin-field">
                    <span>API token</span>
                    <input
                        className="signin-input mono"
                        type="password"
                        value={token}
                        onChange={(event) => setToken(event.target.value)}
                        onKeyDown={onEnter}
                        placeholder="ATATT…"
                        spellCheck={false}
                    />
                </label>
                <button type="button" className="signin-btn primary" disabled={!canSubmit} onClick={() => void submit()}>
                    {busy ? "Checking…" : "Sign in"}
                </button>
            </div>
            {error && (
                <div className="signin-callout" data-tone="danger">
                    {error}
                </div>
            )}
            <div className="signin-alt">
                <button type="button" className="signin-link" onClick={() => void openUrl(API_TOKENS_PAGE).catch(swallow("open Atlassian"))}>
                    Create an API token
                </button>
            </div>
        </SignInScreen>
    );
}
