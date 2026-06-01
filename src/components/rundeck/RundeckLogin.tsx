import { useState } from "react";
import { rundeckApi } from "../../api/rundeck";

interface Props {
    paneId: string;
    initialUrl?: string;
    initialUser?: string;
    notice?: string;
    onDone: () => void;
}

export function RundeckLogin({ initialUrl = "", initialUser = "", notice, onDone }: Props) {
    const [url, setUrl] = useState(initialUrl);
    const [user, setUser] = useState(initialUser);
    const [password, setPassword] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(notice ?? null);
    const [version, setVersion] = useState<string | null>(null);

    const canSubmit = url.trim() && user.trim() && password.length > 0 && !busy;

    const submit = async () => {
        if (!canSubmit) return;
        setBusy(true);
        setError(null);
        try {
            const res = await rundeckApi.login({
                url: url.trim(),
                user: user.trim(),
                password,
            });
            setVersion(res.rundeck_version ?? "connected");
            setPassword("");
            onDone();
        } catch (e) {
            const msg = typeof e === "object" && e && "message" in e ? String((e as { message: string }).message) : String(e);
            setError(msg);
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="rnd-login">
            <div className="rnd-login-card">
                <div className="rnd-login-title">
                    <span>connect to rundeck</span>
                </div>
                <div className="rnd-login-help">
                    Credentials are stored at <code>~/.rd-config</code> (chmod&nbsp;600) and shared with the <code>rnd</code> CLI.
                </div>

                <label className="rnd-field">
                    <span>Rundeck URL</span>
                    <input
                        type="url"
                        placeholder="http://rundeck.internal:4440"
                        value={url}
                        onChange={(e) => setUrl(e.target.value)}
                        spellCheck={false}
                        autoCapitalize="off"
                        autoCorrect="off"
                    />
                </label>

                <label className="rnd-field">
                    <span>Username</span>
                    <input
                        type="text"
                        value={user}
                        onChange={(e) => setUser(e.target.value)}
                        spellCheck={false}
                        autoCapitalize="off"
                        autoCorrect="off"
                    />
                </label>

                <label className="rnd-field">
                    <span>Password</span>
                    <input
                        type="password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === "Enter") void submit();
                        }}
                    />
                </label>

                {error && <div className="rnd-login-error">{error}</div>}
                {version && <div className="rnd-login-success">✓ connected ({version})</div>}

                <button className="rnd-btn rnd-btn-primary" disabled={!canSubmit} onClick={submit}>
                    {busy ? "signing in…" : "sign in"}
                </button>
            </div>
        </div>
    );
}
