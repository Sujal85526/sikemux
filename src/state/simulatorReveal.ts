import { useEffect } from "react";
import { simApi } from "../api/sim";
import * as cmd from "./commands";

/** Shows each device an agent attaches on that agent's desk, so the person watches what it does. */
export function useSimulatorReveal(): void {
    useEffect(() => {
        const controller = new AbortController();
        void simApi
            .subscribeAttached(({ agentId, udid, name }) => {
                const id = cmd.openDeskSimulator(agentId, { focus: false });
                cmd.setDeskSimulatorDevice(agentId, id, { udid, name });
            }, controller.signal)
            .catch(() => {});
        return () => controller.abort();
    }, []);
}
