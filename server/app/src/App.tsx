import { HandleSSOCallback, useAuth, useClerk, useUser } from "@clerk/react";
import { useEffect, useRef, useState, type MouseEvent } from "react";

import { Backdrop } from "./Backdrop.tsx";
import {
  AccountDeleted,
  DeleteAccount,
  DeleteAccountIntro,
} from "./DeleteAccount.tsx";
import { Devices, useDevices } from "./Devices.tsx";
import { Logo } from "./icons.tsx";
import { useLive } from "./live.ts";
import { DELETE_ACCOUNT, takeReturn, usePath } from "./navigation.ts";
import { SignIn } from "./SignIn.tsx";

const DELETED_QUERY = "?deleted";

/** Clerk leaves a nonzero `__client_uat` cookie once signed in, so the first paint can guess the right screen. */
const SIGNED_IN_BEFORE = /(?:^|;\s*)__client_uat(?:_\w+)?=[1-9]/.test(
  document.cookie,
);

export function App() {
  const { isLoaded, isSignedIn } = useAuth();
  const { signOut } = useClerk();
  const { path, go, follow } = usePath();
  const [deleted, setDeleted] = useState(false);
  const signingOut = useRef(false);
  const signedIn = isLoaded ? isSignedIn : SIGNED_IN_BEFORE;
  const showDeleted =
    deleted ||
    (path === DELETE_ACCOUNT &&
      new URLSearchParams(location.search).has("deleted") &&
      !signedIn);

  useEffect(() => {
    document.title = showDeleted
      ? "Account deleted · Sikemux"
      : path === "/sso-callback"
        ? "Signing in · Sikemux"
        : path === DELETE_ACCOUNT
          ? "Delete your account · Sikemux"
          : signedIn
            ? "Your devices · Sikemux"
            : "Sign in · Sikemux";
  }, [path, signedIn, showDeleted]);

  const afterSignIn = () => go(takeReturn(), { replace: true });

  /** Reached from this page or from the account's live connection, so it may run twice. */
  const onDeleted = () => {
    if (signingOut.current) return;
    signingOut.current = true;
    setDeleted(true);
    go(`${DELETE_ACCOUNT}${DELETED_QUERY}`, { replace: true });
    signOut({ redirectUrl: `${DELETE_ACCOUNT}${DELETED_QUERY}` }).catch(
      () => undefined,
    );
  };

  return (
    <>
      <Backdrop />
      <div className="page">
        {showDeleted ? (
          <main className="center">
            <AccountDeleted />
          </main>
        ) : path === "/sso-callback" ? (
          <section className="panel">
            <p className="quiet">Signing you in…</p>
            <HandleSSOCallback
              navigateToApp={afterSignIn}
              navigateToSignIn={afterSignIn}
              navigateToSignUp={afterSignIn}
            />
          </section>
        ) : signedIn ? (
          <Account
            ready={isLoaded}
            deleting={path === DELETE_ACCOUNT}
            onDelete={follow(DELETE_ACCOUNT)}
            onBack={() => go("/")}
            onDeleted={onDeleted}
          />
        ) : (
          <main className="center">
            {path === DELETE_ACCOUNT ? <DeleteAccountIntro /> : null}
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

function Account({
  ready,
  deleting,
  onDelete,
  onBack,
  onDeleted,
}: {
  ready: boolean;
  deleting: boolean;
  onDelete: (event: MouseEvent<HTMLAnchorElement>) => void;
  onBack: () => void;
  onDeleted: () => void;
}) {
  const { user } = useUser();
  const { isSignedIn } = useAuth();
  const { signOut } = useClerk();
  const email = user?.primaryEmailAddress?.emailAddress;
  const devices = useDevices(ready);

  useLive(ready && isSignedIn === true, {
    onEvents: devices.apply,
    onResync: devices.reload,
    onAccountDeleted: onDeleted,
  });

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
        {deleting ? (
          <DeleteAccount
            email={email}
            load={devices.load}
            onBack={onBack}
            onDeleted={onDeleted}
          />
        ) : (
          <>
            <h1>Your devices</h1>
            <p className="lede">
              Hosts and clients signed in to this account. A client still
              connects to a host only after someone at the host allows it.
            </p>
            <Devices load={devices.load} remove={devices.remove} />
            <footer className="account-footer">
              <a href={DELETE_ACCOUNT} onClick={onDelete}>
                Delete account
              </a>
            </footer>
          </>
        )}
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
