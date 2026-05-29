import { useEffect, useMemo, useState } from "react";
import { git } from "../../api/git";
import { rundeckApi, type BranchRelation, type PlanResult, type PushAction } from "../../api/rundeck";
import * as cmd from "../../state/commands";
import { useResourceEnabled } from "../../state/resources";
import { rndPlanR } from "../../state/resources.defs";
import { useStore } from "../../state/store";

interface Props {
    paneId: string;
    level: {
        kind: "deploy";
        env: string;
        project: string;
        service: string;
        jobId: string;
        branch: string;
        repoPath?: string;
    };
    active: boolean;
}

const RELATION_BANNER: Record<BranchRelation, { kind: "ok" | "warn" | "danger" | "muted"; text: string }> = {
    same: { kind: "ok", text: "Target matches currently-deployed branch." },
    "target-contains-deployed": {
        kind: "ok",
        text: "Target branch contains the currently-deployed branch.",
    },
    "target-missing-deployed": {
        kind: "danger",
        text: "Target does NOT contain the deployed branch — different line of work.",
    },
    "unknown-no-deployed-branch": {
        kind: "muted",
        text: "No previous successful deployment — first deploy.",
    },
    "unknown-deployed-not-on-origin": {
        kind: "muted",
        text: "Deployed branch isn't on origin — relation unknown.",
    },
    "unknown-target-not-on-origin": {
        kind: "warn",
        text: "Target branch isn't on origin — Rundeck won't find it during deploy.",
    },
};

const PUSH_LABEL: Record<PushAction, string> = {
    "will-push-current": "Will push current branch before deploying.",
    "will-not-push-different-branch": "Local branch differs from target — will not push (Rundeck fetches from origin).",
    "will-not-push-no-repo": "No local repo selected.",
    "will-not-push-detached": "Local HEAD is detached — will not push.",
};

