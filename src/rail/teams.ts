import type { Agent } from "../state/types";

/** Where a row sits on its lead's team line: the lead heads it, the last worker ends it. */
export type TeamLink = "head" | "member" | "last";

export interface TeamRow {
    agent: Agent;
    link?: TeamLink;
}

/**
 * The rows in the order given, but each agent's workers right after it, in the same order, and theirs after them.
 * A worker whose lead is not among the rows stands on its own.
 */
export function inTeams(agents: readonly Agent[]): TeamRow[] {
    const present = new Set(agents.map((agent) => agent.id));
    const workers = new Map<string, Agent[]>();
    for (const agent of agents) {
        if (!agent.lead || !present.has(agent.lead) || agent.lead === agent.id) continue;
        workers.set(agent.lead, [...(workers.get(agent.lead) ?? []), agent]);
    }
    const placed = new Set<string>();
    const team = (lead: Agent): Agent[] => {
        placed.add(lead.id);
        return [lead, ...(workers.get(lead.id) ?? []).filter((worker) => !placed.has(worker.id)).flatMap(team)];
    };
    const rows: TeamRow[] = [];
    for (const agent of agents) {
        if (placed.has(agent.id) || (agent.lead && present.has(agent.lead) && agent.lead !== agent.id)) continue;
        const members = team(agent);
        members.forEach((member, index) => {
            const link: TeamLink | undefined =
                members.length === 1 ? undefined : index === 0 ? "head" : index === members.length - 1 ? "last" : "member";
            rows.push({ agent: member, link });
        });
    }
    for (const agent of agents) if (!placed.has(agent.id)) rows.push({ agent });
    return rows;
}

const GAP = 3;

/**
 * Lays each team's line through its rows' marks: it runs from the lead's mark down the lead's tree, stops a few
 * pixels short of each worker's mark and goes on below it, and ends at the last worker's. On a selected row it stops at
 * the row's border instead, so it never enters the box.
 */
export function drawTeamLines(root: HTMLElement): void {
    let spineX = 0;
    for (const wrap of root.querySelectorAll<HTMLElement>(".agent-row-wrap.chain-head, .agent-row-wrap.chain")) {
        const box = wrap.getBoundingClientRect();
        if (wrap.classList.contains("chain-head")) {
            const glyph = wrap.querySelector(":scope > .agent-row .agent-glyph")?.getBoundingClientRect();
            const tree = wrap.querySelector(":scope > .agent-tree")?.getBoundingClientRect();
            spineX = tree ? tree.left - box.left : glyph ? glyph.left + glyph.width / 2 - box.left : 0;
        }
        const mark = wrap.querySelector<SVGElement | HTMLElement>(":scope > .agent-row .agent-glyph svg, :scope > .agent-row .agent-glyph img");
        const row = wrap.querySelector<HTMLElement>(":scope > .agent-row");
        if (!mark || !row) continue;
        const drawn = mark.getBoundingClientRect();
        const inset = (mark.tagName.toLowerCase() === "svg" ? (drawn.height * 4) / 32 : 1) - GAP;
        const framed = row.classList.contains("active");
        const edges = row.getBoundingClientRect();
        const top = framed ? edges.top - box.top : drawn.top - box.top + inset;
        const bottom = framed ? edges.bottom - box.top : drawn.bottom - box.top - inset;
        const tree = wrap.querySelector(":scope > .agent-tree")?.getBoundingClientRect();
        const until = tree ? tree.top - box.top + 1 : box.height + 2;
        wrap.style.setProperty("--cx", `${Math.round(spineX)}px`);
        wrap.style.setProperty("--gt", `${Math.round(top)}px`);
        wrap.style.setProperty("--gb", `${Math.round(bottom)}px`);
        wrap.style.setProperty("--down", `${Math.max(0, Math.round(until - bottom))}px`);
    }
}
