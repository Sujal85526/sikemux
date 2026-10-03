import { HandleSSOCallback, useAuth, useClerk, useUser } from "@clerk/react";
import { useEffect, useState } from "react";

import { Backdrop } from "./Backdrop.tsx";
import { Devices } from "./Devices.tsx";
import { Logo } from "./icons.tsx";
import { SignIn } from "./SignIn.tsx";

/** Clerk leaves a nonzero `__client_uat` cookie once signed in, so the first paint can guess the right screen. */
const SIGNED_IN_BEFORE = /(?:^|;\s*)__client_uat(?:_\w+)?=[1-9]/.test(
  document.cookie,
);

export function App() {
  const { isLoaded, isSignedIn } = useAuth();
  const [path, setPath] = useState(location.pathname);
  const signedIn = isLoaded ? isSignedIn : SIGNED_IN_BEFORE;

  useEffect(() => {
    document.title =
      path === "/sso-callback"
        ? "Signing in · Sikemux"
        : signedIn
          ? "Your devices · Sikemux"
          : "Sign in · Sikemux";
  }, [path, signedIn]);

  const goHome = () => {
    history.replaceState(null, "", "/");
    setPath("/");
  };

  return (
    <>
      <Backdrop />
      <div className="page">
        {path === "/sso-callback" ? (
          <section className="panel">
            <p className="quiet">Signing you in…</p>
            <HandleSSOCallback
              navigateToApp={goHome}
              navigateToSignIn={goHome}
              navigateToSignUp={goHome}
            />
          </section>
        ) : signedIn ? (
          <Account ready={isLoaded} />
        ) : (
          <main className="center">
            <SignIn ready={isLoaded} />
            <footer className="legal">
              <a href="https://sikemux.com/privacy">Privacy</a>
              <a href="https://sikemux.com/terms">Terms</a>
            </footer>
          </main>
        )}
      </div>
    </>
  );
}

function Account({ ready }: { ready: boolean }) {
  const { user } = useUser();
  const { signOut } = useClerk();
  const email = user?.primaryEmailAddress?.emailAddress;
  return (
    <div className="account">
      <header className="top">
        <div className="brand">
          <Logo size={20} />
          <span>Sikemux</span>
        </div>
        <div className="who">
          <Avatar />
          {email ? <span className="email">{email}</span> : null}
          <button
            type="button"
            className="button small"
            onClick={() => void signOut({ redirectUrl: "/" })}
            disabled={!ready}
          >
            Sign out
          </button>
        </div>
      </header>
      <main>
        <h1>Your devices</h1>
        <p className="lede">
          Hosts and clients signed in to this account. A client still connects
          to a host only after someone at the host allows it.
        </p>
        <Devices ready={ready} />
      </main>
    </div>
  );
}

/** The account's picture, or its initials on a neutral circle when it has none. */
function Avatar() {
  const { user } = useUser();
  const [failed, setFailed] = useState<string>();
  const picture = user?.hasImage ? user.imageUrl : undefined;
  const initials =
    [user?.firstName, user?.lastName]
      .map((name) => name?.charAt(0) ?? "")
      .join("") ||
    (user?.primaryEmailAddress?.emailAddress.charAt(0) ?? "");
  return (
    <span className="avatar" aria-hidden="true">
      {picture && picture !== failed ? (
        <img
          src={`${picture}${picture.includes("?") ? "&" : "?"}width=56&height=56&fit=crop&quality=100`}
          alt=""
          width={26}
          height={26}
          onError={() => setFailed(picture)}
        />
      ) : (
        initials.toUpperCase()
      )}
    </span>
  );
}
