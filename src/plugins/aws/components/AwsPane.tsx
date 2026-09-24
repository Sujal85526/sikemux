import type { ComponentType } from "react";
import { useResourceEnabled } from "../../state/resources";
import { awsIdentityR } from "../../state/resources.defs";
import { useStore } from "../../state/store";
import type { AwsService } from "../../state/types";
import { deriveAuthState, needsAuth } from "../../state/awsAuth";
import { AwsServiceNav } from "./AwsServiceNav";
import { AwsEcsView } from "./AwsEcsView";
import { AwsBillingView, AwsEc2View, AwsLambdaView, AwsS3View, AwsSqsView } from "./AwsListViews";
import { AwsAuthEmpty } from "./AwsAuthEmpty";

type AwsViewProps = { profile: string; active: boolean };

const AWS_VIEW: Record<AwsService, ComponentType<AwsViewProps>> = {
    ecs: AwsEcsView,
    ec2: AwsEc2View,
    lambda: AwsLambdaView,
    sqs: AwsSqsView,
    billing: AwsBillingView,
    s3: AwsS3View,
};

export function AwsPane({ active }: { active: boolean }) {
    const profile = useStore((s) => s.awsProfile);
    const service = useStore((s) => s.awsService);
    const identity = useResourceEnabled(active && !!profile, awsIdentityR, profile ?? "", false);
    const auth = deriveAuthState(profile, identity);

    if (auth.kind === "no-profile") return <AwsAuthEmpty mode="no-profile" />;
    if (needsAuth(auth)) {
        return <AwsAuthEmpty mode="unauthed" profile={auth.profile} />;
    }
    const p = auth.profile;
    const ServiceView = AWS_VIEW[service];
    return (
        <div className="aws-pane">
            <AwsServiceNav />
            <div className="aws-main">
                <ServiceView profile={p} active={active} />
            </div>
        </div>
    );
}
