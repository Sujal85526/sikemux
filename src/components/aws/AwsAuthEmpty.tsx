import { useEffect, useState } from "react";
import { awsApi, type AwsProfile } from "../../api/aws";
import { useWorkspace } from "../../state/workspace";

// Shown when:
//   - no profile picked (mode = "no-profile") → pick a profile from
//     ~/.aws/config or jump to settings to add one
//   - selected profile is unauthed (mode = "unauthed") → big sign-in card
//     that opens the SSO URL + lets the user run `aws sso login`
export function AwsAuthEmpty({
  mode,
  profile,
}: {
  mode: "no-profile" | "unauthed";
  profile?: string;
}) {
  const setAwsProfile = useWorkspace((s) => s.setAwsProfile);
  const refreshAwsStatus = useWorkspace((s) => s.refreshAwsStatus);
  const openAwsAuthModal = useWorkspace((s) => s.openAwsAuthModal);
  const status = useWorkspace((s) =>
    profile ? s.awsStatuses[profile] : null,
  );
  const [profiles, setProfiles] = useState<AwsProfile[] | null>(null);

  useEffect(() => {
    awsApi
      .profiles()
      .then(setProfiles)
      .catch(() => setProfiles([]));
  }, []);

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
                    setAwsProfile(p.name);
                    void refreshAwsStatus(p.name, true);
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
            onClick={() => openAwsAuthModal(profile ?? "", ssoUrl)}
          >
            Sign in with SSO
          </button>
          <button
            className="aws-empty-btn"
            onClick={() => {
              if (profile) void refreshAwsStatus(profile, true);
            }}
          >
            Retry
          </button>
          <button
            className="aws-empty-btn ghost"
            onClick={() => setAwsProfile(null)}
          >
            Switch profile
          </button>
        </div>
      </div>
    </div>
  );
}
