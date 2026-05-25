import type { ResourceHandle } from "../../state/resources";
import { IconRefresh } from "../Icons";

// Small refresh chip used at the top-right of every AWS view. Forces a
// re-fetch of the underlying resource (bypassing its staleAfterMs window),
// so a user who just made a change in the AWS console can pull the new
// state immediately instead of waiting out the cache.
export function AwsRefresh<T>({ handle }: { handle: ResourceHandle<T> }) {
  const busy = handle.status === "loading";
  return (
    <button
      className={`aws-refresh${busy ? " busy" : ""}`}
      onClick={() => void handle.refresh()}
      disabled={busy}
      title={busy ? "refreshing…" : "refresh from AWS"}
    >
      <IconRefresh size={12} />
    </button>
  );
}
