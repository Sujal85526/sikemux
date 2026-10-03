import { invokeCommand as invoke } from "./invoke";
import { getIpcTransport } from "./transport";

/** The Sikemux account this host is signed in to, which devices on the same account find it through. */
export interface AccountStatus {
    readonly signedIn: boolean;
    readonly userId: string | null;
    readonly email: string | null;
    readonly name: string | null;
    /** The account's picture as a `data:` URL, cached on disk so it shows offline. */
    readonly picture: string | null;
}

/** Sent when the account changes without the app asking, such as this host being removed from it elsewhere. */
export const ACCOUNT_CHANGED_EVENT = "account_changed";

export const accountApi = {
    /** What this host knows without asking the network. */
    status: () => invoke<AccountStatus>("account_status"),
    /** Fetches the name and picture again once the cached ones are a few hours old. */
    refreshProfile: () => invoke<AccountStatus>("account_refresh_profile"),
    /** Opens sign-in in the browser and resolves once this host is registered with the account. */
    signIn: () => invoke<AccountStatus>("account_sign_in"),
    cancelSignIn: () => invoke<void>("account_cancel_sign_in"),
    /** Takes this host off the account; devices already paired stay paired. */
    signOut: () => invoke<AccountStatus>("account_sign_out"),
    subscribe: (listener: (status: AccountStatus) => void, signal: AbortSignal) =>
        getIpcTransport().subscribe<AccountStatus>(ACCOUNT_CHANGED_EVENT, (event) => listener(event.payload), { signal }),
};
