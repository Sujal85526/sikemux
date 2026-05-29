import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { git, hasUnstaged, isStaged } from "../api/git";
import * as cmd from "../state/commands";
import { openGitCheatsheet, openGitConfirm, openGitMenu, openGitPrompt, runGitCmd, toggleGitCmdLog } from "../state/git";
import { useResourceEnabled } from "../state/resources";
import { gitOverviewR, gitRemoteBranchesR, gitRemotesR, gitStashesR } from "../state/resources.defs";
import { useStore } from "../state/store";
import { reportError } from "../state/toast";
import type { GitPanel } from "../state/types";
import { CommitReview } from "./CommitReview";
import { FileIcon } from "./FileIcon";
import { IconChevron, IconCommit, IconFetch, IconGit, IconPull, IconPullRequest, IconPush, IconRefresh, IconSparkle } from "./Icons";
import { MergeReview } from "./MergeReview";
import { GitCmdLogBar } from "./git/GitCmdLogBar";
import { GitGraph } from "./git/GitGraph";
import { GitModalRenderer } from "./git/GitModalRenderer";

const basenameOf = (p: string) => p.replace(/\/+$/, "").split("/").pop() || p;

type RightView =
    | { mode: "merge"; path: string }
    | { mode: "commit"; rev: string; title: string; subtitle: string }
    | { mode: "output"; text: string };

const DEFAULT_VIEW = {
    panel: "files" as GitPanel,
    selected: { status: 0, files: 0, branches: 0, remotes: 0, commits: 0, stashes: 0 },
    remoteDrill: null as string | null,
    remoteBranchSelected: {} as Record<string, number>,
};

type GitAiProvider = "hermes" | "codex" | "claude";

const AI_PROVIDER_LABEL: Record<GitAiProvider, string> = {
    hermes: "Hermes",
    codex: "Codex",
    claude: "Claude",
};

// Model lists mirror each CLI's own `/model` picker (verified against the
// installed binaries) so the names are real and accepted by `--model` / `-m`.
//   claude: the `/model` aliases (sonnet/opus/haiku/opusplan/sonnet[1m]/default)
//   codex:  the gpt model ids codex ships; config default is gpt-5.5
const AI_MODELS: Record<GitAiProvider, string[]> = {
    hermes: ["openai/gpt-5.5", "openai/gpt-5.1", "anthropic/claude-sonnet-4.6", "anthropic/claude-opus-4.1", "google/gemini-2.5-pro"],
    codex: ["gpt-5.5", "gpt-5.1-codex-max", "gpt-5.1-codex", "gpt-5.1-codex-mini", "gpt-5.1", "gpt-5"],
    claude: ["sonnet", "opus", "haiku", "opusplan", "sonnet[1m]", "default"],
};

const DEFAULT_AI_PROVIDER: GitAiProvider = "hermes";
const AI_PROVIDER_STORAGE = "sikemux.git.ai.provider";
const AI_MODEL_STORAGE = "sikemux.git.ai.model";

const isGitAiProvider = (v: string | null): v is GitAiProvider => v === "hermes" || v === "codex" || v === "claude";
const defaultAiModel = (provider: GitAiProvider) => AI_MODELS[provider][0];

// Status was folded into the git toolbar; remotes/stashes are revealed
// on demand. Tab cycles the panels that are actually on screen.
const GIT_PANEL_ORDER: GitPanel[] = ["files", "branches", "commits", "remotes", "stashes"];

