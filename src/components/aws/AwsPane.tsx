import { useResource } from "../../state/resources";
import { awsIdentityR } from "../../state/resources.defs";
import { useStore } from "../../state/store";
import { deriveAuthState, needsAuth } from "../../state/awsAuth";
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
        {service === "ecs" && <AwsEcsView profile={p} />}
        {service === "ec2" && <AwsEc2View profile={p} />}
        {service === "lambda" && <AwsLambdaView profile={p} />}
        {service === "sqs" && <AwsSqsView profile={p} />}
        {service === "billing" && <AwsBillingView profile={p} />}
        {service === "s3" && <AwsS3View profile={p} />}
      </div>
    </div>
  );
}
