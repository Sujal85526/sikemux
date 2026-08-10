import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CaptureGitCheckpointOptions, GitCheckpoint, GitWorktree } from "../../api/git";
import { IS_WINDOWS } from "../../lib/platform";
import { CHECKPOINT_PANEL_LIMITS, CheckpointPanel, type CheckpointPanelApi } from "./CheckpointPanel";

interface Deferred<Value> {
    readonly promise: Promise<Value>;
    readonly resolve: (value: Value | PromiseLike<Value>) => void;
    readonly reject: (error: unknown) => void;
}

function deferred<Value>(): Deferred<Value> {
    let resolve!: (value: Value | PromiseLike<Value>) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

function checkpoint(id: string, label: string, createdAt: number, overrides: Partial<GitCheckpoint> = {}): GitCheckpoint {
    return {
        id,
        ref: `refs/sikemux/checkpoints/agent-safe/${id}`,
        commit: id.endsWith("1") ? "a".repeat(40) : "b".repeat(40),
        head: "c".repeat(40),
        createdAt,
        label,
        fileCount: 2,
        additionCount: 5,
        deletionCount: 3,
        ...overrides,
    };
}

function worktree(path: string, branch: string): GitWorktree {
    return {
        path,
        head: "d".repeat(40),
        branch,
        reference: `refs/heads/${branch}`,
        detached: false,
        locked: false,
        lock_reason: null,
        prunable: false,
        prune_reason: null,
        bare: false,
        current: false,
        is_main: false,
    };
}

function createApi(overrides: Partial<CheckpointPanelApi> = {}): CheckpointPanelApi {
    return {
        checkpointCapture: vi.fn(async (_repo: string, options: CaptureGitCheckpointOptions) =>
            checkpoint(options.checkpointId, options.label, 1_700_000_000_300),
        ),
        checkpoints: vi.fn(async () => []),
        checkpointDiff: vi.fn(async () => ""),
        checkpointDelete: vi.fn(async () => undefined),
        checkpointFork: vi.fn(async (_repo, options) => worktree(options.path, options.branch)),
        ...overrides,
    };
}

const REPO = "/workspace/project";
const AGENT = "agent-safe";
const ABSOLUTE_FORK_PATH = IS_WINDOWS ? "C:\\workspace\\checkpoint-fork" : "/workspace/checkpoint-fork";
const ROOT_FORK_PATH = IS_WINDOWS ? "C:\\" : "/";

afterEach(cleanup);

describe("CheckpointPanel", () => {
    it("loads a bounded namespace and reviews a checkpoint optionally against its predecessor", async () => {
        const user = userEvent.setup();
        const newest = checkpoint("cp-002", "Newest snapshot", 1_700_000_000_200);
        const previous = checkpoint("cp-001", "Previous snapshot", 1_700_000_000_100);
        const api = createApi({
            checkpoints: vi.fn(async () => [previous, newest]),
            checkpointDiff: vi.fn(async (_repo, _agent, _checkpointId, baseCheckpointId) =>
                baseCheckpointId ? "diff versus previous" : "diff versus HEAD",
            ),
        });

        render(<CheckpointPanel repo={REPO} initialAgentNamespace={AGENT} api={api} />);

        expect(await screen.findByText("Newest snapshot")).toBeInTheDocument();
        expect(screen.getByText("Previous snapshot")).toBeInTheDocument();
        expect(vi.mocked(api.checkpoints)).toHaveBeenCalledWith(REPO, AGENT);
        await waitFor(() => expect(screen.getByLabelText("Checkpoint diff")).toHaveTextContent("diff versus HEAD"));
        expect(vi.mocked(api.checkpointDiff)).toHaveBeenLastCalledWith(REPO, AGENT, "cp-002", null);

        await user.click(screen.getByRole("checkbox", { name: "Compare with previous checkpoint" }));
        await waitFor(() => expect(screen.getByLabelText("Checkpoint diff")).toHaveTextContent("diff versus previous"));
        expect(vi.mocked(api.checkpointDiff)).toHaveBeenLastCalledWith(REPO, AGENT, "cp-002", "cp-001");
        expect(screen.getByRole("region", { name: "Checkpoints" })).toHaveAttribute("aria-busy", "false");
    });

    it("ignores stale namespace refreshes and suppresses duplicate refreshes", async () => {
        const user = userEvent.setup();
        const first = deferred<GitCheckpoint[]>();
        const second = deferred<GitCheckpoint[]>();
        const checkpoints = vi.fn((_repo: string, agentId: string) => (agentId === AGENT ? first.promise : second.promise));
        const api = createApi({ checkpoints });
        render(<CheckpointPanel repo={REPO} initialAgentNamespace={AGENT} api={api} />);

        const namespace = screen.getByLabelText("Agent namespace");
        await user.clear(namespace);
        await user.type(namespace, "agent-next");
        await user.click(screen.getByRole("button", { name: "refresh" }));
        await user.click(screen.getByRole("button", { name: /refreshing/i }));
        expect(checkpoints).toHaveBeenCalledTimes(2);

        second.resolve([checkpoint("cp-next", "Next namespace", 1_700_000_000_500)]);
        expect(await screen.findByText("Next namespace")).toBeInTheDocument();
        first.resolve([checkpoint("cp-old", "Stale namespace", 1_700_000_000_600)]);
        await Promise.resolve();
        await Promise.resolve();
        expect(screen.queryByText("Stale namespace")).not.toBeInTheDocument();
        expect(screen.getByText("Next namespace")).toBeInTheDocument();
    });

    it("keeps checkpoints from the loaded namespace read-only while another namespace loads", async () => {
        const user = userEvent.setup();
        const next = deferred<GitCheckpoint[]>();
        const current = checkpoint("cp-002", "Current namespace", 1_700_000_000_200);
        const previous = checkpoint("cp-001", "Current predecessor", 1_700_000_000_100);
        const api = createApi({
            checkpoints: vi.fn((_repo: string, agentId: string) => (agentId === AGENT ? Promise.resolve([current, previous]) : next.promise)),
        });
        render(<CheckpointPanel repo={REPO} initialAgentNamespace={AGENT} api={api} confirmDelete={vi.fn(async () => true)} />);
        await screen.findByText("Current namespace");

        const namespace = screen.getByLabelText("Agent namespace");
        await user.clear(namespace);
        await user.type(namespace, "agent-next");
        await user.click(screen.getByRole("button", { name: "refresh" }));

        expect(screen.getByRole("button", { name: "Select checkpoint Current namespace" })).toBeDisabled();
        expect(screen.getByRole("button", { name: "delete" })).toBeDisabled();
        expect(screen.getByRole("checkbox", { name: "Compare with previous checkpoint" })).toBeDisabled();
        expect(screen.getByLabelText("Checkpoint label")).toBeDisabled();
        expect(screen.getByLabelText("Fork path")).toBeDisabled();
        expect(screen.getByLabelText("Fork branch")).toBeDisabled();

        next.resolve([]);
        await screen.findByText("No checkpoints in this namespace.");
    });

    it("captures once with a validated generated ID and a trimmed bounded label", async () => {
        const user = userEvent.setup();
        const captureGate = deferred<GitCheckpoint>();
        const checkpointCapture = vi.fn((_repo: string, _options: CaptureGitCheckpointOptions) => captureGate.promise);
        const api = createApi({ checkpointCapture });
        render(<CheckpointPanel repo={REPO} initialAgentNamespace={AGENT} api={api} createCheckpointId={() => "cp-deterministic"} />);
        await screen.findByText("No checkpoints in this namespace.");

        await user.type(screen.getByLabelText("Checkpoint label"), "  Safe snapshot  ");
        const captureButton = screen.getByRole("button", { name: "capture" });
        await user.click(captureButton);
        await user.click(captureButton);
        expect(checkpointCapture).toHaveBeenCalledOnce();
        expect(checkpointCapture).toHaveBeenCalledWith(REPO, {
            agentId: AGENT,
            checkpointId: "cp-deterministic",
            label: "Safe snapshot",
        });

        captureGate.resolve(checkpoint("cp-deterministic", "Safe snapshot", 1_700_000_000_700));
        expect(await screen.findByText("Safe snapshot")).toBeInTheDocument();
        expect(screen.getByText("Captured checkpoint Safe snapshot.")).toBeInTheDocument();
        expect(screen.getByLabelText("Checkpoint label")).toHaveValue("");
    });

    it("deletes only after an explicit affirmative confirmation and prevents duplicate deletion", async () => {
        const user = userEvent.setup();
        const selected = checkpoint("cp-001", "Disposable snapshot", 1_700_000_000_100);
        const deleteGate = deferred<void>();
        const checkpointDelete = vi.fn(() => deleteGate.promise);
        const confirmDelete = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
        const api = createApi({ checkpoints: vi.fn(async () => [selected]), checkpointDelete });
        render(<CheckpointPanel repo={REPO} initialAgentNamespace={AGENT} api={api} confirmDelete={confirmDelete} />);
        await screen.findByText("Disposable snapshot");

        await user.click(screen.getByRole("button", { name: "delete" }));
        await screen.findByText("Checkpoint deletion cancelled.");
        expect(checkpointDelete).not.toHaveBeenCalled();

        const deleteButton = screen.getByRole("button", { name: "delete" });
        await user.click(deleteButton);
        await user.click(deleteButton);
        expect(confirmDelete).toHaveBeenCalledTimes(2);
        expect(Object.isFrozen(confirmDelete.mock.calls[0]![0])).toBe(true);
        expect(checkpointDelete).toHaveBeenCalledOnce();
        expect(checkpointDelete).toHaveBeenCalledWith(REPO, AGENT, "cp-001");

        deleteGate.resolve();
        expect(await screen.findByText("Deleted checkpoint Disposable snapshot.")).toBeInTheDocument();
        expect(screen.queryByText("Disposable snapshot")).not.toBeInTheDocument();
    });

    it("forks only with an explicit bounded absolute path and safe branch", async () => {
        const user = userEvent.setup();
        const selected = checkpoint("cp-001", "Forkable snapshot", 1_700_000_000_100);
        const checkpointFork = vi.fn(async (_repo: string, options) => worktree(options.path, options.branch));
        const onForked = vi.fn();
        const api = createApi({ checkpoints: vi.fn(async () => [selected]), checkpointFork });
        render(<CheckpointPanel repo={REPO} initialAgentNamespace={AGENT} api={api} onForked={onForked} />);
        await screen.findByText("Forkable snapshot");

        const pathInput = screen.getByLabelText("Fork path");
        const branchInput = screen.getByLabelText("Fork branch");
        await user.type(pathInput, ROOT_FORK_PATH);
        await user.type(branchInput, "review/checkpoint");
        await user.click(screen.getByRole("button", { name: "fork checkpoint" }));
        expect(await screen.findByRole("alert")).toHaveTextContent("cannot be a filesystem root");
        expect(checkpointFork).not.toHaveBeenCalled();

        await user.clear(pathInput);
        await user.type(pathInput, "relative/path");
        await user.click(screen.getByRole("button", { name: "fork checkpoint" }));
        expect(await screen.findByRole("alert")).toHaveTextContent("Fork path must be absolute");
        expect(checkpointFork).not.toHaveBeenCalled();

        await user.clear(pathInput);
        await user.type(pathInput, ABSOLUTE_FORK_PATH);
        await user.clear(branchInput);
        await user.type(branchInput, "bad..branch");
        await user.click(screen.getByRole("button", { name: "fork checkpoint" }));
        expect(await screen.findByRole("alert")).toHaveTextContent("safe Git branch name");
        expect(checkpointFork).not.toHaveBeenCalled();

        await user.clear(branchInput);
        await user.type(branchInput, "review/checkpoint");
        await user.click(screen.getByRole("button", { name: "fork checkpoint" }));
        await waitFor(() => expect(checkpointFork).toHaveBeenCalledOnce());
        expect(checkpointFork).toHaveBeenCalledWith(REPO, {
            agentId: AGENT,
            checkpointId: "cp-001",
            path: ABSOLUTE_FORK_PATH,
            branch: "review/checkpoint",
        });
        expect(onForked).toHaveBeenCalledWith(worktree(ABSOLUTE_FORK_PATH, "review/checkpoint"));
    });

    it("keeps the newest diff generation and caps an eight-MiB response before rendering", async () => {
        const user = userEvent.setup();
        const newest = checkpoint("cp-002", "Newest snapshot", 1_700_000_000_200);
        const previous = checkpoint("cp-001", "Previous snapshot", 1_700_000_000_100);
        const staleDiff = deferred<string>();
        const hugeDiff = "x".repeat(8 * 1_024 * 1_024);
        const checkpointDiff = vi
            .fn()
            .mockReturnValueOnce(staleDiff.promise)
            .mockResolvedValueOnce("selected older diff")
            .mockResolvedValueOnce(hugeDiff);
        const api = createApi({ checkpoints: vi.fn(async () => [newest, previous]), checkpointDiff });
        render(<CheckpointPanel repo={REPO} initialAgentNamespace={AGENT} api={api} />);
        await screen.findByText("Newest snapshot");

        await user.click(screen.getByRole("button", { name: "Select checkpoint Previous snapshot" }));
        await waitFor(() => expect(screen.getByLabelText("Checkpoint diff")).toHaveTextContent("selected older diff"));
        staleDiff.resolve("stale newest diff");
        await Promise.resolve();
        expect(screen.getByLabelText("Checkpoint diff")).not.toHaveTextContent("stale newest diff");

        await user.click(screen.getByRole("button", { name: "Select checkpoint Newest snapshot" }));
        await screen.findByText("The rendered diff was capped; the checkpoint itself is unchanged.");
        const rendered = screen.getByLabelText("Checkpoint diff").textContent ?? "";
        expect(rendered).toContain("diff truncated to 256 KiB");
        expect(rendered.length).toBeLessThanOrEqual(CHECKPOINT_PANEL_LIMITS.maxRenderedDiffBytes + 80);
        expect(rendered.length).toBeLessThan(hugeDiff.length);
    });

    it("rejects oversized lists and exposes only bounded control-free errors", async () => {
        const oversized = Array.from({ length: CHECKPOINT_PANEL_LIMITS.maxCheckpoints + 1 }, (_value, index) =>
            checkpoint(`cp-${index}`, `Snapshot ${index}`, 1_700_000_000_000 + index),
        );
        const error = new Error(`\u001b[31m native\nsecret ${"x".repeat(1_000)}`);
        const checkpoints = vi.fn().mockResolvedValueOnce(oversized).mockRejectedValueOnce(error);
        const api = createApi({ checkpoints });
        const { rerender } = render(<CheckpointPanel repo={REPO} initialAgentNamespace={AGENT} api={api} />);

        let alert = await screen.findByRole("alert");
        expect(alert).toHaveTextContent(`at most ${CHECKPOINT_PANEL_LIMITS.maxCheckpoints} items`);
        expect(screen.queryByRole("button", { name: /Select checkpoint/u })).not.toBeInTheDocument();

        rerender(<CheckpointPanel repo={REPO} initialAgentNamespace="agent-other" api={api} />);
        alert = await screen.findByRole("alert");
        expect(alert.textContent).not.toContain("\u001b");
        expect(alert.textContent).not.toContain("\n");
        expect((alert.textContent ?? "").length).toBeLessThanOrEqual(CHECKPOINT_PANEL_LIMITS.maxErrorCharacters + 40);
    });
});