// Lazygit-style git pane. Per-pane view state (focused panel + per-panel
// selection) lives in store.gitViews so switching sessions and coming
// back puts you back where you were. Modals + command log live in the
// GitModalRenderer / GitCmdLogBar mounted at the pane root — both read
// from store slices set by helpers in state/git.ts.
export function GitPane({ paneId, cwd, active }: { paneId: string; cwd: string; active: boolean }) {
    const repo = cwd;
    const storedView = useStore((s) => s.gitViews[paneId]);
    const view = {
        ...DEFAULT_VIEW,
        ...(storedView ?? {}),
        selected: { ...DEFAULT_VIEW.selected, ...(storedView?.selected ?? {}) },
        remoteDrill: storedView?.remoteDrill ?? DEFAULT_VIEW.remoteDrill,
        remoteBranchSelected: storedView?.remoteBranchSelected ?? DEFAULT_VIEW.remoteBranchSelected,
    };
    const sel = view.selected;
    // Status panel was removed (its info now lives in the git toolbar). Coerce
    // any old persisted "status" selection back to the files panel.
    const panel: GitPanel = view.panel === "status" ? "files" : view.panel;
    const remoteDrill = view.remoteDrill ?? null;
    const remoteBranchSelected = view.remoteBranchSelected ?? {};
    const modalOpen = useStore((s) => s.gitModal !== null);

    const overview = useResourceEnabled(active && !!repo, gitOverviewR, repo || "");
    const remotesRes = useResourceEnabled(active && !!repo, gitRemotesR, repo || "");
    const stashesRes = useResourceEnabled(active && !!repo, gitStashesR, repo || "");
    // Only fetch remote branches when we've actually drilled into a
    // remote — keeps cold-start cost off until the user asks for it.
    const remoteBranchesRes = useResourceEnabled(active && !!repo && !!remoteDrill, gitRemoteBranchesR, repo || "", remoteDrill ?? "");
    const status = repo ? (overview.data?.status ?? null) : null;
    const branches = repo ? (overview.data?.branches ?? []) : [];
    const commits = repo ? (overview.data?.log ?? []) : [];
    const files = status?.files ?? [];
    const remotes = repo ? (remotesRes.data ?? []) : [];
    const stashes = repo ? (stashesRes.data ?? []) : [];
    const remoteBranches = repo && remoteDrill ? (remoteBranchesRes.data ?? []) : [];
    const currentBranch = branches.find((b) => b.current)?.name ?? "";

    const [right, setRight] = useState<RightView>({ mode: "output", text: "" });
    const [busy, setBusy] = useState<string | null>(null);
    const [commitText, setCommitText] = useState("");
    const commitInputRef = useRef<HTMLTextAreaElement>(null);
    const [aiProvider, setAiProvider] = useState<GitAiProvider>(() => {
        const stored = window.localStorage.getItem(AI_PROVIDER_STORAGE);
        return isGitAiProvider(stored) ? stored : DEFAULT_AI_PROVIDER;
    });
    const [aiModel, setAiModel] = useState(() => {
        const storedProvider = window.localStorage.getItem(AI_PROVIDER_STORAGE);
        const provider = isGitAiProvider(storedProvider) ? storedProvider : DEFAULT_AI_PROVIDER;
        return window.localStorage.getItem(AI_MODEL_STORAGE) || defaultAiModel(provider);
    });
    const [branchInput, setBranchInput] = useState<{ startPoint: string } | null>(null);
    const [branchText, setBranchText] = useState("");
    const branchInputRef = useRef<HTMLInputElement>(null);

    // Per-panel filter — typed via `/`, applied as a substring match.
    // Persisted in component state so it survives tab-switches within the
    // pane but resets on remount.
    const [searchByPanel, setSearchByPanel] = useState<Record<GitPanel, string>>({
        status: "",
        files: "",
        branches: "",
        remotes: "",
        commits: "",
        stashes: "",
    });
    const [searchOpen, setSearchOpen] = useState(false);
    const searchInputRef = useRef<HTMLInputElement>(null);
    // Range-select anchor per panel. `null` = no range; otherwise the
    // anchor index. Range select is the lazygit `v` model.
    const [rangeByPanel, setRangeByPanel] = useState<Record<GitPanel, number | null>>({
        status: null,
        files: null,
        branches: null,
        remotes: null,
        commits: null,
        stashes: null,
    });

    useEffect(() => {
        if (branchInput) branchInputRef.current?.focus();
    }, [branchInput]);

    useEffect(() => {
        if (searchOpen) searchInputRef.current?.focus();
    }, [searchOpen]);

    useEffect(() => {
        window.localStorage.setItem(AI_PROVIDER_STORAGE, aiProvider);
        window.localStorage.setItem(AI_MODEL_STORAGE, aiModel);
    }, [aiProvider, aiModel]);

    // ---- filtered + range-clamped lists ----
    const fileQuery = searchByPanel.files;
    const branchQuery = searchByPanel.branches;
    const commitQuery = searchByPanel.commits;
    const stashQuery = searchByPanel.stashes;
    const filteredFiles = useMemo(
        () => (fileQuery ? files.filter((f) => f.path.toLowerCase().includes(fileQuery.toLowerCase())) : files),
        [files, fileQuery],
    );
    const filteredBranches = useMemo(
        () => (branchQuery ? branches.filter((b) => b.name.toLowerCase().includes(branchQuery.toLowerCase())) : branches),
        [branches, branchQuery],
    );
    const filteredCommits = useMemo(
        () =>
            commitQuery
                ? commits.filter(
                      (c) => c.subject.toLowerCase().includes(commitQuery.toLowerCase()) || c.hash.toLowerCase().includes(commitQuery.toLowerCase()),
                  )
                : commits,
        [commits, commitQuery],
    );
    const filteredStashes = useMemo(
        () =>
            stashQuery
                ? stashes.filter(
                      (s) =>
                          s.message.toLowerCase().includes(stashQuery.toLowerCase()) ||
                          s.branch.toLowerCase().includes(stashQuery.toLowerCase()) ||
                          s.refname.toLowerCase().includes(stashQuery.toLowerCase()),
                  )
                : stashes,
        [stashes, stashQuery],
    );

    // Remotes filter applies to the panel content currently visible:
    // either the list of remotes itself OR (when drilled in) the remote's
    // branches. Same query slot — flipping in / out of the drill keeps
    // the filter text so it's easy to refine a search across both views.
    const remotesQuery = searchByPanel.remotes;
    const filteredRemotes = useMemo(
        () =>
            remotesQuery
                ? remotes.filter(
                      (r) => r.name.toLowerCase().includes(remotesQuery.toLowerCase()) || r.url.toLowerCase().includes(remotesQuery.toLowerCase()),
                  )
                : remotes,
        [remotes, remotesQuery],
    );
    const filteredRemoteBranches = useMemo(
        () => (remotesQuery ? remoteBranches.filter((b) => b.name.toLowerCase().includes(remotesQuery.toLowerCase())) : remoteBranches),
        [remoteBranches, remotesQuery],
    );
    // Selection cursor inside a drilled-in remote — keyed by remote name
    // so backing out + drilling back in restores the cursor position.
    const remoteBranchSel = remoteDrill ? (remoteBranchSelected[remoteDrill] ?? 0) : 0;

    const lenFor = (p: GitPanel) =>
        p === "status"
            ? 1
            : p === "files"
            ? filteredFiles.length
            : p === "branches"
              ? filteredBranches.length
              : p === "remotes"
                ? remoteDrill
                    ? filteredRemoteBranches.length
                    : filteredRemotes.length
                : p === "commits"
                  ? filteredCommits.length
                  : filteredStashes.length;

    // Range = [min(anchor, sel), max(anchor, sel)] when anchor set.
    const rangeFor = (p: GitPanel): [number, number] | null => {
        const a = rangeByPanel[p];
        if (a === null) return null;
        const s = sel[p];
        return [Math.min(a, s), Math.max(a, s)];
    };

    // ---- load the right pane for the selected row ----
    useEffect(() => {
        if (!active) return;
        if (panel === "files") {
            if (filteredFiles.length === 0) {
                // Clean tree (or filtered to nothing) — instead of a blank
                // right pane, surface the latest commit so there's always
                // something useful on screen.
                const c = filteredCommits[0] ?? commits[0];
                if (c) setRight({ mode: "commit", rev: c.hash, title: c.hash, subtitle: c.subject });
                else setRight({ mode: "output", text: "" });
                return;
            }
            const f = filteredFiles[Math.min(sel.files, filteredFiles.length - 1)];
            if (f) setRight({ mode: "merge", path: f.path });
        } else if (panel === "commits") {
            if (filteredCommits.length === 0) return;
            const c = filteredCommits[Math.min(sel.commits, filteredCommits.length - 1)];
            if (c)
                setRight({
                    mode: "commit",
                    rev: c.hash,
                    title: c.hash,
                    subtitle: c.subject,
                });
        } else if (panel === "branches") {
            if (filteredBranches.length === 0) return;
            const b = filteredBranches[Math.min(sel.branches, filteredBranches.length - 1)];
            if (b)
                setRight({
                    mode: "commit",
                    rev: b.name,
                    title: b.name,
                    subtitle: "branch tip",
                });
        } else if (panel === "remotes") {
            if (remoteDrill) {
                // Drilled into a remote — selected row is a remote branch.
                // Show its tip diff via the existing CommitReview surface
                // (which accepts any rev, not just commit shas).
                if (filteredRemoteBranches.length === 0) {
                    setRight({ mode: "output", text: `(no branches under ${remoteDrill}/)` });
                    return;
                }
                const rb = filteredRemoteBranches[Math.min(remoteBranchSel, filteredRemoteBranches.length - 1)];
                if (rb)
                    setRight({
                        mode: "commit",
                        rev: rb.full_ref,
                        title: rb.full_ref,
                        subtitle: rb.tracked_by ? `tracked by ${rb.tracked_by}` : "remote branch tip",
                    });
            } else {
                // Showing the flat remotes list — right pane is a key/value
                // summary of the selected remote.
                if (filteredRemotes.length === 0) {
                    setRight({
                        mode: "output",
                        text: remotes.length === 0 ? "(no remotes configured)" : "no matches",
                    });
                    return;
                }
                const r = filteredRemotes[Math.min(sel.remotes, filteredRemotes.length - 1)];
                if (r)
                    setRight({
                        mode: "output",
                        text: `remote: ${r.name}\nurl:    ${r.url}\n\npress enter to browse this remote's branches\npress f to fetch · n to add · r to rename · e to edit url · d to delete`,
                    });
            }
        } else if (panel === "stashes") {
            if (filteredStashes.length === 0) {
                setRight({
                    mode: "output",
                    text: stashes.length === 0 ? "(no stashes)" : "no matches",
                });
                return;
            }
            const s = filteredStashes[Math.min(sel.stashes, filteredStashes.length - 1)];
            if (s)
                setRight({
                    mode: "commit",
                    rev: s.refname,
                    title: s.refname,
                    subtitle: s.message,
                });
        }
    }, [
        panel,
        sel.files,
        sel.commits,
        sel.branches,
        sel.remotes,
        sel.stashes,
        remoteDrill,
        remoteBranchSel,
        status,
        files.length,
        stashes.length,
        filteredFiles,
        filteredCommits,
        filteredBranches,
        filteredRemotes,
        filteredRemoteBranches,
        filteredStashes,
        remotes.length,
        active,
    ]);

    // ---- action helpers ----
    // Thin wrapper around runGitCmd that also drives the pane's local
    // busy indicator + right pane output preview. Every git API call goes
    // through here so the command log captures everything.
    const errorTimerRef = useRef<number | undefined>(undefined);
    async function run<T>(label: string, fn: () => Promise<T>, opts?: { silent?: boolean }): Promise<T | undefined> {
        if (errorTimerRef.current) {
            window.clearTimeout(errorTimerRef.current);
            errorTimerRef.current = undefined;
        }
        if (!opts?.silent) setBusy(label || "running");
        try {
            // Pass repo so a successful op emits `git-refresh` — useGitBaseline
            // and any other listener refetch HEAD state instead of waiting for
            // the fs watcher to fire (which it does, but later).
            const out = await runGitCmd(label, fn, { showError: false, repo });
            if (typeof out === "string" && out && !opts?.silent) {
                setRight({ mode: "output", text: out });
            }
            setBusy(null);
            void overview.refresh();
            void stashesRes.refresh();
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
            void stashesRes.refresh();
            return undefined;
        }
    }

    const setPanel = (p: GitPanel) => cmd.setGitView(paneId, { panel: p });
    const setSel = (next: typeof sel) => cmd.setGitView(paneId, { selected: next });

    // Stashes panel only exists while there are stashes — if the last one
    // goes away while it's focused, fall back to the commits panel.
    useEffect(() => {
        if (panel === "stashes" && stashes.length === 0) setPanel("commits");
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [panel, stashes.length]);

    // Drill the Remotes panel into (or out of) a specific remote's
    // branches view. `null` = back to the flat remotes list.
    const setRemoteDrill = (name: string | null) => cmd.setGitView(paneId, { remoteDrill: name });
    const setRemoteBranchSel = (name: string, idx: number) =>
        cmd.setGitView(paneId, {
            remoteBranchSelected: { ...remoteBranchSelected, [name]: idx },
        });

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
        setCommitText("");
        commitInputRef.current?.blur();
        void run("committing", async () => {
            await git.commit(repo, message);
            return `✓ committed\n\n${message}`;
        });
    };

    // Generate a commit message from the diff and drop it into the message
    // box — does NOT stage or commit. Backs the ✦ button + the `g` keybind.
    // Not `silent`, so the busy loader shows while hermes/claude/codex run.
    // The closure returns void, so `run` won't dump anything into the right
    // pane — the message lands only in the commit textarea.
    const generateCommitMessage = () =>
        run(`${AI_PROVIDER_LABEL[aiProvider]} is writing the message…`, async () => {
            const model = aiModel.trim() || defaultAiModel(aiProvider);
            const msg = await git.aiMessage(repo, aiProvider, model);
            setCommitText(msg);
            commitInputRef.current?.focus();
        });

    const moveSel = (d: number) => {
        const len = lenFor(panel);
        if (len === 0) return;
        // Remotes panel drilled into a remote → cursor lives in the
        // per-remote `remoteBranchSelected` map instead of the flat
        // `selected.remotes` slot.
        if (panel === "remotes" && remoteDrill) {
            setRemoteBranchSel(remoteDrill, Math.max(0, Math.min(len - 1, remoteBranchSel + d)));
            return;
        }
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

    const openBranchRenamePrompt = () => {
        const b = filteredBranches[sel.branches];
        if (!b) return;
        openGitPrompt({
            title: `Rename branch · ${b.name}`,
            initial: b.name,
            onConfirm: (name) => {
                const n = name.trim();
                if (!n || n === b.name) return;
                void run(`renaming branch ${b.name} → ${n}`, async () => {
                    await git.branchRename(repo, b.name, n);
                    return `✓ ${b.name} → ${n}`;
                });
            },
        });
    };

    const refreshRepoState = () => {
        void overview.refresh();
        void stashesRes.refresh();
        if (panel === "remotes") {
            void remotesRes.refresh();
            if (remoteDrill) void remoteBranchesRes.refresh();
        }
    };

    // ---- per-panel menu builders (lazygit verbs surfaced as modals) ----
    const openFilesDiscardMenu = () => {
        const f = filteredFiles[sel.files];
        if (!f) return;
        const r = rangeFor("files");
        const targets = r ? filteredFiles.slice(r[0], r[1] + 1) : [f];
        const label = r ? `Discard ${targets.length} files` : `Discard changes — ${basenameOf(f.path)}`;
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
                    await run(r ? `discarding ${targets.length} files (${mode})` : `discarding ${f.path}`, async () => {
                        for (const t of targets) await git.discardFile(repo, t.path, mode);
                    });
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
                title: mode === "all" ? "Stash everything" : mode === "staged" ? "Stash staged changes" : "Stash unstaged changes",
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

    const selectedStash = () => filteredStashes[sel.stashes];

    const applySelectedStash = () => {
        const s = selectedStash();
        if (!s) return;
        void run(`applying ${s.refname}`, async () => {
            await git.stashApply(repo, s.index);
            return `✓ applied ${s.refname}`;
        });
    };

    const popSelectedStash = () => {
        const s = selectedStash();
        if (!s) return;
        void run(`popping ${s.refname}`, async () => {
            await git.stashPop(repo, s.index);
            return `✓ popped ${s.refname}`;
        });
    };

    const openStashBranchPrompt = () => {
        const s = selectedStash();
        if (!s) return;
        openGitPrompt({
            title: `Branch from ${s.refname}`,
            placeholder: "branch name",
            onConfirm: (name) => {
                const n = name.trim();
                if (!n) return;
                void run(`branching from ${s.refname}`, async () => {
                    await git.stashBranch(repo, s.index, n);
                    return `✓ created ${n} from ${s.refname}`;
                });
            },
        });
    };

    const openStashRenamePrompt = () => {
        const s = selectedStash();
        if (!s) return;
        openGitPrompt({
            title: `Rename ${s.refname}`,
            initial: s.message,
            onConfirm: (message) => {
                const m = message.trim();
                if (!m || m === s.message) return;
                void run(`renaming ${s.refname}`, async () => {
                    await git.stashRename(repo, s.index, m);
                    return `✓ renamed ${s.refname}`;
                });
            },
        });
    };

    const openStashDropConfirm = () => {
        const s = selectedStash();
        if (!s) return;
        openGitConfirm({
            title: `Drop ${s.refname}?`,
            body: "This permanently deletes the stash entry.",
            destructive: true,
            confirmLabel: "drop",
            onConfirm: () => {
                void run(`dropping ${s.refname}`, async () => {
                    await git.stashDrop(repo, s.index);
                    return `✓ dropped ${s.refname}`;
                });
            },
        });
    };

    const openStashRowMenu = () => {
        const s = filteredStashes[sel.stashes];
        if (!s) return;
        const title = `${s.refname} · ${s.message}`;
        openGitMenu(title, [
            {
                key: "a",
                label: "apply stash",
                hint: "keep stash",
                run: applySelectedStash,
            },
            {
                key: "p",
                label: "pop stash",
                hint: "apply + drop",
                run: popSelectedStash,
            },
            {
                key: "b",
                label: "create branch from stash",
                run: openStashBranchPrompt,
            },
            {
                key: "r",
                label: "rename stash",
                run: openStashRenamePrompt,
            },
            {
                key: "d",
                label: "drop stash",
                destructive: true,
                run: openStashDropConfirm,
            },
        ]);
    };

    const selectedCommit = () => filteredCommits[sel.commits];

    const openCommitBranchPrompt = () => {
        const c = selectedCommit();
        if (!c) return;
        openGitPrompt({
            title: `Branch from ${c.hash}`,
            placeholder: "branch name",
            onConfirm: (name) => {
                const n = name.trim();
                if (!n) return;
                void run(`creating ${n} from ${c.hash}`, async () => {
                    await git.branchCreate(repo, n, c.hash);
                    return `✓ created + checked out ${n}\n  from ${c.hash}`;
                });
            },
        });
    };

    const openCommitResetMenu = () => {
        const c = selectedCommit();
        if (!c) return;
        const resetTo = (mode: "soft" | "mixed" | "hard") => () => {
            openGitConfirm({
                title: `${mode} reset to ${c.hash}?`,
                body:
                    mode === "soft"
                        ? "Moves HEAD to this commit and keeps all later changes staged."
                        : mode === "mixed"
                          ? "Moves HEAD to this commit and keeps all later changes in the working tree."
                          : "Moves HEAD to this commit and discards all later changes from the index and working tree.",
                destructive: mode === "hard",
                confirmLabel: `${mode} reset`,
                onConfirm: async () => {
                    await run(`reset --${mode} ${c.hash}`, async () => {
                        await git.reset(repo, c.hash, mode);
                        return `✓ reset --${mode} ${c.hash}`;
                    });
                },
            });
        };
        openGitMenu(`Reset to ${c.hash}`, [
            { key: "s", label: "soft reset", hint: "keep changes staged", run: resetTo("soft") },
            { key: "m", label: "mixed reset", hint: "keep changes unstaged", run: resetTo("mixed") },
            { key: "h", label: "hard reset", hint: "discard later changes", destructive: true, run: resetTo("hard") },
        ]);
    };

    const openCommitRevertConfirm = () => {
        const c = selectedCommit();
        if (!c) return;
        openGitConfirm({
            title: `Revert ${c.hash}?`,
            body: "Creates a new commit that reverses this commit. Existing history is preserved.",
            confirmLabel: "revert",
            onConfirm: async () => {
                await run(`reverting ${c.hash}`, async () => {
                    await git.revert(repo, c.hash);
                    return `✓ reverted ${c.hash}`;
                });
            },
        });
    };

    const openCommitRowMenu = () => {
        const c = selectedCommit();
        if (!c) return;

        openGitMenu(`${c.hash} · ${c.subject}`, [
            {
                key: "b",
                label: "create branch from commit",
                run: openCommitBranchPrompt,
            },
            {
                key: "r",
                label: "reset to this commit",
                hint: "choose soft / mixed / hard",
                run: openCommitResetMenu,
            },
            {
                key: "v",
                label: "revert this commit",
                hint: "new inverse commit",
                run: openCommitRevertConfirm,
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
                        void run(`squash merging ${b.name}…`, async () => {
                            const out = await git.mergeSquash(repo, b.name);
                            return `✓ squash merged ${b.name}${out ? `\n\n${out}` : ""}`;
                        });
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
                        openGitConfirm({
                            title: `Delete ${b.name}?`,
                            body: "Deletes the local branch only. Use force delete if Git refuses because the branch is not merged.",
                            destructive: true,
                            confirmLabel: "delete",
                            onConfirm: async () => {
                                await run(`deleting branch ${b.name}`, async () => {
                                    await git.branchDelete(repo, b.name, false);
                                    return `✓ deleted branch ${b.name}`;
                                });
                            },
                        });
                    },
                },
                {
                    key: "D",
                    label: "force delete local branch",
                    destructive: true,
                    disabled: b.current,
                    hint: b.current ? "(can't delete current branch)" : "git branch -D",
                    run: () => {
                        openGitConfirm({
                            title: `Force delete ${b.name}?`,
                            body: "This deletes the local branch even if it has commits that are not merged anywhere else.",
                            destructive: true,
                            confirmLabel: "force delete",
                            onConfirm: async () => {
                                await run(`force deleting branch ${b.name}`, async () => {
                                    await git.branchDelete(repo, b.name, true);
                                    return `✓ force deleted branch ${b.name}`;
                                });
                            },
                        });
                    },
                },
            ]);
        }
    };

    // ---- remotes panel actions ----
    const doFetch = (remote: string | null) => {
        void run(remote ? `fetching ${remote}…` : "fetching all remotes…", async () => {
            const out = await git.fetch(repo, remote);
            // Surface bringing-down counts when git emits them — `out` from
            // `git fetch --prune` is usually empty on success, so default
            // to a friendly tick.
            return out.trim().length > 0 ? out : `✓ fetched ${remote ?? "all"}`;
        });
        // Branches data depends on remote tip — bounce the matching cache.
        void remotesRes.refresh();
        if (remoteDrill) void remoteBranchesRes.refresh();
    };

    const openAddRemotePrompt = () => {
        openGitPrompt({
            title: "Add remote",
            placeholder: "name (e.g. upstream) — then you'll enter the URL",
            onConfirm: (name) => {
                const n = name.trim();
                if (!n) return;
                openGitPrompt({
                    title: `Add remote · ${n}`,
                    placeholder: "URL (https://… or git@…)",
                    onConfirm: (url) => {
                        const u = url.trim();
                        if (!u) return;
                        void run(`adding remote ${n}`, async () => {
                            await git.remoteAdd(repo, n, u);
                            await remotesRes.refresh();
                            return `✓ added remote ${n} → ${u}`;
                        });
                    },
                });
            },
        });
    };

    const openRemoteRowMenu = () => {
        const r = filteredRemotes[sel.remotes];
        if (!r) return;
        openGitMenu(`Remote · ${r.name}`, [
            {
                key: "enter",
                label: "browse branches",
                run: () => setRemoteDrill(r.name),
            },
            {
                key: "f",
                label: "fetch this remote",
                hint: "git fetch --prune <name>",
                run: () => doFetch(r.name),
            },
            {
                key: "e",
                label: "edit url",
                run: () => {
                    openGitPrompt({
                        title: `Edit url · ${r.name}`,
                        initial: r.url,
                        onConfirm: (u) => {
                            const url = u.trim();
                            if (!url || url === r.url) return;
                            void run(`setting url for ${r.name}`, async () => {
                                await git.remoteSetUrl(repo, r.name, url);
                                await remotesRes.refresh();
                                return `✓ ${r.name} → ${url}`;
                            });
                        },
                    });
                },
            },
            {
                key: "r",
                label: "rename",
                run: () => {
                    openGitPrompt({
                        title: `Rename remote · ${r.name}`,
                        initial: r.name,
                        onConfirm: (n) => {
                            const newName = n.trim();
                            if (!newName || newName === r.name) return;
                            void run(`renaming ${r.name} → ${newName}`, async () => {
                                await git.remoteRename(repo, r.name, newName);
                                await remotesRes.refresh();
                                return `✓ ${r.name} → ${newName}`;
                            });
                        },
                    });
                },
            },
            {
                key: "d",
                label: "delete remote",
                destructive: true,
                run: () => {
                    openGitConfirm({
                        title: `Remove remote ${r.name}?`,
                        body: `Removes the local remote configuration. Won't touch the upstream repo.`,
                        destructive: true,
                        confirmLabel: "remove",
                        onConfirm: () => {
                            void run(`removing remote ${r.name}`, async () => {
                                await git.remoteRemove(repo, r.name);
                                await remotesRes.refresh();
                                return `✓ removed ${r.name}`;
                            });
                        },
                    });
                },
            },
        ]);
    };

    const openRemoteBranchMenu = () => {
        if (!remoteDrill) return;
        const rb = filteredRemoteBranches[remoteBranchSel];
        if (!rb || rb.is_head_pointer) return;
        openGitMenu(`${rb.full_ref}`, [
            {
                key: "space",
                label: rb.tracked_by ? `checkout local ${rb.tracked_by}` : `checkout (create local ${rb.name})`,
                run: () => {
                    void run(`checking out ${rb.full_ref}`, async () => {
                        await git.checkoutRemoteBranch(repo, remoteDrill, rb.name, rb.tracked_by ?? null);
                        return `✓ on ${rb.tracked_by ?? rb.name}`;
                    });
                },
            },
            {
                key: "M",
                label: `merge ${rb.full_ref} into HEAD`,
                run: () => doMerge(rb.full_ref),
            },
            {
                key: "u",
                label: `set as upstream of ${currentBranch || "HEAD"}`,
                disabled: !currentBranch,
                run: () => {
                    if (!currentBranch) return;
                    void run(`setting upstream of ${currentBranch}`, async () => {
                        await git.setUpstream(repo, currentBranch, rb.full_ref);
                        return `✓ ${currentBranch} now tracks ${rb.full_ref}`;
                    });
                },
            },
            {
                key: "d",
                label: "delete remote branch",
                destructive: true,
                run: () => {
                    openGitConfirm({
                        title: `Delete ${rb.full_ref}?`,
                        body: `Pushes a delete to ${remoteDrill}. The upstream branch will be gone for everyone.`,
                        destructive: true,
                        confirmLabel: "delete upstream",
                        onConfirm: () => {
                            void run(`deleting ${rb.full_ref}`, async () => {
                                await git.deleteRemoteBranch(repo, remoteDrill, rb.name);
                                await remoteBranchesRes.refresh();
                                return `✓ deleted ${rb.full_ref}`;
                            });
                        },
                    });
                },
            },
        ]);
    };

    const openHelpCheatsheet = () => {
        openGitCheatsheet("Git pane keybindings", [
            {
                title: "Global",
                rows: [
                    { keys: "tab / 2..6", label: "switch panel" },
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
                    { keys: "c", label: "focus commit message box" },
                    { keys: "C", label: "commit the typed message" },
                    { keys: "g", label: "generate commit message (AI)" },
                    { keys: "⌘⏎", label: "commit (from message box)" },
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
                    { keys: "R", label: "rename branch" },
                    { keys: "c", label: "checkout by name" },
                ],
            },
            {
                title: "Remotes (list)",
                rows: [
                    { keys: "enter", label: "drill into remote's branches" },
                    { keys: "n", label: "add remote" },
                    { keys: "f", label: "fetch this remote" },
                    { keys: "F", label: "fetch all remotes" },
                    { keys: "e", label: "edit url" },
                    { keys: "r", label: "rename" },
                    { keys: "d", label: "delete" },
                    { keys: "...", label: "any of the above also openable via menu" },
                ],
            },
            {
                title: "Remotes (drilled)",
                rows: [
                    { keys: "esc", label: "back to remotes list" },
                    { keys: "space / enter", label: "checkout (creates tracking branch)" },
                    { keys: "M", label: "merge into HEAD" },
                    { keys: "u", label: "set as upstream of current branch" },
                    { keys: "d", label: "delete remote branch" },
                    { keys: "f / F", label: "fetch (this remote / all)" },
                ],
            },
            {
                title: "Commits",
                rows: [
                    { keys: "enter / space", label: "actions menu" },
                    { keys: "b", label: "create branch from commit" },
                    { keys: "r", label: "reset to commit menu" },
                    { keys: "v", label: "revert commit" },
                ],
            },
            {
                title: "Stashes",
                rows: [
                    { keys: "enter", label: "actions menu" },
                    { keys: "space / a", label: "apply stash" },
                    { keys: "p", label: "pop stash" },
                    { keys: "b", label: "branch from stash" },
                    { keys: "r", label: "rename stash" },
                    { keys: "d", label: "drop stash" },
                ],
            },
        ]);
    };

    // ---- keyboard ----
    useEffect(() => {
        if (!active || branchInput || modalOpen) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.altKey || e.metaKey) return;
            if (useStore.getState().pickerOpen) return;
            // Don't hijack while the user is typing in the diff/merge editor.
            const ae = document.activeElement;
            if (ae && ae.closest(".cm-editor")) return;
            // …or while the always-on commit message input is focused.
            if (ae && ae.closest(".git-commit-panel")) return;
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
            else if (k === "v" && panel === "commits") openCommitRevertConfirm();
            else if (k === "v") {
                // Toggle range anchor on current panel.
                setRangeByPanel((s) => ({
                    ...s,
                    [panel]: s[panel] === null ? sel[panel] : null,
                }));
            } else if (k === "Escape") {
                // Cascade: range first, then search, then (in remotes) un-drill,
                // then nothing.
                if (rangeByPanel[panel] !== null) {
                    setRangeByPanel((s) => ({ ...s, [panel]: null }));
                } else if (searchByPanel[panel]) {
                    setSearchByPanel((s) => ({ ...s, [panel]: "" }));
                } else if (panel === "remotes" && remoteDrill) {
                    setRemoteDrill(null);
                } else handled = false;
            } else if (k === "2") setPanel("files");
            else if (k === "3") setPanel("branches");
            else if (k === "4") setPanel("commits");
            else if (k === "5") setPanel("remotes");
            else if (k === "6") {
                if (stashes.length > 0) setPanel("stashes");
            } else if (k === "Tab") {
                // Cycle only the panels that are actually on screen — stashes
                // is hidden when empty.
                const order = GIT_PANEL_ORDER.filter((p) => p !== "stashes" || stashes.length > 0);
                const i = order.indexOf(panel);
                setPanel(order[(i + 1) % order.length]);
            }
            else if (k === "j" || k === "ArrowDown") moveSel(1);
            else if (k === "k" || k === "ArrowUp") moveSel(-1);
            else if (k === "r") {
                if (panel === "stashes") openStashRenamePrompt();
                else if (panel === "commits") openCommitResetMenu();
                else if (panel === "remotes" && !remoteDrill) openRemoteRowMenu();
                else refreshRepoState();
            } else if (k === "F") doFetch(null);
            else if (k === "P") void run("pushing…", async () => `↑ ${await git.push(repo)}`);
            else if (k === "p" && panel === "stashes") popSelectedStash();
            else if (k === "p") void run("pulling…", async () => `↓ ${await git.pull(repo)}`);
            // ----- files -----
            else if (panel === "files" && k === " ") toggleStage();
            else if (panel === "files" && k === "a") {
                const anyUnstaged = filteredFiles.some(hasUnstaged);
                void run("", () => (anyUnstaged ? git.stageAll(repo) : git.unstageAll(repo)));
            } else if (panel === "files" && k === "c") commitInputRef.current?.focus();
            else if (panel === "files" && k === "C") doCommit(commitText);
            else if (panel === "files" && k === "g") void generateCommitMessage();
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
            } else if (panel === "branches" && k === "R") {
                openBranchRenamePrompt();
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
                        void run(`checking out ${target}`, () => git.checkout(repo, target));
                    },
                });
            }
            // ----- remotes (flat list) -----
            else if (panel === "remotes" && !remoteDrill && k === "Enter") {
                const r = filteredRemotes[sel.remotes];
                if (r) setRemoteDrill(r.name);
            } else if (panel === "remotes" && !remoteDrill && k === "n") {
                openAddRemotePrompt();
            } else if (panel === "remotes" && !remoteDrill && k === "f") {
                const r = filteredRemotes[sel.remotes];
                if (r) doFetch(r.name);
            } else if (panel === "remotes" && !remoteDrill && k === "e") {
                openRemoteRowMenu();
                // Re-issue the `e` action explicitly so users don't need to press
                // the menu hotkey when they're aiming directly at "edit url".
                // (The menu still acts as the discoverable surface.)
            } else if (panel === "remotes" && !remoteDrill && (k === "d" || k === "r")) {
                // Both `d` (delete) and `r` (rename) live in the row menu —
                // open it so the user always sees the consequences before
                // committing.
                openRemoteRowMenu();
            }
            // ----- remotes (drilled into a remote) -----
            else if (panel === "remotes" && remoteDrill && k === "Enter") {
                openRemoteBranchMenu();
            } else if (panel === "remotes" && remoteDrill && (k === " " || k === "Space")) {
                const rb = filteredRemoteBranches[remoteBranchSel];
                if (rb && !rb.is_head_pointer) {
                    void run(`checking out ${rb.full_ref}`, async () => {
                        await git.checkoutRemoteBranch(repo, remoteDrill, rb.name, rb.tracked_by ?? null);
                        return `✓ on ${rb.tracked_by ?? rb.name}`;
                    });
                }
            } else if (panel === "remotes" && remoteDrill && k === "M") {
                const rb = filteredRemoteBranches[remoteBranchSel];
                if (rb && !rb.is_head_pointer) doMerge(rb.full_ref);
            } else if (panel === "remotes" && remoteDrill && k === "u") {
                const rb = filteredRemoteBranches[remoteBranchSel];
                if (rb && !rb.is_head_pointer && currentBranch) {
                    void run(`setting upstream of ${currentBranch}`, async () => {
                        await git.setUpstream(repo, currentBranch, rb.full_ref);
                        return `✓ ${currentBranch} now tracks ${rb.full_ref}`;
                    });
                }
            } else if (panel === "remotes" && remoteDrill && k === "d") {
                openRemoteBranchMenu();
            } else if (panel === "remotes" && remoteDrill && k === "f") {
                doFetch(remoteDrill);
            }
            // ----- commits -----
            else if (panel === "commits" && (k === "Enter" || k === " ")) {
                openCommitRowMenu();
            } else if (panel === "commits" && k === "b") {
                openCommitBranchPrompt();
            } else if (panel === "commits" && k === "v") {
                openCommitRevertConfirm();
            }
            // ----- stashes -----
            else if (panel === "stashes" && k === "Enter") {
                openStashRowMenu();
            } else if (panel === "stashes" && (k === " " || k === "a")) {
                applySelectedStash();
            } else if (panel === "stashes" && k === "p") {
                popSelectedStash();
            } else if (panel === "stashes" && k === "b") {
                openStashBranchPrompt();
            } else if (panel === "stashes" && k === "d") {
                openStashDropConfirm();
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
    const remotesRange = rangeFor("remotes");
    const commitsRange = rangeFor("commits");
    const stashesRange = rangeFor("stashes");
    const stagedCount = filteredFiles.filter(isStaged).length;
    const unstagedCount = filteredFiles.filter(hasUnstaged).length;
    const upstreamLabel = status?.upstream ?? "no upstream";

    return (
        <div className="git-pane">
            <div className="git-toolbar">
                    <span className="git-tb-status">
                        <IconGit size={13} className={`git-tb-icon${files.length > 0 ? " dirty" : ""}`} />
                        <span className="git-tb-branch" title={`upstream: ${upstreamLabel}`}>
                            {currentBranch || status?.branch || "—"}
                        </span>
                        <span className="git-tb-changed">
                            {files.length === 0 ? "clean" : `${files.length} changed · ${stagedCount} staged · ${unstagedCount} unstaged`}
                        </span>
                        {stashes.length > 0 && (
                            <span className="git-tb-stash">{stashes.length === 1 ? "1 stash" : `${stashes.length} stashes`}</span>
                        )}
                        {busy && (
                            <span className={`git-tb-busy${busy.startsWith("✗") ? " error" : ""}`}>
                                {!busy.startsWith("✗") && <span className="git-panel-spinner" />}
                                <span>{busy}</span>
                            </span>
                        )}
                    </span>
                    <span className="git-tb-grow" />
                    <button
                        className="git-tbtn live"
                        type="button"
                        onClick={() => void run("pushing…", async () => `↑ ${await git.push(repo)}`)}
                        title={status && status.ahead > 0 ? `Push ${status.ahead} commit${status.ahead > 1 ? "s" : ""} (P)` : "Push (P)"}>
                        <IconPush size={13} />
                        {status && status.ahead > 0 && <span className="git-tbtn-count">{status.ahead}</span>}
                        push<kbd className="git-kbd">P</kbd>
                    </button>
                    <button
                        className="git-tbtn"
                        type="button"
                        onClick={() => void run("pulling…", async () => `↓ ${await git.pull(repo)}`)}
                        title={status && status.behind > 0 ? `Pull ${status.behind} commit${status.behind > 1 ? "s" : ""} (p)` : "Pull (p)"}>
                        <IconPull size={13} />
                        {status && status.behind > 0 && <span className="git-tbtn-count">{status.behind}</span>}
                        pull<kbd className="git-kbd">p</kbd>
                    </button>
                    <button className="git-tbtn" type="button" onClick={() => doFetch(null)} title="Fetch all remotes (F)">
                        <IconFetch size={13} />fetch<kbd className="git-kbd">F</kbd>
                    </button>
                    <button
                        className="git-tbtn"
                        type="button"
                        onClick={() =>
                            void run("opening PR…", async () => {
                                const url = await git.prOpen(repo);
                                return `→ ${url}`;
                            })
                        }
                        title="Open pull request (⌃P)">
                        <IconPullRequest size={13} />PR
                    </button>
                    <button className="git-tbtn icon" type="button" onClick={refreshRepoState} title="Refresh (r)">
                        <IconRefresh size={14} />
                    </button>
            </div>
            <div className="git-body">
            <div className="git-left">
                <div className="git-commit-panel">
                    <div className="git-panel-head">
                        <button type="button" className="git-cp-headfocus" onClick={() => commitInputRef.current?.focus()} title="Focus commit message">
                            <span className="git-panel-n">1</span>
                            <span className="git-panel-label">Commit</span>
                        </button>
                        <div className="git-cp-head-actions">
                            <GitSelect
                                title="AI provider"
                                width={76}
                                value={aiProvider}
                                label={AI_PROVIDER_LABEL[aiProvider]}
                                options={(Object.keys(AI_PROVIDER_LABEL) as GitAiProvider[]).map((p) => ({ value: p, label: AI_PROVIDER_LABEL[p] }))}
                                onSelect={(v) => {
                                    const provider = isGitAiProvider(v) ? v : DEFAULT_AI_PROVIDER;
                                    setAiProvider(provider);
                                    setAiModel(defaultAiModel(provider));
                                }}
                            />
                            <GitSelect
                                title="AI model"
                                width={150}
                                value={aiModel || defaultAiModel(aiProvider)}
                                label={aiModel || defaultAiModel(aiProvider)}
                                options={AI_MODELS[aiProvider].map((m) => ({ value: m, label: m }))}
                                onSelect={(v) => setAiModel(v)}
                            />
                            <button
                                className="git-cp-ai"
                                type="button"
                                onClick={() => void generateCommitMessage()}
                                title={`Generate commit message with ${AI_PROVIDER_LABEL[aiProvider]} · ${aiModel || defaultAiModel(aiProvider)} (g) — does not stage or commit`}>
                                <IconSparkle size={15} />
                            </button>
                        </div>
                    </div>
                    <div className="git-cp-body">
                        <textarea
                            ref={commitInputRef}
                            className="git-cp-input"
                            placeholder="commit message…"
                            value={commitText}
                            spellCheck={false}
                            rows={3}
                            onChange={(e) => setCommitText(e.target.value)}
                            onKeyDown={(e) => {
                                // Multi-line input → Enter is a newline; commit on
                                // ⌘/Ctrl+Enter. Esc clears + blurs.
                                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) doCommit(commitText);
                                else if (e.key === "Escape") {
                                    setCommitText("");
                                    commitInputRef.current?.blur();
                                }
                                e.stopPropagation();
                            }}
                        />
                        <div className="git-cp-actions">
                            <button
                                className="git-cp-commit"
                                type="button"
                                disabled={!commitText.trim()}
                                onClick={() => doCommit(commitText)}
                                title="Commit staged (⌘⏎)">
                                <IconCommit size={13} />commit
                            </button>
                        </div>
                    </div>
                </div>
                {branchInput && (
                    <div className="git-commit-bar">
                        <input
                            ref={branchInputRef}
                            className="git-commit-input"
                            placeholder={branchInput.startPoint ? `new branch (from ${branchInput.startPoint})…` : "new branch (from HEAD)…"}
                            value={branchText}
                            spellCheck={false}
                            autoCapitalize="off"
                            autoCorrect="off"
                            onChange={(e) => setBranchText(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === "Enter") doCreateBranch(branchText, branchInput.startPoint);
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
                            onChange={(e) => setSearchByPanel((s) => ({ ...s, [panel]: e.target.value }))}
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
                    flex={panel === "files" ? 2.6 : 1.4}
                    actions={[
                        {
                            key: "a",
                            label: filteredFiles.some(hasUnstaged) ? "stage all" : "unstage all",
                            onClick: () => {
                                const anyUnstaged = filteredFiles.some(hasUnstaged);
                                void run("", () => (anyUnstaged ? git.stageAll(repo) : git.unstageAll(repo)));
                            },
                        },
                        { key: "s", label: "stash", tone: "warn", onClick: openFilesStashMenu },
                    ]}
                    rangeBadge={filesRange ? `range ${filesRange[1] - filesRange[0] + 1}` : null}
                    filterBadge={searchByPanel.files || null}>
                    {filteredFiles.length === 0 && <div className="git-empty">{fileQuery ? "no matches" : "clean tree"}</div>}
                    {filteredFiles.map((f, i) => {
                        const inRange = filesRange !== null && i >= filesRange[0] && i <= filesRange[1];
                        return (
                            <div
                                key={f.path}
                                className={`git-row${panelFiles && sel.files === i ? " sel" : ""}${inRange ? " ranged" : ""}`}
                                onClick={() => {
                                    setPanel("files");
                                    setSel({ ...sel, files: i });
                                }}>
                                <span className={`gf-x${isStaged(f) ? " on" : ""}`}>{f.index.trim()}</span>
                                <span className={`gf-y${hasUnstaged(f) ? " on" : ""}`}>{f.worktree.trim()}</span>
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
                    flex={panel === "branches" ? 2.6 : 1}
                    actions={[
                        {
                            key: "n",
                            label: "new",
                            onClick: () => {
                                setBranchInput({ startPoint: "" });
                                setBranchText("");
                            },
                        },
                        { key: "M", label: "merge", onClick: () => openBranchVerbsMenu("merge") },
                    ]}
                    rangeBadge={branchesRange ? `range ${branchesRange[1] - branchesRange[0] + 1}` : null}
                    filterBadge={searchByPanel.branches || null}>
                    {filteredBranches.map((b, i) => {
                        const inRange = branchesRange !== null && i >= branchesRange[0] && i <= branchesRange[1];
                        return (
                            <div
                                key={b.name}
                                className={`git-row${panel === "branches" && sel.branches === i ? " sel" : ""}${inRange ? " ranged" : ""}`}
                                onClick={() => {
                                    setPanel("branches");
                                    setSel({ ...sel, branches: i });
                                }}>
                                <span className={`gb-dot${b.current ? " cur" : ""}`} />
                                <span className="git-path">{b.name}</span>
                                {b.current && status && (status.ahead > 0 || status.behind > 0) && (
                                    <span className="branch-track">
                                        {status.ahead > 0 && <span className="branch-track-up">↑{status.ahead}</span>}
                                        {status.behind > 0 && <span className="branch-track-down">↓{status.behind}</span>}
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
                    flex={panel === "commits" ? 2.6 : 1}
                    actions={[
                        { key: "b", label: "branch", onClick: openCommitBranchPrompt },
                        { key: "r", label: "reset", tone: "warn", onClick: openCommitResetMenu },
                        { key: "v", label: "revert", tone: "danger", onClick: openCommitRevertConfirm },
                    ]}
                    rangeBadge={commitsRange ? `range ${commitsRange[1] - commitsRange[0] + 1}` : null}
                    filterBadge={searchByPanel.commits || null}>
                    {filteredCommits.length === 0 ? (
                        <div className="git-empty">{commitQuery ? "no matches" : "no commits"}</div>
                    ) : (
                        <GitGraph
                            commits={filteredCommits}
                            selectedIndex={Math.min(sel.commits, filteredCommits.length - 1)}
                            focused={panel === "commits"}
                            range={commitsRange}
                            onSelect={(i) => {
                                setPanel("commits");
                                setSel({ ...sel, commits: i });
                            }}
                            onActivate={openCommitRowMenu}
                        />
                    )}
                </GitPanelBlock>

                {panel === "remotes" && (
                <GitPanelBlock
                    n={5}
                    label={remoteDrill ? `Remotes · ${remoteDrill}` : "Remotes"}
                    focused={panel === "remotes"}
                    onFocus={() => {
                        setPanel("remotes");
                        // Re-focus also un-drills if user clicks the header — gives
                        // them a way back without the keyboard.
                        if (remoteDrill) setRemoteDrill(null);
                    }}
                    flex={2.6}
                    actions={[
                        { key: "n", label: "add", onClick: openAddRemotePrompt },
                        { key: "F", label: "fetch", onClick: () => doFetch(null) },
                    ]}
                    rangeBadge={remotesRange ? `range ${remotesRange[1] - remotesRange[0] + 1}` : null}
                    filterBadge={searchByPanel.remotes || null}>
                    {remoteDrill ? (
                        <>
                            <button type="button" className="git-row git-row-back" onClick={() => setRemoteDrill(null)} title="Back to remotes (esc)">
                                <span className="git-row-back-glyph">←</span>
                                <span className="git-path">{remoteDrill}</span>
                                <span className="git-row-hint">esc to go back</span>
                            </button>
                            {filteredRemoteBranches.length === 0 && (
                                <div className="git-empty">
                                    {remoteBranchesRes.status === "loading"
                                        ? "loading…"
                                        : remotesQuery
                                          ? "no matches"
                                          : `no branches under ${remoteDrill}/`}
                                </div>
                            )}
                            {filteredRemoteBranches.map((rb, i) => {
                                const inRange = remotesRange !== null && i >= remotesRange[0] && i <= remotesRange[1];
                                return (
                                    <div
                                        key={rb.full_ref}
                                        className={`git-row${
                                            panel === "remotes" && remoteBranchSel === i ? " sel" : ""
                                        }${inRange ? " ranged" : ""}${rb.is_head_pointer ? " muted" : ""}`}
                                        onClick={() => {
                                            setPanel("remotes");
                                            setRemoteBranchSel(remoteDrill, i);
                                        }}
                                        title={rb.is_head_pointer ? `${rb.full_ref} (HEAD pointer)` : rb.full_ref}>
                                        <span className="gb-dot remote" />
                                        <span className="git-path">{rb.name}</span>
                                        {rb.tracked_by && <span className="git-tracked">↻ {rb.tracked_by}</span>}
                                        {rb.is_head_pointer && <span className="git-row-hint">HEAD</span>}
                                    </div>
                                );
                            })}
                        </>
                    ) : (
                        <>
                            {filteredRemotes.length === 0 && (
                                <div className="git-empty">
                                    {remotesRes.status === "loading" ? "loading…" : remotesQuery ? "no matches" : "no remotes — press n to add"}
                                </div>
                            )}
                            {filteredRemotes.map((r, i) => {
                                const inRange = remotesRange !== null && i >= remotesRange[0] && i <= remotesRange[1];
                                return (
                                    <div
                                        key={r.name}
                                        className={`git-row${panel === "remotes" && sel.remotes === i ? " sel" : ""}${inRange ? " ranged" : ""}`}
                                        onClick={() => {
                                            setPanel("remotes");
                                            setSel({ ...sel, remotes: i });
                                        }}
                                        onDoubleClick={() => setRemoteDrill(r.name)}
                                        title={r.url}>
                                        <span className="gb-dot remote" />
                                        <span className="git-path">{r.name}</span>
                                        <span className="git-remote-url">{r.url}</span>
                                    </div>
                                );
                            })}
                        </>
                    )}
                </GitPanelBlock>
                )}

                {stashes.length > 0 && (
                <GitPanelBlock
                    n={6}
                    label="Stashes"
                    focused={panel === "stashes"}
                    onFocus={() => setPanel("stashes")}
                    flex={panel === "stashes" ? 2.6 : 1}
                    actions={[
                        { key: "p", label: "pop", onClick: popSelectedStash },
                        { key: "d", label: "drop", tone: "danger", onClick: openStashDropConfirm },
                    ]}
                    rangeBadge={stashesRange ? `range ${stashesRange[1] - stashesRange[0] + 1}` : null}
                    filterBadge={searchByPanel.stashes || null}>
                    {filteredStashes.length === 0 && (
                        <div className="git-empty">{stashesRes.status === "loading" ? "loading…" : stashQuery ? "no matches" : "no stashes"}</div>
                    )}
                    {filteredStashes.map((s, i) => {
                        const inRange = stashesRange !== null && i >= stashesRange[0] && i <= stashesRange[1];
                        return (
                            <div
                                key={s.refname}
                                className={`git-row${panel === "stashes" && sel.stashes === i ? " sel" : ""}${inRange ? " ranged" : ""}`}
                                onClick={() => {
                                    setPanel("stashes");
                                    setSel({ ...sel, stashes: i });
                                }}
                                onDoubleClick={openStashRowMenu}>
                                <span className="gc-hash">{s.refname}</span>
                                <span className="git-path">{s.message}</span>
                                {s.branch && <span className="git-row-hint">{s.branch}</span>}
                            </div>
                        );
                    })}
                </GitPanelBlock>
                )}

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
                        <div className={`git-busy-card${busy.startsWith("✗") ? " error" : ""}`}>
                            {!busy.startsWith("✗") && <span className="git-busy-spinner" />}
                            <span className="git-busy-label">{busy}</span>
                        </div>
                    </div>
                )}
            </div>
            </div>

            <GitModalRenderer />
        </div>
    );
}

// Custom dropdown — replaces the native <select> for the AI provider/model
// pickers so they match the app's chrome (sharp corners, rail-2 menu, accent
// active state) instead of the OS widget. Scrim closes on outside click.
function GitSelect({
    value,
    label,
    options,
    onSelect,
    title,
    width,
}: {
    value: string;
    label: string;
    options: { value: string; label: string }[];
    onSelect: (value: string) => void;
    title?: string;
    width?: number;
}) {
    const [open, setOpen] = useState(false);
    return (
        <div className="git-dd">
            <button
                type="button"
                className="git-dd-btn"
                style={width ? { width } : undefined}
                title={title}
                onClick={(e) => {
                    e.stopPropagation();
                    setOpen((v) => !v);
                }}>
                <span className="git-dd-val">{label}</span>
                <IconChevron size={9} className="git-dd-chev" />
            </button>
            {open && (
                <>
                    <div className="git-dd-scrim" onClick={() => setOpen(false)} />
                    <div className="git-dd-menu">
                        {options.map((o) => (
                            <button
                                key={o.value}
                                type="button"
                                className={`git-dd-item${o.value === value ? " active" : ""}`}
                                onClick={() => {
                                    onSelect(o.value);
                                    setOpen(false);
                                }}>
                                <span className="git-dd-check">{o.value === value ? "✓" : ""}</span>
                                <span className="git-dd-item-label">{o.label}</span>
                            </button>
                        ))}
                    </div>
                </>
            )}
        </div>
    );
}

interface PanelAction {
    key?: string;
    label: string;
    onClick: () => void;
    tone?: "ai" | "live" | "warn" | "danger";
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
            <div className="git-panel-head" onClick={onFocus}>
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