export function RundeckDeploy({ paneId, level, active }: Props) {
    const settings = useStore((s) => s.rundeck);
    const isProd = settings.prodEnvs.includes(level.env);

    // Source project cwd → repo path used by the plan endpoint for local
    // inspection. Empty string → "no repo" semantics. Deploy views opened
    // from a project session carry this explicitly because the active session
    // becomes the Rundeck session after navigation.
    const session = useStore((s) => s.sessions[s.activeSessionId]);
    const repoPath = level.repoPath ?? session?.cwd ?? "";

    const [branch, setBranch] = useState(level.branch);
    const [prodInput, setProdInput] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        setBranch(level.branch);
    }, [level.branch, level.jobId, level.project, level.service]);

    const branchValue = branch.trim();
    const plan = useResourceEnabled(active && !!branchValue, rndPlanR, level.project, level.service, branchValue, repoPath);

    const banner = useMemo(() => {
        if (!plan.data) return null;
        return RELATION_BANNER[plan.data.branch_relation];
    }, [plan.data]);

    const prodOk = !isProd || prodInput.trim() === level.env;
    const planReady = plan.status === "ok" && plan.data?.target_branch === branchValue;
    const canDeploy = !!branchValue && !busy && prodOk && planReady;

    const deploy = async () => {
        if (!canDeploy) return;
        setBusy(true);
        setError(null);
        try {
            if (plan.data?.push_action === "will-push-current" && repoPath) {
                await git.push(repoPath);
            }
            const res = await rundeckApi.run(level.project, level.service, branchValue);
            // Replace deploy view with the live execution view — single forward
            // navigation, no popups.
            cmd.rundeckReplace(paneId, {
                kind: "execution",
                executionId: res.id,
                project: level.project,
                service: level.service,
            });
        } catch (e) {
            const msg = typeof e === "object" && e && "message" in e ? String((e as { message: string }).message) : String(e);
            setError(msg);
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="rnd-deploy">
            <div className="rnd-section-head">
                <div className="rnd-section-title">
                    <span className="rnd-section-eyebrow">deploy → {level.env}</span>
                    <span className="rnd-section-name">{level.service}</span>
                    <span className="rnd-section-proj">{level.project}</span>
                </div>
            </div>

            <div className="rnd-deploy-form">
                <label className="rnd-field">
                    <span>branch</span>
                    <input
                        type="text"
                        value={branch}
                        onChange={(e) => setBranch(e.target.value)}
                        spellCheck={false}
                        autoCapitalize="off"
                        autoCorrect="off"
                    />
                    {plan.data?.current_branch && (
                        <button type="button" className="rnd-field-hint" onClick={() => setBranch(plan.data!.current_branch!)}>
                            use current ({plan.data.current_branch})
                        </button>
                    )}
                </label>
            </div>

            <div className="rnd-plan">
                <div className="rnd-plan-head">deploy plan</div>
                {plan.status === "loading" && !plan.data && (
                    <div className="rnd-plan-row muted">
                        <span className="rnd-spinner inline" /> computing plan…
                    </div>
                )}
                {!branchValue && <div className="rnd-plan-row muted">Enter a branch to compute the deploy plan.</div>}
                {plan.data && <PlanTable plan={plan.data} isProd={isProd} />}
                {banner && <div className={`rnd-banner ${banner.kind}`}>{banner.text}</div>}
                {plan.data?.branch_relation_detail && <div className="rnd-banner muted">{plan.data.branch_relation_detail}</div>}
                {plan.error && <div className="rnd-banner danger">{plan.error}</div>}
            </div>

            {isProd && (
                <div className="rnd-prod-gate">
                    <div className="rnd-prod-gate-title">⚠ Production deploy</div>
                    <div className="rnd-prod-gate-msg">
                        Type <code>{level.env}</code> below to enable the deploy button.
                    </div>
                    <input
                        type="text"
                        placeholder={level.env}
                        value={prodInput}
                        onChange={(e) => setProdInput(e.target.value)}
                        spellCheck={false}
                        autoCapitalize="off"
                        autoCorrect="off"
                    />
                </div>
            )}

            {error && <div className="rnd-banner danger">{error}</div>}

            <div className="rnd-deploy-actions">
                <button className="rnd-btn" onClick={() => cmd.rundeckPop(paneId)} disabled={busy}>
                    cancel
                </button>
                <button className={`rnd-btn rnd-btn-primary${isProd ? " rnd-btn-danger" : ""}`} disabled={!canDeploy} onClick={deploy}>
                    {busy ? "triggering…" : isProd ? "deploy to production" : "deploy"}
                </button>
            </div>
        </div>
    );
}

function PlanTable({ plan, isProd }: { plan: PlanResult; isProd: boolean }) {
    return (
        <div className="rnd-plan-table">
            <PlanRow label="project" value={plan.project} />
            <PlanRow label="service" value={plan.service} />
            <PlanRow label="target branch" value={plan.target_branch} />
            <PlanRow label="currently deployed" value={plan.deployed_branch ?? "—"} />
            <PlanRow label="local repo" value={plan.git_root ?? "not in a git repo"} />
            <PlanRow label="current branch" value={plan.current_branch ?? "—"} />
            <PlanRow label="HEAD" value={plan.head_sha ?? "—"} />
            <PlanRow label="dirty tree" value={plan.dirty ? "yes" : "no"} tone={plan.dirty ? "warn" : "ok"} />
            <PlanRow label="upstream" value={plan.upstream ?? "—"} />
            <PlanRow label="ahead / behind" value={plan.ahead != null && plan.behind != null ? `${plan.ahead} ahead, ${plan.behind} behind` : "—"} />
            <PlanRow
                label="origin target"
                value={plan.remote_target_exists ? "exists" : "missing"}
                tone={plan.remote_target_exists ? "ok" : "warn"}
            />
            <PlanRow label="push behavior" value={PUSH_LABEL[plan.push_action]} />
            {isProd && <PlanRow label="env" value="production — type-to-confirm required below" tone="danger" />}
        </div>
    );
}

function PlanRow({ label, value, tone }: { label: string; value: string; tone?: "ok" | "warn" | "danger" }) {
    return (
        <div className={`rnd-plan-row${tone ? ` tone-${tone}` : ""}`}>
            <span className="rnd-plan-k">{label}</span>
            <span className="rnd-plan-v">{value}</span>
        </div>
    );
}
