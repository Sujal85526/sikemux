import { invokeCommand as invoke } from "./invoke";

/** The Sikemux account this Mac is signed in to, which phones on the same account find it through. */
export interface AccountStatus {
    readonly signedIn: boolean;
    readonly userId: string | null;
    readonly email: string | null;
}

export const accountApi = {
    status: () => invoke<AccountStatus>("account_status"),
    /** Opens sign-in in the browser and resolves once this Mac is registered with the account. */
    signIn: () => invoke<AccountStatus>("account_sign_in"),
    cancelSignIn: () => invoke<void>("account_cancel_sign_in"),
    signOut: () => invoke<AccountStatus>("account_sign_out"),
};
