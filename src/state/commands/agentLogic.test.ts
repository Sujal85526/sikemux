import { describe, expect, it } from "vitest";
import { SKIP_PERMISSION_FLAG, agentSupportsSkipPermissions } from "./agentLogic";
import type { AgentType } from "../types";

describe("agent command logic", () => {
    it("documents which agents support YOLO/skip-permission mode", () => {
        expect(SKIP_PERMISSION_FLAG).toMatchObject({
            claude: "--dangerously-skip-permissions",
            hermes: "--yolo",
            codex: "--dangerously-bypass-approvals-and-sandbox",
            omp: "--approval-mode yolo",
            grok: "--permission-mode bypassPermissions",
        });
        const supported: AgentType[] = ["claude", "hermes", "codex", "omp", "grok"];
        const unsupported: AgentType[] = ["pi", "opencode"];
        for (const type of supported) expect(agentSupportsSkipPermissions(type)).toBe(true);
        for (const type of unsupported) expect(agentSupportsSkipPermissions(type)).toBe(false);
    });
});
