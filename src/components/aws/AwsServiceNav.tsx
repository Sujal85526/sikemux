import * as cmd from "../../state/commands";
import { useStore } from "../../state/store";
import { AWS_SERVICES, type AwsService } from "../../state/types";

const META: Record<AwsService, { label: string; hint: string }> = {
    ecs: { label: "ECS", hint: "clusters · services · tasks · logs" },
    ec2: { label: "EC2", hint: "instances" },
    lambda: { label: "Lambda", hint: "functions" },
    sqs: { label: "SQS", hint: "queues" },
    billing: { label: "Billing", hint: "month-by-month" },
    s3: { label: "S3", hint: "buckets" },
};

export function AwsServiceNav() {
    const active = useStore((s) => s.awsService);
    return (
        <nav className="aws-nav">
            <div className="aws-nav-label">Services</div>
            {AWS_SERVICES.map((s, i) => {
                const m = META[s];
                const sel = active === s;
                return (
                    <button key={s} className={`aws-nav-item${sel ? " active" : ""}`} onClick={() => cmd.setAwsService(s)} title={m.hint}>
                        <span className="aws-nav-key">{i + 1}</span>
                        <span className="aws-nav-name">{m.label}</span>
                    </button>
                );
            })}
        </nav>
    );
}
