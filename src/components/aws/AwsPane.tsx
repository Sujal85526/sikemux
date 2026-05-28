import { useResourceEnabled } from "../../state/resources";
import { awsIdentityR } from "../../state/resources.defs";
import { useStore } from "../../state/store";
import { deriveAuthState, needsAuth } from "../../state/awsAuth";
import { AwsServiceNav } from "./AwsServiceNav";
import { AwsEcsView } from "./AwsEcsView";
import { AwsBillingView, AwsEc2View, AwsLambdaView, AwsS3View, AwsSqsView } from "./AwsListViews";
import { AwsAuthEmpty } from "./AwsAuthEmpty";

// The identity resource refreshes itself every 60s via staleAfterMs, so
// this pane no longer needs its own polling interval — the TopBar chip
// subscribes to the same cache key and stays in sync for free.
export function AwsPane({ active }: { active: boolean }) {
    const profile = useStore((s) => s.awsProfile);
    const service = useStore((s) => s.awsService);
    const identity = useResourceEnabled(active && !!profile, awsIdentityR, profile ?? "", false);
    const auth = deriveAuthState(profile, identity);

    if (auth.kind === "no-profile") return <AwsAuthEmpty mode="no-profile" />;
    if (needsAuth(auth)) {
        return <AwsAuthEmpty mode="unauthed" profile={auth.profile} />;
    }
    // authed (also checking — service views show their own loading)
    const p = auth.profile;
    return (
        <div className="aws-pane">
            <AwsServiceNav />
            <div className="aws-main">
                {service === "ecs" && <AwsEcsView profile={p} active={active} />}
                {service === "ec2" && <AwsEc2View profile={p} active={active} />}
                {service === "lambda" && <AwsLambdaView profile={p} active={active} />}
                {service === "sqs" && <AwsSqsView profile={p} active={active} />}
                {service === "billing" && <AwsBillingView profile={p} active={active} />}
                {service === "s3" && <AwsS3View profile={p} active={active} />}
            </div>
        </div>
    );
}
