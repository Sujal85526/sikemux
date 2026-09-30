import { beforeEach, describe, expect, it } from "vitest";
import * as cmd from "../commands";
import { acceptDialog, resetDialogsForTests, useDialogs } from "../dialog";
import { agentIdsOf } from "../selectors";
import { getState, setState } from "../store";

const initial = getState();

beforeEach(() => {
    setState(initial, true);
    resetDialogsForTests();
});

function startAgent(): string {
    cmd.addAgent("claude");
    const st = getState();
    return agentIdsOf(st, st.activeSessionId).at(-1)!;
}

describe("closing what holds agents", () => {
    it("closes an idle agent straight away", () => {
        cmd.createProjectSession("/work/demo");
        const agentId = startAgent();

        cmd.closeActiveFocusTarget();

        expect(getState().agents[agentId]).toBeUndefined();
        expect(useDialogs.getState().dialog).toBeNull();
    });

    it("asks before stopping an agent that is still working", async () => {
        cmd.createProjectSession("/work/demo");
        const agentId = startAgent();
        cmd.noteAgentActivity(agentId, "working");

        cmd.closeActiveFocusTarget();

        const dialog = useDialogs.getState().dialog;
        expect(dialog?.title).toBe("Close claude?");
        expect(getState().agents[agentId]).toBeDefined();
        acceptDialog(dialog!.id);
        await Promise.resolve();
        expect(getState().agents[agentId]).toBeUndefined();
    });

    it("asks before closing a project that has agents in it", () => {
        cmd.createProjectSession("/work/one");
        cmd.createProjectSession("/work/two");
        const agentId = startAgent();
        const sessionId = getState().activeSessionId;

        cmd.closeActiveSession();

        expect(useDialogs.getState().dialog?.title).toBe("Close two?");
        expect(getState().sessions[sessionId]).toBeDefined();
        expect(getState().agents[agentId]).toBeDefined();
    });
});
