import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  git,
  hasUnstaged,
  isStaged,
  type GitBranch,
  type GitCommit,
  type GitStatus,
} from "../api/git";
import { useWorkspace } from "../state/workspace";
import { CommitReview } from "./CommitReview";
import { FileIcon } from "./FileIcon";
import { MergeReview } from "./MergeReview";

const basenameOf = (p: string) => p.replace(/\/+$/, "").split("/").pop() || p;

type Panel = "files" | "branches" | "commits";
type RightView =
  | { mode: "merge"; path: string }
  | { mode: "commit"; rev: string; title: string; subtitle: string }
  | { mode: "output"; text: string };

// Native lazygit-style git UI. Keyboard flow: 2 (files) → a (stage all) →
// C (AI commit) → 3 (branches) → P (push) → Ctrl-P (open PR).
export function GitPane({ cwd, active }: { cwd: string; active: boolean }) {
  const repo = cwd;
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [branches, setBranches] = useState<GitBranch[]>([]);
  const [commits, setCommits] = useState<GitCommit[]>([]);
  const [panel, setPanel] = useState<Panel>("files");
  const [sel, setSel] = useState<Record<Panel, number>>({
    files: 0,
    branches: 0,
    commits: 0,
  });
  const [right, setRight] = useState<RightView>({ mode: "output", text: "" });
  const [busy, setBusy] = useState<string | null>(null);
  const [commitMode, setCommitMode] = useState(false);
  const [commitText, setCommitText] = useState("");
  const commitInputRef = useRef<HTMLInputElement>(null);
  const requestOpenFile = useWorkspace((s) => s.requestOpenFile);

  const refresh = useCallback(async () => {
    if (!repo) return;
    try {
      const [s, b, l] = await Promise.all([
        git.status(repo),
        git.branches(repo),
        git.log(repo),
      ]);
      setStatus(s);
      setBranches(b);
      setCommits(l);
    } catch (err) {
      setRight({ mode: "output", text: `✗ ${String(err)}` });
    }
  }, [repo]);

  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    if (active) void refresh();
  }, [active, refresh]);
  // Live: refresh when any file is saved in the editor (store nonce bumps).
  const gitRefreshN = useWorkspace((s) => s.gitRefreshN);
  useEffect(() => {
    void refresh();
  }, [gitRefreshN, refresh]);
  // Polling fallback for external changes (other editors, agents, etc.) —
  // only while the git pane is the visible window.
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => void refresh(), 3000);
    return () => window.clearInterval(id);
  }, [active, refresh]);
  useEffect(() => {
    if (commitMode) commitInputRef.current?.focus();
  }, [commitMode]);

  const files = status?.files ?? [];

  // Load the right pane for the selected row: file diff, commit detail, or
  // branch-tip detail depending on the focused panel.
  useEffect(() => {
    if (panel === "files") {
      if (files.length === 0) {
        setRight({ mode: "output", text: "" });
        return;
      }
      const f = files[Math.min(sel.files, files.length - 1)];
      if (f) setRight({ mode: "merge", path: f.path });
    } else if (panel === "commits") {
      if (commits.length === 0) return;
      const c = commits[Math.min(sel.commits, commits.length - 1)];
      if (c)
        setRight({
          mode: "commit",
          rev: c.hash,
          title: c.hash,
          subtitle: c.subject,
        });
    } else if (panel === "branches") {
      if (branches.length === 0) return;
      const b = branches[Math.min(sel.branches, branches.length - 1)];
      if (b)
        setRight({
          mode: "commit",
          rev: b.name,
          title: b.name,
          subtitle: "branch tip",
        });
    }
  }, [panel, sel.files, sel.commits, sel.branches, files, commits, branches]);

  // ---- actions ----
  const run = async (label: string, fn: () => Promise<string | void>) => {
    setBusy(label);
    try {
      const out = await fn();
      if (typeof out === "string") setRight({ mode: "output", text: out });
    } catch (err) {
      setRight({ mode: "output", text: `✗ ${String(err)}` });
    } finally {
      setBusy(null);
      void refresh();
    }
  };

  const toggleStage = () => {
    const f = files[sel.files];
    if (!f) return;
    void run("", async () => {
      if (hasUnstaged(f)) await git.stage(repo, f.path);
      else await git.unstage(repo, f.path);
    });
  };

  const doCommit = (message: string) => {
    if (!message.trim()) return;
    setCommitMode(false);
    setCommitText("");
    void run("committing", async () => {
      await git.commit(repo, message);
      return `✓ committed\n\n${message}`;
    });
  };

  const aiCommit = () =>
    run("hermes is writing the commit…", async () => {
      const msg = await git.aiCommit(repo);
      return `✓ AI commit\n\n${msg}`;
    });

  const moveSel = (d: number) => {
    const len =
      panel === "files"
        ? files.length
        : panel === "branches"
          ? branches.length
          : commits.length;
    if (len === 0) return;
    setSel((s) => ({
      ...s,
      [panel]: Math.max(0, Math.min(len - 1, s[panel] + d)),
    }));
  };

  // ---- keyboard ----
  useEffect(() => {
    if (!active || commitMode) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey || e.metaKey) return;
      if (useWorkspace.getState().pickerOpen) return;
      // Don't hijack keys while the user is typing in the diff/merge editor.
      const ae = document.activeElement;
      if (ae && ae.closest(".cm-editor")) return;
      const k = e.key;
      if (e.ctrlKey) {
        if (k === "p" || k === "P") {
          e.preventDefault();
          void run("opening PR…", async () => {
            const url = await git.prOpen(repo);
            return `→ opened pull-request page\n${url}`;
          });
        }
        return;
      }
      if (busy) return;
      let handled = true;
      if (k === "2") setPanel("files");
      else if (k === "3") setPanel("branches");
      else if (k === "4") setPanel("commits");
      else if (k === "Tab")
        setPanel((p) =>
          p === "files" ? "branches" : p === "branches" ? "commits" : "files",
        );
      else if (k === "j" || k === "ArrowDown") moveSel(1);
      else if (k === "k" || k === "ArrowUp") moveSel(-1);
      else if (k === "r") void refresh();
      else if (panel === "files" && k === " ") toggleStage();
      else if (panel === "files" && k === "a")
        void run("", () => git.stageAll(repo));
      else if (panel === "files" && k === "c") setCommitMode(true);
      else if (panel === "files" && k === "C") void aiCommit();
      else if (k === "P")
        void run("pushing…", async () => `↑ ${await git.push(repo)}`);
      else if (k === "p")
        void run("pulling…", async () => `↓ ${await git.pull(repo)}`);
      else if (panel === "branches" && (k === "Enter" || k === " ")) {
        const b = branches[sel.branches];
        if (b && !b.current)
          void run("", () => git.checkout(repo, b.name));
      } else handled = false;
      if (handled) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  const panelFiles = panel === "files";

  return (
    <div className="git-pane">
      <div className="git-left">
        {(busy || (status && (status.ahead > 0 || status.behind > 0))) && (
          <div className="git-status-bar">
            {status && (status.ahead > 0 || status.behind > 0) && (
              <span className="git-track">
                {status.ahead > 0 && <span>↑{status.ahead}</span>}
                {status.behind > 0 && <span>↓{status.behind}</span>}
              </span>
            )}
            <span className="git-busy">{busy}</span>
          </div>
        )}

        {commitMode && (
          <div className="git-commit-bar">
            <input
              ref={commitInputRef}
              className="git-commit-input"
              placeholder="commit message…"
              value={commitText}
              spellCheck={false}
              onChange={(e) => setCommitText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") doCommit(commitText);
                else if (e.key === "Escape") {
                  setCommitMode(false);
                  setCommitText("");
                }
                e.stopPropagation();
              }}
            />
          </div>
        )}

        <GitPanel
          n={2}
          label="Files"
          focused={panel === "files"}
          onFocus={() => setPanel("files")}
          flex={2}
        >
          {files.length === 0 && <div className="git-empty">clean tree</div>}
          {files.map((f, i) => (
            <div
              key={f.path}
              className={`git-row${
                panelFiles && sel.files === i ? " sel" : ""
              }`}
              onClick={() => {
                setPanel("files");
                setSel((s) => ({ ...s, files: i }));
              }}
            >
              <span className={`gf-x${isStaged(f) ? " on" : ""}`}>
                {f.index.trim()}
              </span>
              <span className={`gf-y${hasUnstaged(f) ? " on" : ""}`}>
                {f.worktree.trim()}
              </span>
              <FileIcon name={basenameOf(f.path)} size={14} />
              <span className="git-path">{f.path}</span>
            </div>
          ))}
        </GitPanel>

        <GitPanel
          n={3}
          label="Branches"
          focused={panel === "branches"}
          onFocus={() => setPanel("branches")}
          flex={1}
        >
          {branches.map((b, i) => (
            <div
              key={b.name}
              className={`git-row${
                panel === "branches" && sel.branches === i ? " sel" : ""
              }`}
              onClick={() => {
                setPanel("branches");
                setSel((s) => ({ ...s, branches: i }));
              }}
            >
              <span className={`gb-dot${b.current ? " cur" : ""}`} />
              <span className="git-path">{b.name}</span>
            </div>
          ))}
        </GitPanel>

        <GitPanel
          n={4}
          label="Commits"
          focused={panel === "commits"}
          onFocus={() => setPanel("commits")}
          flex={1}
        >
          {commits.map((c, i) => (
            <div
              key={c.hash}
              className={`git-row${
                panel === "commits" && sel.commits === i ? " sel" : ""
              }`}
              onClick={() => {
                setPanel("commits");
                setSel((s) => ({ ...s, commits: i }));
              }}
            >
              <span className="gc-hash">{c.hash}</span>
              <span className="git-path">{c.subject}</span>
              <span className="gc-date">{c.date}</span>
            </div>
          ))}
        </GitPanel>
      </div>

      <div className="git-right">
        {right.mode === "merge" ? (
          <MergeReview
            key={right.path}
            repo={repo}
            path={right.path}
            onOpenFile={requestOpenFile}
            onSaved={refresh}
          />
        ) : right.mode === "commit" ? (
          <CommitReview
            key={right.rev}
            repo={repo}
            rev={right.rev}
            title={right.title}
            subtitle={right.subtitle}
            onOpenFile={requestOpenFile}
          />
        ) : (
          <pre className="git-output">{right.text || "—"}</pre>
        )}
      </div>
    </div>
  );
}

function GitPanel({
  n,
  label,
  focused,
  onFocus,
  flex,
  children,
}: {
  n: number;
  label: string;
  focused: boolean;
  onFocus: () => void;
  flex: number;
  children: ReactNode;
}) {
  return (
    <div className={`git-panel${focused ? " focused" : ""}`} style={{ flex }}>
      <div className="git-panel-head" onClick={onFocus}>
        <span className="git-panel-n">{n}</span>
        <span className="git-panel-label">{label}</span>
      </div>
      <div className="git-panel-body">{children}</div>
    </div>
  );
}

