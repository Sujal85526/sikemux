import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { git, hasUnstaged, isStaged } from "../api/git";
import * as cmd from "../state/commands";
import { useResource } from "../state/resources";
import { gitOverviewR } from "../state/resources.defs";
import { useStore } from "../state/store";
import { reportError } from "../state/toast";
import type { GitPanel } from "../state/types";
import { CommitReview } from "./CommitReview";
import { FileIcon } from "./FileIcon";
import { MergeReview } from "./MergeReview";

const basenameOf = (p: string) => p.replace(/\/+$/, "").split("/").pop() || p;

type RightView =
  | { mode: "merge"; path: string }
  | { mode: "commit"; rev: string; title: string; subtitle: string }
  | { mode: "output"; text: string };

const DEFAULT_VIEW = {
  panel: "files" as GitPanel,
  selected: { files: 0, branches: 0, commits: 0 },
};

// Native lazygit-style git UI. View state (focused panel + per-panel
// selection) is stored per-pane so switching sessions and coming back
// puts you back where you were.
export function GitPane({
  paneId,
  cwd,
  active,
}: {
  paneId: string;
  cwd: string;
  active: boolean;
}) {
  const repo = cwd;
  const view = useStore((s) => s.gitViews[paneId] ?? DEFAULT_VIEW);
  const { panel, selected: sel } = view;

  const overview = useResource(gitOverviewR, repo || "");
  const status = repo ? overview.data?.status ?? null : null;
  const branches = repo ? overview.data?.branches ?? [] : [];
  const commits = repo ? overview.data?.log ?? [] : [];
  const files = status?.files ?? [];

  const [right, setRight] = useState<RightView>({ mode: "output", text: "" });
  const [busy, setBusy] = useState<string | null>(null);
  const [commitMode, setCommitMode] = useState(false);
  const [commitText, setCommitText] = useState("");
  const commitInputRef = useRef<HTMLInputElement>(null);

  // Filesystem watcher — backend pushes `git_changed` which App.tsx turns
  // into a resource invalidation. We just keep the watcher handle open.
  useEffect(() => {
    if (!repo) return;
    git.watchStart(repo).catch(reportError("git watch"));
    return () => {
      git.watchStop(repo).catch(() => {});
    };
  }, [repo]);

  useEffect(() => {
    if (commitMode) commitInputRef.current?.focus();
  }, [commitMode]);

  // Load the right pane for the selected row.
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
  const errorTimerRef = useRef<number | undefined>(undefined);
  const run = async (label: string, fn: () => Promise<string | void>) => {
    if (errorTimerRef.current) {
      window.clearTimeout(errorTimerRef.current);
      errorTimerRef.current = undefined;
    }
    setBusy(label);
    try {
      const out = await fn();
      if (typeof out === "string") setRight({ mode: "output", text: out });
      setBusy(null);
    } catch (err) {
      const msg = String(err);
      setRight({ mode: "output", text: `✗ ${msg}` });
      reportError(label || "git")(err);
      setBusy(`✗ ${msg.length > 80 ? msg.slice(0, 80) + "…" : msg}`);
      errorTimerRef.current = window.setTimeout(() => {
        setBusy(null);
        errorTimerRef.current = undefined;
      }, 3500);
    }
    void overview.refresh();
  };

  const setPanel = (p: GitPanel) => cmd.setGitView(paneId, { panel: p });
  const setSel = (next: typeof sel) =>
    cmd.setGitView(paneId, { selected: next });

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
    setSel({
      ...sel,
      [panel]: Math.max(0, Math.min(len - 1, sel[panel] + d)),
    });
  };

  // ---- keyboard ----
  useEffect(() => {
    if (!active || commitMode) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey || e.metaKey) return;
      if (useStore.getState().pickerOpen) return;
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
        setPanel(
          panel === "files"
            ? "branches"
            : panel === "branches"
              ? "commits"
              : "files",
        );
      else if (k === "j" || k === "ArrowDown") moveSel(1);
      else if (k === "k" || k === "ArrowUp") moveSel(-1);
      else if (k === "r") void overview.refresh();
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

        <GitPanelBlock
          n={2}
          label="Files"
          focused={panel === "files"}
          onFocus={() => setPanel("files")}
          flex={2}
          extra={
            busy && (
              <span
                className={`git-panel-busy${
                  busy.startsWith("✗") ? " error" : ""
                }`}
              >
                {!busy.startsWith("✗") && (
                  <span className="git-panel-spinner" />
                )}
                <span>{busy}</span>
              </span>
            )
          }
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
                setSel({ ...sel, files: i });
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
        </GitPanelBlock>

        <GitPanelBlock
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
                setSel({ ...sel, branches: i });
              }}
            >
              <span className={`gb-dot${b.current ? " cur" : ""}`} />
              <span className="git-path">{b.name}</span>
              {b.current &&
                status &&
                (status.ahead > 0 || status.behind > 0) && (
                  <span className="branch-track">
                    {status.ahead > 0 && (
                      <span className="branch-track-up">↑{status.ahead}</span>
                    )}
                    {status.behind > 0 && (
                      <span className="branch-track-down">↓{status.behind}</span>
                    )}
                  </span>
                )}
            </div>
          ))}
        </GitPanelBlock>

        <GitPanelBlock
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
                setSel({ ...sel, commits: i });
              }}
            >
              <span className="gc-hash">{c.hash}</span>
              <span className="git-path">{c.subject}</span>
              <span className="gc-date">{c.date}</span>
            </div>
          ))}
        </GitPanelBlock>
      </div>

      <div className="git-right">
        {right.mode === "merge" ? (
          <MergeReview
            key={right.path}
            repo={repo}
            path={right.path}
            onOpenFile={(abs) => cmd.requestOpenFile(abs)}
            onSaved={() => void overview.refresh()}
          />
        ) : right.mode === "commit" ? (
          <CommitReview
            key={right.rev}
            repo={repo}
            rev={right.rev}
            title={right.title}
            subtitle={right.subtitle}
            onOpenFile={(abs) => cmd.requestOpenFile(abs)}
          />
        ) : (
          <pre className="git-output">{right.text || "—"}</pre>
        )}
        {busy && (
          <div className="git-busy-overlay">
            <div
              className={`git-busy-card${
                busy.startsWith("✗") ? " error" : ""
              }`}
            >
              {!busy.startsWith("✗") && <span className="git-busy-spinner" />}
              <span className="git-busy-label">{busy}</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function GitPanelBlock({
  n,
  label,
  focused,
  onFocus,
  flex,
  extra,
  children,
}: {
  n: number;
  label: string;
  focused: boolean;
  onFocus: () => void;
  flex: number;
  extra?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className={`git-panel${focused ? " focused" : ""}`} style={{ flex }}>
      <div className="git-panel-head" onClick={onFocus}>
        <span className="git-panel-n">{n}</span>
        <span className="git-panel-label">{label}</span>
        {extra}
      </div>
      <div className="git-panel-body">{children}</div>
    </div>
  );
}
