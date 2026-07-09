import type { ReactNode } from "react";

export interface PanelAction {
    key?: string;
    label: string;
    onClick: () => void;
    tone?: "warn" | "danger";
}

export function GitPanelBlock({
    n,
    label,
    focused,
    onFocus,
    flex,
    extra,
    rangeBadge,
    filterBadge,
    actions,
    children,
}: {
    n: number;
    label: string;
    focused: boolean;
    onFocus: () => void;
    flex: number;
    extra?: ReactNode;
    rangeBadge?: string | null;
    filterBadge?: string | null;
    actions?: PanelAction[];
    children: ReactNode;
}) {
    return (
        <div className={`git-panel${focused ? " focused" : ""}`} style={{ flex }}>
            <div
                className="git-panel-head"
                role="button"
                tabIndex={0}
                aria-label={`Focus ${label} panel`}
                onClick={onFocus}
                onKeyDown={(event) => {
                    if (event.key !== "Enter" && event.key !== " ") return;
                    event.preventDefault();
                    onFocus();
                }}>
                <span className="git-panel-n">{n}</span>
                <span className="git-panel-label">{label}</span>
                {filterBadge && <span className="git-panel-pill">/{filterBadge}</span>}
                {rangeBadge && <span className="git-panel-pill range">{rangeBadge}</span>}
                {extra}
                {actions && actions.length > 0 && (
                    <span className="git-head-actions">
                        {actions.map((a) => (
                            <button
                                key={a.label}
                                type="button"
                                className={`git-hbtn${a.tone ? ` ${a.tone}` : ""}`}
                                title={a.label}
                                onClick={(e) => {
                                    e.stopPropagation();
                                    a.onClick();
                                }}>
                                {a.label}
                                {a.key && <kbd className="git-kbd">{a.key}</kbd>}
                            </button>
                        ))}
                    </span>
                )}
            </div>
            <div className="git-panel-body">{children}</div>
        </div>
    );
}
