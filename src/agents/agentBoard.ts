/** A card's place on the board, as the core keeps it. "Needs you" is not one: it is an owner waiting on the person. */
export type CardStatus = "open" | "progress" | "done";

/** The Jira or Linear ticket the person put a card on the board for. */
export interface CardTicket {
    readonly key: string;
    readonly url?: string;
    /** What it is in its tracker, such as Epic, Story or Bug. */
    readonly source?: string;
    readonly provider: "jira" | "linear";
    /** Why the last change on the card did not reach the ticket. */
    readonly syncNote?: string;
}

/** Where a card Auto runs is: "review" and "held" wait on the person. */
export type RunStage = "starting" | "working" | "shipping" | "checking" | "fixing" | "merging" | "review" | "held" | "merged" | "closed";

/** The run Auto gave a card: its own agent, worktree and branch, and the pull request that lands it. */
export interface CardRun {
    readonly agent: string;
    /** The main checkout, which git commands about the worktree run against. */
    readonly repo: string;
    readonly worktree: string;
    readonly branch: string;
    readonly base: string;
    readonly startSha: string;
    readonly stage: RunStage;
    /** What is happening, or why the card is back with the person. */
    readonly note: string | null;
    readonly pull: { readonly number: number; readonly url: string; readonly host: string } | null;
}

/** How a project's board runs on its own. */
export interface BoardSettings {
    readonly auto: boolean;
    /** How many of Auto's agents work at once. */
    readonly slots: number;
    /** The app's launcher Auto's agents start with; null for the first that works. */
    readonly launcher: string | null;
    readonly model: string | null;
    /** Merge once checks pass, or stop at the opened pull request. */
    readonly finish: "merge" | "pr";
    /** What proves a change sound when no CI runs on its pull request. */
    readonly check: string | null;
    /** The ticket statuses a card's ticket moves to when it is taken and done. */
    readonly statuses: { readonly progress: string; readonly done: string };
}

export type SettingsChanges = Partial<Omit<BoardSettings, "statuses">> & { readonly statuses?: Partial<BoardSettings["statuses"]> };

/** What the core says of a project's Auto beside its cards. */
export interface BoardAuto {
    readonly settings: BoardSettings;
    /** How many of Auto's agents are at work now and not waiting on the person. */
    readonly running: number;
    /** Why Auto cannot start anything now. */
    readonly autoNote: string | null;
}

export const RUN_WAITS_ON_PERSON: ReadonlySet<RunStage> = new Set(["review", "held"]);

export interface BoardCard {
    readonly id: number;
    readonly title: string;
    readonly details: string;
    readonly status: CardStatus;
    /** The agent working it, or that did, by id. */
    readonly owner: string | null;
    readonly ownerName: string | null;
    readonly ownerCli: string | null;
    /** The agent at the top of the team the card belongs to, none for a card only the person has touched. */
    readonly team: string | null;
    readonly teamName: string | null;
    readonly parent: number | null;
    readonly dependsOn: number[];
    /** The cards it waits on that are not done yet. */
    readonly waitsOn: number[];
    /** The agent that added it, none when the person did. */
    readonly createdBy: string | null;
    readonly createdByName: string;
    readonly result: string | null;
    readonly ticket: CardTicket | null;
    readonly auto: CardRun | null;
    readonly at: number;
    readonly updatedAt: number;
}

export interface ProjectBoard extends BoardAuto {
    /** The project's folder as the core names it. */
    readonly project: string;
    readonly cards: BoardCard[];
}

/** The card whose Auto run `agentId` is, on any board. */
export function runOfAgent(boards: Readonly<Record<string, readonly BoardCard[]>>, agentId: string): { project: string; card: BoardCard } | null {
    for (const [project, cards] of Object.entries(boards)) {
        const card = cards.find((each) => each.auto?.agent === agentId);
        if (card) return { project, card };
    }
    return null;
}

/** What the person may change on a card. A parent of 0 takes the card out from under one. */
export interface CardChanges {
    readonly title?: string;
    readonly details?: string;
    readonly status?: CardStatus;
    readonly dependsOn?: number[];
    readonly parent?: number;
}

export interface NewCard {
    readonly title: string;
    readonly details?: string;
    readonly parent?: number;
    readonly dependsOn?: number[];
    readonly ticket?: CardTicket;
}
