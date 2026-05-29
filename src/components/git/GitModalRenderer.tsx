import { useEffect, useRef, useState } from "react";
import { closeGitModal, dispatchGitMenuKey } from "../../state/git";
import { useStore } from "../../state/store";

/** Single mounted modal renderer. Reads `store.gitModal` and paints
 *  whichever variant is active. Captures keys at the window level while
 *  open so panel keybindings don't fire underneath. */
export function GitModalRenderer({ paneId, active }: { paneId: string; active: boolean }) {
    const modal = useStore((s) => s.gitModal);
    const ownsModal = !!modal && modal.ownerPaneId === paneId;

    useEffect(() => {
        if (!modal || !ownsModal) return;
        if (!active) {
            closeGitModal();
            return;
        }
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                closeGitModal();
                return;
            }
            // Menu items have hot-keys; route the keypress before letting it
            // escape into the underlying pane.
            if (modal.kind === "menu" && dispatchGitMenuKey(e.key)) {
                e.preventDefault();
                e.stopPropagation();
            }
        };
        window.addEventListener("keydown", onKey, true);
        return () => window.removeEventListener("keydown", onKey, true);
    }, [modal, ownsModal, active]);

    if (!modal || !ownsModal || !active) return null;
    return (
        <div className="git-modal-scrim" onClick={closeGitModal}>
            <div className={`git-modal git-modal-${modal.kind}`} onClick={(e) => e.stopPropagation()}>
                {modal.kind === "menu" && <MenuBody modal={modal} />}
                {modal.kind === "confirm" && <ConfirmBody modal={modal} />}
                {modal.kind === "prompt" && <PromptBody modal={modal} />}
                {modal.kind === "cheatsheet" && <CheatsheetBody modal={modal} />}
            </div>
        </div>
    );
}

function MenuBody({ modal }: { modal: Extract<NonNullable<ReturnType<typeof useStore.getState>["gitModal"]>, { kind: "menu" }> }) {
    return (
        <>
            <div className="git-modal-h">{modal.title}</div>
            <div className="git-modal-body">
                {modal.items.map((item, i) => (
                    <button
                        key={i}
                        type="button"
                        disabled={item.disabled}
                        className={`git-menu-item${item.destructive ? " danger" : ""}`}
                        onClick={() => {
                            closeGitModal();
                            void item.run();
                        }}>
                        {item.key && <span className="git-menu-key">{item.key}</span>}
                        <span className="git-menu-label">{item.label}</span>
                        {item.hint && <span className="git-menu-hint">{item.hint}</span>}
                    </button>
                ))}
            </div>
            <div className="git-modal-foot">
                <span className="kbd">esc</span> cancel
            </div>
        </>
    );
}

function ConfirmBody({ modal }: { modal: Extract<NonNullable<ReturnType<typeof useStore.getState>["gitModal"]>, { kind: "confirm" }> }) {
    const confirmRef = useRef<HTMLButtonElement>(null);
    useEffect(() => {
        confirmRef.current?.focus();
    }, []);
    return (
        <>
            <div className="git-modal-h">{modal.title}</div>
            <div className="git-modal-body git-modal-confirm">{modal.body}</div>
            <div className="git-modal-foot">
                <button type="button" className="git-modal-btn" onClick={closeGitModal}>
                    {modal.cancelLabel ?? "cancel"}
                </button>
                <button
                    ref={confirmRef}
                    type="button"
                    className={`git-modal-btn primary${modal.destructive ? " danger" : ""}`}
                    onClick={() => {
                        closeGitModal();
                        void modal.onConfirm();
                    }}>
                    {modal.confirmLabel ?? "confirm"}
                </button>
            </div>
        </>
    );
}

function PromptBody({ modal }: { modal: Extract<NonNullable<ReturnType<typeof useStore.getState>["gitModal"]>, { kind: "prompt" }> }) {
    const [value, setValue] = useState(modal.initial ?? "");
    const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null);
    useEffect(() => {
        inputRef.current?.focus();
        if (modal.initial && inputRef.current) inputRef.current.select();
    }, [modal.initial]);

    const submit = () => {
        closeGitModal();
        void modal.onConfirm(value);
    };

    const matching = (modal.suggestions ?? []).filter((s) => s.value.toLowerCase().includes(value.toLowerCase()));

    return (
        <>
            <div className="git-modal-h">{modal.title}</div>
            <div className="git-modal-body git-modal-prompt">
                {modal.multiline ? (
                    <textarea
                        ref={inputRef as React.RefObject<HTMLTextAreaElement>}
                        className="git-modal-input multiline"
                        placeholder={modal.placeholder}
                        value={value}
                        onChange={(e) => setValue(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                                e.preventDefault();
                                submit();
                            }
                        }}
                        spellCheck={false}
                        autoCapitalize="off"
                        autoCorrect="off"
                    />
                ) : (
                    <input
                        ref={inputRef as React.RefObject<HTMLInputElement>}
                        type="text"
                        className="git-modal-input"
                        placeholder={modal.placeholder}
                        value={value}
                        onChange={(e) => setValue(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === "Enter") {
                                e.preventDefault();
                                submit();
                            }
                        }}
                        spellCheck={false}
                        autoCapitalize="off"
                        autoCorrect="off"
                    />
                )}
                {modal.suggestions && matching.length > 0 && (
                    <div className="git-modal-suggestions">
                        {matching.slice(0, 8).map((s) => (
                            <button
                                key={s.value}
                                type="button"
                                className="git-modal-suggestion"
                                onClick={() => {
                                    setValue(s.value);
                                    inputRef.current?.focus();
                                }}>
                                <span>{s.value}</span>
                                {s.hint && <span className="git-modal-suggestion-hint">{s.hint}</span>}
                            </button>
                        ))}
                    </div>
                )}
            </div>
            <div className="git-modal-foot">
                <button type="button" className="git-modal-btn" onClick={closeGitModal}>
                    cancel
                </button>
                <button type="button" className="git-modal-btn primary" onClick={submit}>
                    {modal.multiline ? "submit (⌘↵)" : "ok (↵)"}
                </button>
            </div>
        </>
    );
}

function CheatsheetBody({ modal }: { modal: Extract<NonNullable<ReturnType<typeof useStore.getState>["gitModal"]>, { kind: "cheatsheet" }> }) {
    return (
        <>
            <div className="git-modal-h">{modal.title}</div>
            <div className="git-modal-body git-modal-cheatsheet">
                {modal.sections.map((sec, si) => (
                    <div className="git-cheat-section" key={si}>
                        <div className="git-cheat-section-h">{sec.title}</div>
                        <div className="git-cheat-rows">
                            {sec.rows.map((row, ri) => (
                                <div className="git-cheat-row" key={ri}>
                                    <span className="git-cheat-keys">{row.keys}</span>
                                    <span className="git-cheat-label">{row.label}</span>
                                </div>
                            ))}
                        </div>
                    </div>
                ))}
            </div>
            <div className="git-modal-foot">
                <span className="kbd">esc</span> close
            </div>
        </>
    );
}
