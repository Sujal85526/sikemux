import * as cmd from "../../state/commands";
import { useResource } from "../../state/resources";
import { awsIdentityR, awsProfilesR } from "../../state/resources.defs";

// Shown when:
//   - no profile picked  → pick from ~/.aws/config or jump to settings
//   - selected profile is unauthed → big sign-in card with SSO start URL
export function AwsAuthEmpty({
  mode,
  profile,
}: {
  mode: "no-profile" | "unauthed";
  profile?: string;
}) {
  const profilesR = useResource(awsProfilesR);
  const identity = useResource(awsIdentityR, profile ?? "", false);
  const status = profile ? identity.data : undefined;
  const profiles = profilesR.data ?? null;

  if (mode === "no-profile") {
    return (
      <div className="aws-empty-stage">
        <div className="aws-empty-card">
          <div className="aws-empty-label">AWS</div>
          <div className="aws-empty-title">Pick a profile</div>
          <div className="aws-empty-sub">
            Profiles come from <code>~/.aws/config</code>. Run{" "}
            <code>aws configure sso</code> first if you don't have any.
          </div>
          {profiles === null && (
            <div className="aws-empty-loading">scanning…</div>
          )}
          {profiles !== null && profiles.length === 0 && (
            <div className="aws-empty-loading">
              no profiles found — run <code>aws configure sso</code> to add one
            </div>
          )}
          {profiles && profiles.length > 0 && (
            <div className="aws-profile-list">
              {profiles.map((p) => (
                <button
                  key={p.name}
                  className="aws-profile-row"
                  onClick={() => {
                    cmd.setAwsProfile(p.name);
                  }}
                >
                  <span className="aws-profile-name">{p.name}</span>
                  <span className="aws-profile-meta">
                    {p.kind === "sso" ? "SSO" : p.kind}
                    {p.region ? ` · ${p.region}` : ""}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  // unauthed
  const ssoUrl = profiles?.find((p) => p.name === profile)?.sso_start_url ?? null;
  const message = status?.message ?? "";
  return (
    <div className="aws-empty-stage">
      <div className="aws-empty-card">
        <div className="aws-empty-label">AWS</div>
        <div className="aws-empty-title">
          {status?.status === "expired"
            ? "Session expired"
            : status?.status === "no-credentials"
              ? "No credentials"
              : "Not signed in"}
        </div>
        <div className="aws-empty-sub">
          Profile <code>{profile}</code> needs a fresh SSO token.
        </div>
        {message && (
          <pre className="aws-empty-err">
            {message.length > 320 ? message.slice(0, 320) + "…" : message}
          </pre>
        )}
        <div className="aws-empty-actions">
          <button
            className="aws-empty-btn primary"
            onClick={() => cmd.openAwsAuthModal(profile ?? "", ssoUrl)}
          >
            Sign in with SSO
          </button>
          <button
            className="aws-empty-btn"
            onClick={() => void identity.refresh()}
          >
            Retry
          </button>
          <button
            className="aws-empty-btn ghost"
            onClick={() => cmd.setAwsProfile(null)}
          >
            Switch profile
          </button>
        </div>
      </div>
    </div>
  );
}
