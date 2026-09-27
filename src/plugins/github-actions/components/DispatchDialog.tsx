import { useState } from "react";
import { notify, reportError } from "../../../plugin-api/host";
import { invalidate, useResource } from "../../../plugin-api/resources";
import { usePluginOverlay } from "../../../plugin-api/host";
import { IconClose, IconPlus } from "../../../plugin-api/ui";
import { actionsApi, type RepoRef, type Workflow } from "../api";
import { actionsBranchesR } from "../resources";

interface Input {
    key: string;
    name: string;
    value: string;
}

let nextKey = 0;

interface Props {
    repo: RepoRef;
    workflow: Workflow;
    defaultBranch: string | null;
    onClose: () => void;
}

/**
 * Starting a workflow by hand. What inputs it takes is written in its own
 * file, which this does not read, so they are typed as names and values and
 * GitHub says if one is wrong.
 */
export function DispatchDialog({ repo, workflow, defaultBranch, onClose }: Props) {
    const branches = useResource(actionsBranchesR, repo);
    const [gitRef, setGitRef] = useState(defaultBranch ?? "");
    const [inputs, setInputs] = useState<Input[]>([]);
    const [busy, setBusy] = useState(false);
    usePluginOverlay(true);

    const submit = async () => {
        setBusy(true);
        const values: Record<string, string> = {};
        for (const input of inputs) {
            const name = input.name.trim();
            if (name) values[name] = input.value;
        }
        try {
            await actionsApi.dispatch(repo, workflow.id, gitRef.trim(), values);
            notify("success", `Started ${workflow.name} on ${gitRef.trim()}`);
            // GitHub takes a moment to register the run, so the list is re-read
            // once rather than immediately showing nothing new.
            setTimeout(() => invalidate((kind) => kind === "gha.runs"), 1500);
            onClose();
        } catch (error) {
            reportError(`Could not start ${workflow.name}`)(error);
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="gha-modal-scrim" role="presentation" onClick={onClose}>
            <div className="gha-modal" role="dialog" aria-label={`Run ${workflow.name}`} onClick={(event) => event.stopPropagation()}>
                <div className="gha-modal-head">
                    <h2>Run {workflow.name}</h2>
                    <button type="button" className="gha-icon-btn" onClick={onClose} aria-label="Close">
                        <IconClose size={13} />
                    </button>
                </div>

                <label className="gha-field">
                    <span>Branch or tag</span>
                    <input
                        className="gha-input gha-mono"
                        list="gha-branches"
                        value={gitRef}
                        onChange={(event) => setGitRef(event.target.value)}
                        placeholder="main"
                        autoFocus
                        spellCheck={false}
                    />
                    <datalist id="gha-branches">
                        {(branches.data ?? []).map((branch) => (
                            <option key={branch} value={branch} />
                        ))}
                    </datalist>
                </label>

                <div className="gha-inputs">
                    {inputs.map((input, index) => (
                        <div className="gha-input-row" key={input.key}>
                            <input
                                className="gha-input gha-mono"
                                value={input.name}
                                placeholder="input"
                                spellCheck={false}
                                onChange={(event) =>
                                    setInputs((all) => all.map((each, at) => (at === index ? { ...each, name: event.target.value } : each)))
                                }
                            />
                            <input
                                className="gha-input gha-mono"
                                value={input.value}
                                placeholder="value"
                                spellCheck={false}
                                onChange={(event) =>
                                    setInputs((all) => all.map((each, at) => (at === index ? { ...each, value: event.target.value } : each)))
                                }
                            />
                            <button
                                type="button"
                                className="gha-icon-btn"
                                aria-label={`Remove ${input.name || "input"}`}
                                onClick={() => setInputs((all) => all.filter((_, at) => at !== index))}>
                                <IconClose size={11} />
                            </button>
                        </div>
                    ))}
                    <button
                        type="button"
                        className="gha-link"
                        onClick={() => setInputs((all) => [...all, { key: String(nextKey++), name: "", value: "" }])}>
                        <IconPlus size={11} /> Add an input
                    </button>
                </div>

                <div className="gha-modal-actions">
                    <button type="button" className="gha-btn" onClick={onClose}>
                        Cancel
                    </button>
                    <button type="button" className="gha-btn primary" disabled={busy || !gitRef.trim()} onClick={() => void submit()}>
                        {busy ? "Starting…" : "Run workflow"}
                    </button>
                </div>
            </div>
        </div>
    );
}
