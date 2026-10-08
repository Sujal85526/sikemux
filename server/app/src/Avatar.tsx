import { useUser } from "@clerk/react";
import { useState } from "react";

/** The account's picture, or its initials on a neutral circle when it has none. */
export function Avatar({ size = 26 }: { size?: number }) {
  const { user } = useUser();
  const [failed, setFailed] = useState<string>();
  const picture = user?.hasImage ? user.imageUrl : undefined;
  const initials =
    [user?.firstName, user?.lastName]
      .map((name) => name?.charAt(0) ?? "")
      .join("") ||
    (user?.primaryEmailAddress?.emailAddress.charAt(0) ?? "");
  return (
    <span
      className="avatar"
      aria-hidden="true"
      style={size === 26 ? undefined : { width: size, height: size }}
    >
      {picture && picture !== failed ? (
        <img
          src={`${picture}${picture.includes("?") ? "&" : "?"}width=${size * 2}&height=${size * 2}&fit=scale-down&quality=100`}
          alt=""
          width={size}
          height={size}
          onError={() => setFailed(picture)}
        />
      ) : (
        initials.toUpperCase()
      )}
    </span>
  );
}
