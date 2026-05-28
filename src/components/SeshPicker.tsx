import { useEffect, useMemo, useRef, useState } from "react";
import type { SessionKind } from "../state/types";
import * as cmd from "../state/commands";
import { useResourceEnabled } from "../state/resources";
import { projectRootsScanR, sshHostsR } from "../state/resources.defs";
import { useStore } from "../state/store";
import type { SshHost } from "../api/ssh";
import { useMouseActive } from "../hooks/useMouseActive";
import { IconCommand, IconFolder, IconSearch } from "./Icons";

type Item =
    | { kind: "session"; id: string; name: string; sub: string; sk: SessionKind }
    | { kind: "dir"; path: string; name: string; sub: string }
    | { kind: "ssh"; alias: string; name: string; sub: string };

// Subsequence fuzzy match. Returns a score (lower = better) or -1 for no match.
function fuzzy(query: string, text: string): number {
    if (!query) return 0;
    const q = query.toLowerCase();
    const t = text.toLowerCase();
    let ti = 0;
    let score = 0;
    let prev = -2;
    for (let qi = 0; qi < q.length; qi++) {
        const found = t.indexOf(q[qi], ti);
        if (found === -1) return -1;
        score += found - prev === 1 ? 0 : found;
        prev = found;
        ti = found + 1;
    }
    return score;
}

function sshSubtitle(h: SshHost): string {
    const target = h.hostname ?? h.alias;
    const user = h.user ? `${h.user}@` : "";
    const port = h.port && h.port !== 22 ? `:${h.port}` : "";
    return `${user}${target}${port}`;
}

