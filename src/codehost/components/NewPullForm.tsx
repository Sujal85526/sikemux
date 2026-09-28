import { useEffect, useMemo, useState } from "react";
import { notify, reportError } from "../../plugin-api/host";
import { invalidate, useResourceEnabled } from "../../plugin-api/resources";
import { Checkbox, Dropdown, IconClose } from "../../plugin-api/ui";
import { hostApi, type RepoRef } from "../api";
import { defaultBase, isUsualBase } from "../compose";
import { useHost } from "../registry";
import { hostBranchesR } from "../resources";

interface Props {
    repo: RepoRef;
    head: string | null;
    active: boolean;
    onCreated: (number: number) => void;
    onCancel: () => void;
}

export function NewPullForm({ repo, head: startingHead, active, onCreated, onCancel }: Props) {
    const host = useHost();
    const branches = useResourceEnabled(active, hostBranchesR, repo);
    const names = useMemo(() => branches.data ?? [], [branches.data]);
    const [head, setHead] = useState(startingHead && !isUsualBase(startingHead) ? startingHead : "");
    const [base, setBase] = useState<string | null>(null);
    const [title, setTitle] = useState("");
    const [body, setBody] = useState("");
    const [draft, setDraft] = useState(false);
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        if (base === null && names.length > 0) setBase(defaultBase(names, head || null));
    }, [base, names, head]);

    const pushed = !head || names.length === 0 || names.includes(head);
    const ready = !!title.trim() && !!head.trim() && !!base && base !== head && !busy;

    const create = async () => {
        if (!base) return;
        setBusy(true);
        try {
            const made = await hostApi(repo.provider).createPull(repo, { title: title.trim(), head: head.trim(), base, body, draft });
            notify("success", `Opened #${made.number}`);
            invalidate((kind) => kind === "host.pulls");
            onCreated(made.number);
        } catch (error) {
            reportError("Could not open the pull request")(error);
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="gha-detail gha-form">
            <button type="button" className="gha-back" onClick={onCancel}>
                <IconClose size={11} /> Back to pull requests
            </button>
            <h2 className="gha-title">New pull request</h2>
            <div className="gha-form-row">
                <span className="gha-form-label">From</span>
                <Dropdown
                    value={head}
                    options={[
                        ...(head && !names.includes(head) ? [{ value: head, label: head }] : []),
                        ...(head ? [] : [{ value: "", label: "Choose a branch" }]),
                        ...names.filter((name) => name !== base).map((name) => ({ value: name, label: name })),
                    ]}
                    onChange={setHead}
                    title="The branch with the changes"
                />
                <span className="gha-form-label">into</span>
                <Dropdown
                    value={base ?? ""}
                    options={names.filter((name) => name !== head).map((name) => ({ value: name, label: name }))}
                    onChange={setBase}
                    title="The branch the changes land in"
                />
            </div>
            {!pushed && (
                <div className="gha-warn-note">
                    {head} is not on {host.name} yet. Push it first, then open the pull request.
                </div>
            )}
            <input className="gha-input" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Title" aria-label="Title" />
            <textarea
                className="gha-input gha-comment-box"
                value={body}
                onChange={(event) => setBody(event.target.value)}
                placeholder="What changed, and why"
                rows={8}
                aria-label="Description"
            />
            <div className="gha-detail-actions">
                <button type="button" className="gha-btn primary" disabled={!ready || !pushed} onClick={() => void create()}>
                    {busy ? "Opening…" : draft ? "Open as a draft" : "Open pull request"}
                </button>
                {host.capabilities.pulls.draft && (
                    <Checkbox checked={draft} onChange={setDraft}>
                        Draft
                    </Checkbox>
                )}
                <button type="button" className="gha-link" onClick={onCancel}>
                    Cancel
                </button>
            </div>
        </div>
    );
}
