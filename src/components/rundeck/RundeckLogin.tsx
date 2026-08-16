import { useState } from "react";
import { rundeckApi } from "../../api/rundeck";
import { Checkbox } from "../Controls";

interface Props {
    paneId: string;
    initialUrl?: string;
    initialUser?: string;
    initialAllowInsecurePrivateHttp?: boolean;
    notice?: string;
    onDone: () => void;
}

export function RundeckLogin({ initialUrl = "", initialUser = "", initialAllowInsecurePrivateHttp = false, notice, onDone }: Props) {
    const [url, setUrl] = useState(initialUrl);
    const [user, setUser] = useState(initialUser);
    const [password, setPassword] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(notice ?? null);
    const [version, setVersion] = useState<string | null>(null);
    const [allowInsecurePrivateHttp, setAllowInsecurePrivateHttp] = useState(initialAllowInsecurePrivateHttp);

    const insecureHttp = url.trim().toLowerCase().startsWith("http://");
    const canSubmit = url.trim() && user.trim() && password.length > 0 && (!insecureHttp || allowInsecurePrivateHttp) && !busy;

    const submit = async () => {
        if (!canSubmit) return;
        setBusy(true);
        setError(null);
        try {
            const res = await rundeckApi.login({
                url: url.trim(),
                user: user.trim(),
                password,
                allow_insecure_private_http: insecureHttp && allowInsecurePrivateHttp,
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
                    The minted token is stored at <code>~/.rd-config</code> (chmod&nbsp;600) and shared with the <code>rnd</code> CLI. Your password
                    is never saved.
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

                {insecureHttp && (
                    <div className="rnd-insecure-http">
                        <Checkbox checked={allowInsecurePrivateHttp} onChange={setAllowInsecurePrivateHttp}>
                            Allow plaintext HTTP for this private-subnet host. I understand the password and token are not protected by TLS. Sikemux
                            will refuse the connection unless every resolved address is private or loopback.
                        </Checkbox>
                    </div>
                )}

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
