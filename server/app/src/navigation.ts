import { useEffect, useState, type MouseEvent } from "react";

export const DELETE_ACCOUNT = "/delete-account";

const RETURN_KEY = "sikemux.returnTo";

/** Lets a sign-in that leaves the page for Google or GitHub come back to where it started. */
export function rememberReturn() {
  sessionStorage.setItem(RETURN_KEY, location.pathname);
}

export function takeReturn(): string {
  const path = sessionStorage.getItem(RETURN_KEY);
  sessionStorage.removeItem(RETURN_KEY);
  return path === DELETE_ACCOUNT ? path : "/";
}

export function usePath() {
  const [path, setPath] = useState(location.pathname);

  useEffect(() => {
    const onPop = () => setPath(location.pathname);
    addEventListener("popstate", onPop);
    return () => removeEventListener("popstate", onPop);
  }, []);

  const go = (to: string, { replace = false } = {}) => {
    if (replace) history.replaceState(null, "", to);
    else history.pushState(null, "", to);
    setPath(to);
    scrollTo(0, 0);
  };

  /** An ordinary link that stays in the page, unless the person asked for a new tab. */
  const follow = (to: string) => (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0)
      return;
    event.preventDefault();
    go(to);
  };

  return { path, go, follow };
}
