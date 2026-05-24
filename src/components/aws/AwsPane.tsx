import { useResource } from "../../state/resources";
import { awsIdentityR } from "../../state/resources.defs";
import { useStore } from "../../state/store";
import { AwsServiceNav } from "./AwsServiceNav";
import { AwsEcsView } from "./AwsEcsView";
import {
  AwsBillingView,
  AwsEc2View,
  AwsLambdaView,
  AwsS3View,
  AwsSqsView,
} from "./AwsListViews";
import { AwsAuthEmpty } from "./AwsAuthEmpty";

// The identity resource refreshes itself every 60s via staleAfterMs, so
// this pane no longer needs its own polling interval — the TopBar chip
// subscribes to the same cache key and stays in sync for free.
export function AwsPane() {
  const profile = useStore((s) => s.awsProfile);
  const service = useStore((s) => s.awsService);
  const identity = useResource(awsIdentityR, profile ?? "", false);
  const status = profile ? identity.data?.status ?? "unknown" : "unknown";

  if (!profile) return <AwsAuthEmpty mode="no-profile" />;
  if (status === "expired" || status === "no-credentials" || status === "error") {
    return <AwsAuthEmpty mode="unauthed" profile={profile} />;
  }

  return (
    <div className="aws-pane">
      <AwsServiceNav />
      <div className="aws-main">
        {service === "ecs" && <AwsEcsView profile={profile} />}
        {service === "ec2" && <AwsEc2View profile={profile} />}
        {service === "lambda" && <AwsLambdaView profile={profile} />}
        {service === "sqs" && <AwsSqsView profile={profile} />}
        {service === "billing" && <AwsBillingView profile={profile} />}
        {service === "s3" && <AwsS3View profile={profile} />}
      </div>
    </div>
  );
}
