import { useCallback, useEffect, useRef, useState } from "react";
import { sshApi } from "../api/ssh";
import * as cmd from "../state/commands";
import { errMessage, notify } from "../state/toast";
import { PRIMARY_SHORTCUT } from "../lib/platform";
import { IconClose, IconSave } from "./Icons";

const EXAMPLE = "Host staging\n  HostName staging.example.com\n  User deploy\n  IdentityFile ~/.ssh/id_ed25519";

export function SshConfigEditor() {
    const editorRef = useRef<HTMLTextAreaElement>(null);
    const [initial, setInitial] = useState("");
    const [draft, setDraft] = useState("");
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const dirty = draft !== initial;

    useEffect(() => {
        let disposed = false;
        void sshApi
            .configRead()
            .then((content) => {
                if (disposed) return;
                setInitial(content);
                setDraft(content);
            })
            .catch((cause) => {
                if (!disposed) setError(errMessage(cause));
            })
            .finally(() => {
                if (!disposed) setLoading(false);
            });
        return () => {
            disposed = true;
        };
    }, []);

    useEffect(() => {
        if (!loading) editorRef.current?.focus();
    }, [loading]);

    const close = useCallback(() => {
        if (saving) return;
        if (dirty && !window.confirm("Discard unsaved SSH config changes?")) return;
        cmd.closeSshConfigEditor();
    }, [dirty, saving]);

    const save = useCallback(async () => {
        if (saving || loading) return;
        setSaving(true);
        setError(null);
        try {
            await sshApi.configWrite(draft);
            setInitial(draft);
            notify("success", "SSH config saved");
        } catch (cause) {
            setError(errMessage(cause));
        } finally {
            setSaving(false);
        }
    }, [draft, loading, saving]);

    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                event.preventDefault();
                close();
                return;
            }
            if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
                event.preventDefault();
                void save();
            }
        };
        window.addEventListener("keydown", onKey, true);
        return () => window.removeEventListener("keydown", onKey, true);
    }, [close, save]);

    return (
        <section className="ssh-config-pane" role="dialog" aria-modal="true" aria-label="SSH config editor">
            <header className="ssh-config-head">
                <div>
                    <span className="ssh-config-kicker">SSH</span>
                    <h1>Config editor</h1>
                </div>
                <div className="ssh-config-actions">
                    <span className={`ssh-config-state${dirty ? " dirty" : ""}`}>{dirty ? "unsaved" : "saved"}</span>
                    <button className="ssh-config-btn" type="button" onClick={close} disabled={saving}>
                        <IconClose size={13} /> Close
                    </button>
                    <button className="ssh-config-btn primary" type="button" onClick={() => void save()} disabled={loading || saving || !dirty}>
                        <IconSave size={13} /> {saving ? "Saving…" : "Save"}
                    </button>
                </div>
            </header>
            <div className="ssh-config-meta">
                <span>~/.ssh/config</span>
                <span>{PRIMARY_SHORTCUT}S save · Esc close</span>
            </div>
            <div className="ssh-config-editor-wrap">
                {loading ? (
                    <div className="ssh-config-loading">Loading SSH config…</div>
                ) : (
                    <textarea
                        ref={editorRef}
                        className="ssh-config-editor"
                        value={draft}
                        onChange={(event) => setDraft(event.target.value)}
                        placeholder={EXAMPLE}
                        spellCheck={false}
                        autoCapitalize="off"
                        autoCorrect="off"
                        wrap="off"
                        aria-label="SSH config file contents"
                    />
                )}
            </div>
            {error && <div className="ssh-config-error">Could not save SSH config: {error}</div>}
        </section>
    );
}
