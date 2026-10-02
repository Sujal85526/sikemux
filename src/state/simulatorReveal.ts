import { useEffect } from "react";
import { simulatorApi } from "../api/simulator";
import * as cmd from "./commands";

/** Puts each simulator an agent attaches on that agent's desk, live. */
export function useSimulatorReveal(): void {
    useEffect(() => {
        const controller = new AbortController();
        void simulatorApi
            .subscribeAttached(({ agentId, ...simulator }) => cmd.openDeskSimulator(agentId, simulator), controller.signal)
            .catch(() => {});
        return () => controller.abort();
    }, []);
}
