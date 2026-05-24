import { useEffect } from "react";
import { useWorkspace } from "../../state/workspace";
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

// Periodic auth refresh — same 60s as tmux-aws so status stays current
// while the user sits on the pane.
const AUTH_POLL_MS = 60_000;

export function AwsPane() {
  const profile = useWorkspace((s) => s.awsProfile);
  const service = useWorkspace((s) => s.awsService);
  const status = useWorkspace((s) =>
    profile ? s.awsStatuses[profile] : null,
  );
  const refreshAwsStatus = useWorkspace((s) => s.refreshAwsStatus);

  // Keep auth status fresh on this pane.
  useEffect(() => {
    if (!profile) return;
    void refreshAwsStatus(profile);
    const id = window.setInterval(
      () => void refreshAwsStatus(profile),
      AUTH_POLL_MS,
    );
    return () => window.clearInterval(id);
  }, [profile, refreshAwsStatus]);

  // No profile or unauthed → big empty-state covers the whole pane (sidebar
  // hidden) so the path forward is obvious.
  if (!profile) return <AwsAuthEmpty mode="no-profile" />;
  const st = status?.status ?? "unknown";
  if (st === "expired" || st === "no-credentials" || st === "error") {
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
