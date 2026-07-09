import { useState } from "react";
import * as cmd from "../../state/commands";
import type { BruTreeNode } from "../../bruno/types";
import { IconChevron, IconFolder, IconPlus, IconFolderPlus, IconRefresh, IconPencil, IconTrash } from "../Icons";

interface Props {
    sessionId: string;
    collectionPath: string;
    tree: BruTreeNode[];
    activePath: string | null;
    drafts: Record<string, string>;
    running: Record<string, boolean>;
    loading: boolean;
    error: string | null;
    onSelect: (path: string) => void;
    onReload: () => void;
}

const methodClass = (m: string): string => `bruno-method m-${m.toLowerCase()}`;

export function BrunoTree({ sessionId, collectionPath, tree, activePath, drafts, running, loading, error, onSelect, onReload }: Props) {
    // Folders start collapsed; expand on demand.
    const [expanded, setExpanded] = useState<Record<string, boolean>>({});
    const toggle = (p: string) => setExpanded((c) => ({ ...c, [p]: !c[p] }));

    const newRequest = (dir: string) => {
        const name = window.prompt("New request name");
        if (name) void cmd.brunoNewRequest(sessionId, dir, name);
    };
    const newFolder = (parent: string) => {
        const name = window.prompt("New folder name");
        if (name) void cmd.brunoNewFolder(sessionId, parent, name);
    };
    const rename = (path: string, current: string) => {
        const name = window.prompt("Rename request", current);
        if (name && name !== current) void cmd.brunoRenameRequest(sessionId, path, name);
    };
    const del = (path: string, name: string) => {
        if (window.confirm(`Delete request "${name}"?`)) void cmd.brunoDeleteRequest(sessionId, path);
    };

    const activateOnKey = (e: React.KeyboardEvent, action: () => void) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        action();
    };

    const renderNodes = (nodes: BruTreeNode[], depth: number): React.ReactNode =>
        nodes.map((n) => {
            const pad = { paddingLeft: 8 + depth * 14 } as const;
            if (n.type === "folder") {
                const isOpen = !!expanded[n.path];
                return (
                    <div key={n.path} className="bruno-folder">
                        <div
                            className="bruno-row bruno-folder-row"
                            style={pad}
                            role="button"
                            tabIndex={0}
                            aria-expanded={isOpen}
                            onClick={() => toggle(n.path)}
                            onKeyDown={(e) => activateOnKey(e, () => toggle(n.path))}
                            title={n.name}>
                            <span className={`bruno-chevron${isOpen ? " open" : ""}`}>
                                <IconChevron size={11} />
                            </span>
                            <span className="bruno-folder-ic">
                                <IconFolder size={12} />
                            </span>
                            <span className="bruno-row-name">{n.name}</span>
                            <span className="bruno-row-actions">
                                <button className="bruno-row-act" title="New request" onClick={(e) => (e.stopPropagation(), newRequest(n.path))}>
                                    <IconPlus size={12} />
                                </button>
                            </span>
                        </div>
                        {isOpen && renderNodes(n.children, depth + 1)}
                    </div>
                );
            }
            const active = n.path === activePath;
            return (
                <div
                    key={n.path}
                    className={`bruno-row bruno-req-row${active ? " active" : ""}`}
                    style={pad}
                    role="button"
                    tabIndex={0}
                    onClick={() => onSelect(n.path)}
                    onKeyDown={(e) => activateOnKey(e, () => onSelect(n.path))}
                    title={n.name}>
                    <span className={methodClass(n.method)}>{n.method.toUpperCase()}</span>
                    <span className="bruno-row-name">{n.name}</span>
                    {running[n.path] && <span className="bruno-row-spin" />}
                    {drafts[n.path] != null && <span className="bruno-row-dirty" title="unsaved changes" />}
                    <span className="bruno-row-actions">
                        <button className="bruno-row-act" title="Rename" onClick={(e) => (e.stopPropagation(), rename(n.path, n.name))}>
                            <IconPencil size={12} />
                        </button>
                        <button className="bruno-row-act del" title="Delete" onClick={(e) => (e.stopPropagation(), del(n.path, n.name))}>
                            <IconTrash size={12} />
                        </button>
                    </span>
                </div>
            );
        });

    return (
        <div className="bruno-tree">
            <div className="bruno-tree-head">
                <span>Collection</span>
                <span className="bruno-tree-head-actions">
                    <button className="bruno-icon-btn" title="New request" onClick={() => newRequest(collectionPath)}>
                        <IconPlus size={13} />
                    </button>
                    <button className="bruno-icon-btn" title="New folder" onClick={() => newFolder(collectionPath)}>
                        <IconFolderPlus size={13} />
                    </button>
                    <button className="bruno-icon-btn" title="Reload from disk" onClick={onReload}>
                        <IconRefresh size={13} />
                    </button>
                </span>
            </div>
            <div className="bruno-tree-scroll">
                {error ? (
                    <div className="bruno-tree-msg bruno-tree-err">
                        {error}
                        <button className="bruno-link" onClick={onReload}>
                            retry
                        </button>
                    </div>
                ) : loading ? (
                    <div className="bruno-tree-msg">loading…</div>
                ) : tree.length === 0 ? (
                    <div className="bruno-tree-msg">no .bru requests found</div>
                ) : (
                    renderNodes(tree, 0)
                )}
            </div>
        </div>
    );
}
