import { agentApi, type AgentAccountBook } from "../api/agents";
import { getState, useStore, type StoreState } from "../state/store";
import { swallow } from "../state/toast";

/** How often a core that could not be asked at start is asked again. */
const RETRY_MS = 5_000;

function bookOf(state: StoreState): AgentAccountBook {
    return { profiles: state.providerProfiles, selected: state.selectedProviderProfileIds };
}

/** Sends the person's agent accounts to the core whenever they change here, and at once when `upload`. */
function follow(upload: boolean): () => void {
    let sent = upload ? "" : JSON.stringify(bookOf(getState()));
    const send = (state: StoreState) => {
        const book = bookOf(state);
        const json = JSON.stringify(book);
        if (json === sent) return;
        sent = json;
        agentApi.setAccounts(book).catch(swallow("save agent accounts in the core"));
    };
    send(getState());
    return useStore.subscribe((state, previous) => {
        if (state.providerProfiles !== previous.providerProfiles || state.selectedProviderProfileIds !== previous.selectedProviderProfileIds)
            send(state);
    });
}

/**
 * Keeps the core's copy of the person's agent accounts in step with the app's. `known` is what the core said at start:
 * `null` while it has none, which the app's accounts then become, or `undefined` when it could not be asked, so it is
 * asked again until it answers.
 */
export function syncAgentAccounts(known: AgentAccountBook | null | undefined): () => void {
    if (known !== undefined) return follow(known === null);
    let stop = () => {};
    const retry = window.setInterval(() => {
        agentApi.accounts().then(
            (book) => {
                window.clearInterval(retry);
                stop = follow(book === null);
            },
            () => {},
        );
    }, RETRY_MS);
    return () => {
        window.clearInterval(retry);
        stop();
    };
}
