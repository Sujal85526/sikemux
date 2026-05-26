import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { git, hasUnstaged, isStaged } from "../api/git";
import * as cmd from "../state/commands";
import {
  openGitCheatsheet,
  openGitConfirm,
  openGitMenu,
  openGitPrompt,
  runGitCmd,
  toggleGitCmdLog,
} from "../state/git";
import { useResource } from "../state/resources";
import { gitOverviewR } from "../state/resources.defs";
import { useStore } from "../state/store";
import { reportError, swallow } from "../state/toast";
import type { GitPanel } from "../state/types";
import { CommitReview } from "./CommitReview";
import { FileIcon } from "./FileIcon";
import { MergeReview } from "./MergeReview";
import { GitCmdLogBar } from "./git/GitCmdLogBar";
import { GitModalRenderer } from "./git/GitModalRenderer";

const basenameOf = (p: string) => p.replace(/\/+$/, "").split("/").pop() || p;

type RightView =
  | { mode: "merge"; path: string }
  | { mode: "commit"; rev: string; title: string; subtitle: string }
  | { mode: "output"; text: string };

const DEFAULT_VIEW = {
  panel: "files" as GitPanel,
  selected: { files: 0, branches: 0, commits: 0 },
};

// Lazygit-style git pane. Per-pane view state (focused panel + per-panel
// selection) lives in store.gitViews so switching sessions and coming
// back puts you back where you were. Modals + command log live in the
// GitModalRenderer / GitCmdLogBar mounted at the pane root — both read
// from store slices set by helpers in state/git.ts.
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
  const modalOpen = useStore((s) => s.gitModal !== null);

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
  const [branchInput, setBranchInput] = useState<
    { startPoint: string } | null
  >(null);
  const [branchText, setBranchText] = useState("");
  const branchInputRef = useRef<HTMLInputElement>(null);

  // Per-panel filter — typed via `/`, applied as a substring match.
  // Persisted in component state so it survives tab-switches within the
  // pane but resets on remount.
  const [searchByPanel, setSearchByPanel] = useState<
    Record<GitPanel, string>
  >({ files: "", branches: "", commits: "" });
  const [searchOpen, setSearchOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  // Range-select anchor per panel. `null` = no range; otherwise the
  // anchor index. Range select is the lazygit `v` model.
  const [rangeByPanel, setRangeByPanel] = useState<
    Record<GitPanel, number | null>
  >({ files: null, branches: null, commits: null });

  // ---- filesystem watcher ----
  useEffect(() => {
    if (!repo) return;
    git.watchStart(repo).catch(reportError("git watch"));
    return () => {
      git.watchStop(repo).catch(swallow("git watch stop"));
    };
  }, [repo]);

  useEffect(() => {
    if (commitMode) commitInputRef.current?.focus();
  }, [commitMode]);

  useEffect(() => {
    if (branchInput) branchInputRef.current?.focus();
  }, [branchInput]);

  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus();
  }, [searchOpen]);

  // ---- filtered + range-clamped lists ----
  const fileQuery = searchByPanel.files;
  const branchQuery = searchByPanel.branches;
  const commitQuery = searchByPanel.commits;
  const filteredFiles = useMemo(
    () =>
      fileQuery
        ? files.filter((f) =>
            f.path.toLowerCase().includes(fileQuery.toLowerCase()),
          )
        : files,
    [files, fileQuery],
  );
  const filteredBranches = useMemo(
    () =>
      branchQuery
        ? branches.filter((b) =>
            b.name.toLowerCase().includes(branchQuery.toLowerCase()),
          )
        : branches,
    [branches, branchQuery],
  );
  const filteredCommits = useMemo(
    () =>
      commitQuery
        ? commits.filter(
            (c) =>
              c.subject.toLowerCase().includes(commitQuery.toLowerCase()) ||
              c.hash.toLowerCase().includes(commitQuery.toLowerCase()),
          )
        : commits,
    [commits, commitQuery],
  );

  const lenFor = (p: GitPanel) =>
    p === "files"
      ? filteredFiles.length
      : p === "branches"
        ? filteredBranches.length
        : filteredCommits.length;

  // Range = [min(anchor, sel), max(anchor, sel)] when anchor set.
  const rangeFor = (p: GitPanel): [number, number] | null => {
    const a = rangeByPanel[p];
    if (a === null) return null;
    const s = sel[p];
    return [Math.min(a, s), Math.max(a, s)];
  };

  // ---- load the right pane for the selected row ----
  useEffect(() => {
    if (panel === "files") {
      if (filteredFiles.length === 0) {
        setRight({ mode: "output", text: "" });
        return;
      }
      const f = filteredFiles[Math.min(sel.files, filteredFiles.length - 1)];
      if (f) setRight({ mode: "merge", path: f.path });
    } else if (panel === "commits") {
      if (filteredCommits.length === 0) return;
      const c =
        filteredCommits[Math.min(sel.commits, filteredCommits.length - 1)];
      if (c)
        setRight({
          mode: "commit",
          rev: c.hash,
          title: c.hash,
          subtitle: c.subject,
        });
    } else if (panel === "branches") {
      if (filteredBranches.length === 0) return;
      const b =
        filteredBranches[Math.min(sel.branches, filteredBranches.length - 1)];
      if (b)
        setRight({
          mode: "commit",
          rev: b.name,
          title: b.name,
          subtitle: "branch tip",
        });
    }
  }, [
    panel,
    sel.files,
    sel.commits,
    sel.branches,
    filteredFiles,
    filteredCommits,
    filteredBranches,
  ]);

  // ---- action helpers ----
  // Thin wrapper around runGitCmd that also drives the pane's local
  // busy indicator + right pane output preview. Every git API call goes
  // through here so the command log captures everything.
  const errorTimerRef = useRef<number | undefined>(undefined);
  async function run<T>(
    label: string,
    fn: () => Promise<T>,
    opts?: { silent?: boolean },
  ): Promise<T | undefined> {
    if (errorTimerRef.current) {
      window.clearTimeout(errorTimerRef.current);
      errorTimerRef.current = undefined;
    }
    if (!opts?.silent) setBusy(label || "running");
    try {
      const out = await runGitCmd(label, fn, { showError: false });
      if (typeof out === "string" && out && !opts?.silent) {
        setRight({ mode: "output", text: out });
      }
      setBusy(null);
      void overview.refresh();
      return out;
    } catch (err) {
      const msg = String(err);
      setRight({ mode: "output", text: `✗ ${msg}` });
      reportError(label || "git")(err);
      setBusy(`✗ ${msg.length > 80 ? msg.slice(0, 80) + "…" : msg}`);
      errorTimerRef.current = window.setTimeout(() => {
        setBusy(null);
        errorTimerRef.current = undefined;
      }, 3500);
      void overview.refresh();
      return undefined;
    }
  }

  const setPanel = (p: GitPanel) => cmd.setGitView(paneId, { panel: p });
  const setSel = (next: typeof sel) =>
    cmd.setGitView(paneId, { selected: next });

  const toggleStage = () => {
    const r = rangeFor("files");
    if (r) {
      // Range stage: stage every file in the range. Mixed-state ranges
      // (some staged, some not) all become staged — matches lazygit.
      const slice = filteredFiles.slice(r[0], r[1] + 1);
      void run("staging range", async () => {
        for (const f of slice) {
          if (hasUnstaged(f)) await git.stage(repo, f.path);
        }
      });
      return;
    }
    const f = filteredFiles[sel.files];
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
    const len = lenFor(panel);
    if (len === 0) return;
    setSel({
      ...sel,
      [panel]: Math.max(0, Math.min(len - 1, sel[panel] + d)),
    });
  };

  const doCreateBranch = (name: string, startPoint: string) => {
    if (!name.trim()) return;
    setBranchInput(null);
    setBranchText("");
    void run("creating branch…", async () => {
      await git.branchCreate(repo, name.trim(), startPoint || undefined);
      return `✓ created + checked out ${name.trim()}${startPoint ? `\n  from ${startPoint}` : ""}`;
    });
  };

  const doMerge = (branch: string) => {
    void run(`merging ${branch}…`, async () => {
      const out = await git.merge(repo, branch);
      return `✓ merged ${branch}${out ? `\n\n${out}` : ""}`;
    });
  };

  // ---- per-panel menu builders (lazygit verbs surfaced as modals) ----
  const openFilesDiscardMenu = () => {
    const f = filteredFiles[sel.files];
    if (!f) return;
    const r = rangeFor("files");
    const targets = r ? filteredFiles.slice(r[0], r[1] + 1) : [f];
    const label = r
      ? `Discard ${targets.length} files`
      : `Discard changes — ${basenameOf(f.path)}`;
    const apply = (mode: "all" | "unstaged" | "staged") => () => {
      openGitConfirm({
        title: label,
        body:
          mode === "all"
            ? `This will discard BOTH staged and unstaged changes in ${targets.length} file${targets.length > 1 ? "s" : ""}. Cannot be undone.`
            : mode === "unstaged"
              ? `Discard unstaged changes in ${targets.length} file${targets.length > 1 ? "s" : ""}? (staged changes preserved)`
              : `Unstage ${targets.length} file${targets.length > 1 ? "s" : ""} from the index? (worktree preserved)`,
        destructive: true,
        confirmLabel: "discard",
        onConfirm: async () => {
          await run(
            r ? `discarding ${targets.length} files (${mode})` : `discarding ${f.path}`,
            async () => {
              for (const t of targets) await git.discardFile(repo, t.path, mode);
            },
          );
        },
      });
    };
    openGitMenu(label, [
      {
        key: "d",
        label: "discard all changes",
        hint: "staged + worktree",
        destructive: true,
        run: apply("all"),
      },
      {
        key: "u",
        label: "discard unstaged changes",
        destructive: true,
        run: apply("unstaged"),
      },
      {
        key: "s",
        label: "unstage changes",
        run: apply("staged"),
      },
    ]);
  };

  const openFilesStashMenu = () => {
    const stash = (mode: "all" | "staged" | "unstaged") => () => {
      openGitPrompt({
        title:
          mode === "all"
            ? "Stash everything"
            : mode === "staged"
              ? "Stash staged changes"
              : "Stash unstaged changes",
        placeholder: "(optional) stash message",
        onConfirm: (msg) => {
          void run(`stashing (${mode})`, async () => {
            await git.stashPush(repo, mode, msg || null);
            return `✓ stashed (${mode})${msg ? `\n  ${msg}` : ""}`;
          });
        },
      });
    };
    openGitMenu("Stash", [
      {
        key: "s",
        label: "stash everything (working tree + index + untracked)",
        run: stash("all"),
      },
      {
        key: "i",
        label: "stash staged only",
        run: stash("staged"),
      },
      {
        key: "u",
        label: "stash unstaged only (keep index)",
        run: stash("unstaged"),
      },
    ]);
  };

  const openBranchVerbsMenu = (mode: "merge" | "delete") => {
    const b = filteredBranches[sel.branches];
    if (!b) return;
    if (mode === "merge") {
      openGitMenu(`Merge ${b.name} into HEAD`, [
        {
          key: "m",
          label: "regular merge",
          run: () => doMerge(b.name),
        },
        {
          key: "s",
          label: "squash merge",
          run: () => {
            openGitMenu("not yet wired", [
              { key: "esc", label: "squash merge backend pending", run: () => {} },
            ]);
          },
        },
      ]);
    } else {
      openGitMenu(`Delete ${b.name}`, [
        {
          key: "d",
          label: "delete local branch",
          destructive: true,
          disabled: b.current,
          hint: b.current ? "(can't delete current branch)" : undefined,
          run: () => {
            openGitMenu("not yet wired", [
              { key: "esc", label: "delete-branch backend pending", run: () => {} },
            ]);
          },
        },
      ]);
    }
  };

  const openHelpCheatsheet = () => {
    openGitCheatsheet("Git pane keybindings", [
      {
        title: "Global",
        rows: [
          { keys: "tab / 2 / 3 / 4", label: "switch panel" },
          { keys: "?", label: "open this cheatsheet" },
          { keys: "@", label: "toggle command log" },
          { keys: "/", label: "filter current panel" },
          { keys: "v", label: "toggle range select" },
          { keys: "r", label: "refresh repo state" },
          { keys: "P / p", label: "push / pull" },
          { keys: "^P", label: "open pull-request page" },
          { keys: "esc", label: "close modal / clear filter or range" },
        ],
      },
      {
        title: "Files",
        rows: [
          { keys: "space", label: "stage / unstage selected (or range)" },
          { keys: "a", label: "toggle stage all" },
          { keys: "c", label: "commit staged" },
          { keys: "C", label: "AI commit (hermes)" },
          { keys: "d", label: "discard menu" },
          { keys: "s", label: "stash menu" },
        ],
      },
      {
        title: "Branches",
        rows: [
          { keys: "enter / space", label: "checkout" },
          { keys: "n / N", label: "new branch (from selected / from HEAD)" },
          { keys: "M", label: "merge menu" },
          { keys: "d", label: "delete menu" },
        ],
      },
      {
        title: "Commits",
        rows: [
          { keys: "enter", label: "show diff" },
          { keys: "milestone 4", label: "squash / fixup / reword / drop / move / cherry-pick" },
        ],
      },
    ]);
  };

  // ---- keyboard ----
  useEffect(() => {
    if (!active || commitMode || branchInput || modalOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey || e.metaKey) return;
      if (useStore.getState().pickerOpen) return;
      // Don't hijack while the user is typing in the diff/merge editor.
      const ae = document.activeElement;
      if (ae && ae.closest(".cm-editor")) return;
      // …or while the per-panel search input is focused.
      if (searchOpen) {
        if (e.key === "Escape") {
          setSearchOpen(false);
          setSearchByPanel((s) => ({ ...s, [panel]: "" }));
          e.preventDefault();
          e.stopPropagation();
        }
        return;
      }
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

      // ----- global -----
      let handled = true;
      if (k === "?") openHelpCheatsheet();
      else if (k === "@") toggleGitCmdLog();
      else if (k === "/") setSearchOpen(true);
      else if (k === "v") {
        // Toggle range anchor on current panel.
        setRangeByPanel((s) => ({
          ...s,
          [panel]: s[panel] === null ? sel[panel] : null,
        }));
      } else if (k === "Escape") {
        // Cascade: range first, then search, then nothing.
        if (rangeByPanel[panel] !== null) {
          setRangeByPanel((s) => ({ ...s, [panel]: null }));
        } else if (searchByPanel[panel]) {
          setSearchByPanel((s) => ({ ...s, [panel]: "" }));
        } else handled = false;
      } else if (k === "2") setPanel("files");
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
      else if (k === "P")
        void run("pushing…", async () => `↑ ${await git.push(repo)}`);
      else if (k === "p")
        void run("pulling…", async () => `↓ ${await git.pull(repo)}`);
      // ----- files -----
      else if (panel === "files" && k === " ") toggleStage();
      else if (panel === "files" && k === "a") {
        const anyUnstaged = filteredFiles.some(hasUnstaged);
        void run("", () =>
          anyUnstaged ? git.stageAll(repo) : git.unstageAll(repo),
        );
      } else if (panel === "files" && k === "c") setCommitMode(true);
      else if (panel === "files" && k === "C") void aiCommit();
      else if (panel === "files" && k === "d") openFilesDiscardMenu();
      else if (panel === "files" && k === "s") openFilesStashMenu();
      // ----- branches -----
      else if (panel === "branches" && (k === "Enter" || k === " ")) {
        const b = filteredBranches[sel.branches];
        if (b && !b.current) void run("", () => git.checkout(repo, b.name));
      } else if (panel === "branches" && k === "n") {
        const b = filteredBranches[sel.branches];
        setBranchInput({ startPoint: b?.name ?? "" });
        setBranchText("");
      } else if (panel === "branches" && k === "N") {
        setBranchInput({ startPoint: "" });
        setBranchText("");
      } else if (panel === "branches" && k === "M") {
        openBranchVerbsMenu("merge");
      } else if (panel === "branches" && k === "d") {
        openBranchVerbsMenu("delete");
      } else if (panel === "branches" && k === "c") {
        // Lazygit `c` on branches = "checkout by name" prompt.
        openGitPrompt({
          title: "Checkout branch",
          placeholder: "branch name (- for previous)",
          suggestions: branches.map((b) => ({
            value: b.name,
            hint: b.current ? "current" : (b.upstream ?? ""),
          })),
          onConfirm: (name) => {
            const target = name.trim();
            if (!target) return;
            void run(`checking out ${target}`, () =>
              git.checkout(repo, target),
            );
          },
        });
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
  const filesRange = rangeFor("files");
  const branchesRange = rangeFor("branches");
  const commitsRange = rangeFor("commits");

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
        {branchInput && (
          <div className="git-commit-bar">
            <input
              ref={branchInputRef}
              className="git-commit-input"
              placeholder={
                branchInput.startPoint
                  ? `new branch (from ${branchInput.startPoint})…`
                  : "new branch (from HEAD)…"
              }
              value={branchText}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              onChange={(e) => setBranchText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter")
                  doCreateBranch(branchText, branchInput.startPoint);
                else if (e.key === "Escape") {
                  setBranchInput(null);
                  setBranchText("");
                }
                e.stopPropagation();
              }}
            />
          </div>
        )}
        {searchOpen && (
          <div className="git-commit-bar">
            <input
              ref={searchInputRef}
              className="git-commit-input"
              placeholder={`filter ${panel}…`}
              value={searchByPanel[panel]}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              onChange={(e) =>
                setSearchByPanel((s) => ({ ...s, [panel]: e.target.value }))
              }
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === "Escape") {
                  setSearchOpen(false);
                  if (e.key === "Escape") {
                    setSearchByPanel((s) => ({ ...s, [panel]: "" }));
                  }
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
          rangeBadge={
            filesRange ? `range ${filesRange[1] - filesRange[0] + 1}` : null
          }
          filterBadge={searchByPanel.files || null}
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
          {filteredFiles.length === 0 && (
            <div className="git-empty">
              {fileQuery ? "no matches" : "clean tree"}
            </div>
          )}
          {filteredFiles.map((f, i) => {
            const inRange =
              filesRange !== null && i >= filesRange[0] && i <= filesRange[1];
            return (
              <div
                key={f.path}
                className={`git-row${
                  panelFiles && sel.files === i ? " sel" : ""
                }${inRange ? " ranged" : ""}`}
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
            );
          })}
        </GitPanelBlock>

        <GitPanelBlock
          n={3}
          label="Branches"
          focused={panel === "branches"}
          onFocus={() => setPanel("branches")}
          flex={1}
          rangeBadge={
            branchesRange
              ? `range ${branchesRange[1] - branchesRange[0] + 1}`
              : null
          }
          filterBadge={searchByPanel.branches || null}
        >
          {filteredBranches.map((b, i) => {
            const inRange =
              branchesRange !== null &&
              i >= branchesRange[0] &&
              i <= branchesRange[1];
            return (
              <div
                key={b.name}
                className={`git-row${
                  panel === "branches" && sel.branches === i ? " sel" : ""
                }${inRange ? " ranged" : ""}`}
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
            );
          })}
        </GitPanelBlock>

        <GitPanelBlock
          n={4}
          label="Commits"
          focused={panel === "commits"}
          onFocus={() => setPanel("commits")}
          flex={1}
          rangeBadge={
            commitsRange ? `range ${commitsRange[1] - commitsRange[0] + 1}` : null
          }
          filterBadge={searchByPanel.commits || null}
        >
          {filteredCommits.map((c, i) => {
            const inRange =
              commitsRange !== null &&
              i >= commitsRange[0] &&
              i <= commitsRange[1];
            return (
              <div
                key={c.hash}
                className={`git-row${
                  panel === "commits" && sel.commits === i ? " sel" : ""
                }${inRange ? " ranged" : ""}`}
                onClick={() => {
                  setPanel("commits");
                  setSel({ ...sel, commits: i });
                }}
              >
                <span className="gc-hash">{c.hash}</span>
                <span className="git-path">{c.subject}</span>
                <span className="gc-date">{c.date}</span>
              </div>
            );
          })}
        </GitPanelBlock>

        <GitCmdLogBar />
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
              className={`git-busy-card${busy.startsWith("✗") ? " error" : ""}`}
            >
              {!busy.startsWith("✗") && <span className="git-busy-spinner" />}
              <span className="git-busy-label">{busy}</span>
            </div>
          </div>
        )}
      </div>

      <GitModalRenderer />
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
  rangeBadge,
  filterBadge,
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
  children: ReactNode;
}) {
  return (
    <div className={`git-panel${focused ? " focused" : ""}`} style={{ flex }}>
      <div className="git-panel-head" onClick={onFocus}>
        <span className="git-panel-n">{n}</span>
        <span className="git-panel-label">{label}</span>
        {filterBadge && (
          <span className="git-panel-pill">/{filterBadge}</span>
        )}
        {rangeBadge && <span className="git-panel-pill range">{rangeBadge}</span>}
        {extra}
      </div>
      <div className="git-panel-body">{children}</div>
    </div>
  );
}
