import type { AgentType } from "../types";

export const SKIP_PERMISSION_FLAG: Partial<Record<AgentType, string>> = {
    claude: "--dangerously-skip-permissions",
    hermes: "--yolo",
    codex: "--dangerously-bypass-approvals-and-sandbox",
};

export function agentSupportsSkipPermissions(type: AgentType): boolean {
    return SKIP_PERMISSION_FLAG[type] != null;
}