// One picker, three modes. Driven by pickerMode:
//   all      sessions + project roots + ssh hosts  (M-s)
//   projects existing project sessions + project roots  (M-p)
//   ssh      existing ssh sessions + ssh hosts  (M-S)
export function SeshPicker() {
    const sessionsById = useStore((s) => s.sessions);
    const sessionOrder = useStore((s) => s.sessionOrder);
    const sessions = sessionOrder.map((id) => sessionsById[id]);
    const home = useStore((s) => s.home);
    const projectRoots = useStore((s) => s.projectRoots);
    const mode = useStore((s) => s.pickerMode);

    const [query, setQuery] = useState("");
    const [sel, setSel] = useState(0);
    const inputRef = useRef<HTMLInputElement>(null);
    const mouseActive = useMouseActive();

    const showProjects = mode === "all" || mode === "projects";
    const showSsh = mode === "all" || mode === "ssh";

    useEffect(() => {
        inputRef.current?.focus();
    }, []);

    const scanned = useResourceEnabled(showProjects && projectRoots.length > 0, projectRootsScanR, showProjects ? projectRoots : []);
    const hostsR = useResourceEnabled(showSsh, sshHostsR);
    const projects = showProjects ? (scanned.data ?? []) : [];
    const hosts = showSsh ? (hostsR.data ?? []) : [];

    const pretty = (p: string) => (home && p.startsWith(home) ? `~${p.slice(home.length)}` : p);

    const items = useMemo<Item[]>(() => {
        const wantKind = (k: SessionKind) => mode === "all" || (mode === "projects" && k === "project") || (mode === "ssh" && k === "ssh");
        const sessionItems: Item[] = sessions
            .filter((s) => wantKind(s.kind))
            .map((s) => ({
                kind: "session",
                id: s.id,
                name: s.name,
                sub: s.kind === "project" ? pretty(s.cwd) : s.kind === "ssh" ? "ssh" : "command",
                sk: s.kind,
            }));

        const openCwds = new Set(sessions.map((s) => s.cwd).filter(Boolean));
        const dirItems: Item[] = showProjects
            ? projects
                  .filter((p) => !openCwds.has(p.path))
                  .map<Item>((p) => ({
                      kind: "dir",
                      path: p.path,
                      name: p.name,
                      sub: pretty(p.path),
                  }))
            : [];

        const openSshAliases = new Set(sessions.filter((s) => s.kind === "ssh").map((s) => s.name));
        const sshItems: Item[] = showSsh
            ? hosts
                  .filter((h) => !openSshAliases.has(h.alias))
                  .map<Item>((h) => ({
                      kind: "ssh",
                      alias: h.alias,
                      name: h.alias,
                      sub: sshSubtitle(h),
                  }))
            : [];

        const rank = (it: Item) => fuzzy(query, `${it.name} ${it.sub}`);
        const keep = (it: Item) => rank(it) >= 0;
        const order = (a: Item, b: Item) => rank(a) - rank(b);

        const s = sessionItems.filter(keep);
        const d = dirItems.filter(keep);
        const h = sshItems.filter(keep);
        if (query) {
            s.sort(order);
            d.sort(order);
            h.sort(order);
        }
        return [...s, ...d, ...h];
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [sessions, projects, hosts, query, home, mode]);

    useEffect(() => {
        setSel((s) => Math.min(s, Math.max(0, items.length - 1)));
    }, [items.length]);

    const activate = (it: Item | undefined) => {
        if (!it) return;
        if (it.kind === "session") cmd.selectSession(it.id);
        else if (it.kind === "dir") cmd.createProjectSession(it.path);
        else cmd.createSshSession(it.alias);
    };

    const onKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === "Escape") {
            cmd.closePicker();
        } else if (e.key === "ArrowDown" || (e.key === "Tab" && !e.shiftKey)) {
            e.preventDefault();
            setSel((s) => (items.length ? (s + 1) % items.length : 0));
        } else if (e.key === "ArrowUp" || (e.key === "Tab" && e.shiftKey)) {
            e.preventDefault();
            setSel((s) => (items.length ? (s - 1 + items.length) % items.length : 0));
        } else if (e.key === "Enter") {
            e.preventDefault();
            activate(items[sel]);
        }
    };

    const firstDirIdx = items.findIndex((it) => it.kind === "dir");
    const firstSshIdx = items.findIndex((it) => it.kind === "ssh");
    const firstSessIdx = items.findIndex((it) => it.kind === "session");

    const placeholder =
        mode === "projects"
            ? "find a project…"
            : mode === "ssh"
              ? "ssh — search hosts from ~/.ssh/config…"
              : "jump to a session, project, or ssh host…";

    return (
        <div className="picker-backdrop" onMouseDown={cmd.closePicker}>
            <div className="picker" onMouseDown={(e) => e.stopPropagation()}>
                <div className="picker-input-wrap">
                    <IconSearch size={15} className="picker-search-icon" />
                    <input
                        ref={inputRef}
                        className="picker-input"
                        placeholder={placeholder}
                        value={query}
                        onChange={(e) => {
                            setQuery(e.target.value);
                            setSel(0);
                        }}
                        onKeyDown={onKeyDown}
                        spellCheck={false}
                    />
                    <span className="picker-hint">esc</span>
                </div>

                <div className="picker-list">
                    {items.length === 0 && (
                        <div className="picker-empty">
                            {showProjects && projectRoots.length === 0 ? (
                                <>
                                    no project roots configured —{" "}
                                    <button
                                        className="picker-link"
                                        onClick={() => {
                                            cmd.closePicker();
                                            cmd.openSettings();
                                        }}>
                                        open settings
                                    </button>{" "}
                                    to add some (⌘,)
                                </>
                            ) : showSsh && hosts.length === 0 && mode === "ssh" ? (
                                "no hosts in ~/.ssh/config"
                            ) : (
                                "no matches"
                            )}
                        </div>
                    )}
                    {items.map((it, i) => {
                        const sessLabel = i === firstSessIdx && firstSessIdx >= 0 ? "Open" : null;
                        const dirLabel = i === firstDirIdx && firstDirIdx >= 0 ? "Projects" : null;
                        const sshLabel = i === firstSshIdx && firstSshIdx >= 0 ? "SSH" : null;
                        const key = it.kind === "session" ? `s-${it.id}` : it.kind === "dir" ? `d-${it.path}` : `h-${it.alias}`;
                        return (
                            <div key={key}>
                                {sessLabel && <div className="picker-group">{sessLabel}</div>}
                                {dirLabel && <div className="picker-group">{dirLabel}</div>}
                                {sshLabel && <div className="picker-group">{sshLabel}</div>}
                                <button
                                    className={`picker-item${i === sel ? " sel" : ""}`}
                                    onMouseEnter={() => {
                                        if (mouseActive.current) setSel(i);
                                    }}
                                    onClick={() => activate(it)}>
                                    <span className={`picker-icon ${it.kind === "dir" ? "project" : it.kind === "ssh" ? "command" : it.sk}`}>
                                        {it.kind === "dir" || (it.kind === "session" && it.sk === "project") ? (
                                            <IconFolder size={14} />
                                        ) : (
                                            <IconCommand size={14} />
                                        )}
                                    </span>
                                    <span className="picker-name">{it.name}</span>
                                    <span className="picker-sub">{it.sub}</span>
                                </button>
                            </div>
                        );
                    })}
                </div>
            </div>
        </div>
    );
}
