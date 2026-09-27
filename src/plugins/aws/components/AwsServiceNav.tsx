import { useResource, useResourceEnabled } from "../../../plugin-api/resources";
import { Dropdown, IconAws } from "../../../plugin-api/ui";
import { awsIdentityR, awsProfilesR } from "../resources";
import { AWS_SERVICES, awsSettings, setAwsProfile, setAwsService, useAws, type AwsService } from "../state";
import { ServiceGlyph } from "./icons";
import { State } from "./parts";

const META: Record<AwsService, { label: string; hint: string }> = {
    ecs: { label: "ECS", hint: "Clusters, services, tasks and logs" },
    ec2: { label: "EC2", hint: "Instances" },
    lambda: { label: "Lambda", hint: "Functions and their logs" },
    sqs: { label: "SQS", hint: "Queues" },
    billing: { label: "Billing", hint: "Costs by month" },
    s3: { label: "S3", hint: "Buckets" },
};

export function AwsServiceNav({ profile, signedIn }: { profile: string; signedIn: boolean }) {
    const active = awsSettings.useSelect((s) => s.service);
    const counts = useAws((s) => s.counts[profile]);
    return (
        <nav className="aws-nav" aria-label="AWS services">
            <div className="aws-nav-label">Services</div>
            {AWS_SERVICES.map((s, i) => {
                const sel = signedIn && active === s;
                return (
                    <button
                        key={s}
                        className={`aws-nav-item${sel ? " active" : ""}`}
                        aria-current={sel ? "page" : undefined}
                        onClick={() => setAwsService(s)}
                        disabled={!signedIn}
                        title={`${META[s].hint} · ${i + 1}`}>
                        <span className="aws-nav-icon">
                            <ServiceGlyph service={s} />
                        </span>
                        <span className="aws-nav-name">{META[s].label}</span>
                        {signedIn && counts?.[s] && <span className="aws-nav-count">{counts[s]}</span>}
                    </button>
                );
            })}
            <Account profile={profile} />
        </nav>
    );
}

function Account({ profile }: { profile: string }) {
    const profiles = useResource(awsProfilesR).data ?? [];
    const identity = useResourceEnabled(true, awsIdentityR, profile, false);
    const region = profiles.find((p) => p.name === profile)?.region;
    const account = identity.data?.account;
    const status = identity.data?.status;
    return (
        <div className="aws-account">
            <div className="aws-account-top">
                <span className="aws-account-logo">
                    <IconAws size={18} />
                </span>
                <div className="aws-account-who">
                    <Dropdown
                        className="aws-account-pick"
                        value={profile}
                        title="Switch profile"
                        label="AWS profile"
                        options={profiles.map((p) => ({
                            value: p.name,
                            label: p.name,
                            detail: [p.kind === "sso" ? "SSO" : p.kind, p.region].filter(Boolean).join(" · "),
                        }))}
                        onChange={(name) => setAwsProfile(name)}
                        menuWidth={240}
                    />
                    <span className="aws-account-id">{account ? account.replace(/^(\d{4})(\d{4})(\d{4})$/, "$1-$2-$3") : "—"}</span>
                </div>
            </div>
            <div className="aws-account-meta">
                <span>{region ?? "no region"}</span>
                {status === "authed" ? (
                    <State health="ok" label="Signed in" />
                ) : status ? (
                    <State health="warn" label={status === "expired" ? "Expired" : "Signed out"} />
                ) : (
                    <State health="off" label="Checking" />
                )}
            </div>
        </div>
    );
}
