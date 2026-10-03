import { useEffect, useState } from "react";
import * as cmd from "../state/commands";
import { swallow } from "../state/toast";
import { IconUser } from "../ui/Icons";
import { Tooltip } from "../ui/Tooltip";
import { initials, loadAccount, useAccount } from "./account";

export function AccountButton() {
    const account = useAccount((s) => s.account);
    const [brokenPicture, setBrokenPicture] = useState<string | null>(null);

    useEffect(() => {
        loadAccount().catch(swallow("account"));
    }, []);

    const signedIn = account?.signedIn ?? false;
    const label = signedIn ? (account?.email ?? account?.name ?? "Signed in") : "Not signed in";
    const picture = signedIn && account?.picture !== brokenPicture ? account?.picture : null;
    const letters = signedIn ? initials(account?.name ?? null, account?.email ?? null) : "";

    return (
        <Tooltip label={label}>
            <button
                className="tb-account"
                type="button"
                aria-label={signedIn ? `Account: ${label}` : "Account: not signed in"}
                onClick={() => cmd.openSettings("devices", "Your account")}>
                {picture ? (
                    <img className="tb-account-face" src={picture} alt="" draggable={false} onError={() => setBrokenPicture(picture)} />
                ) : letters ? (
                    <span className="tb-account-face tb-account-initials" aria-hidden>
                        {letters}
                    </span>
                ) : (
                    <IconUser size={15} />
                )}
            </button>
        </Tooltip>
    );
}
