/** A card's place on the board, as the core keeps it. "Needs you" is not one: it is an owner waiting on the person. */
export type CardStatus = "open" | "progress" | "done";

/** The Jira or Linear ticket the person put a card on the board for. */
export interface CardTicket {
    readonly key: string;
    readonly url?: string;
    /** What it is in its tracker, such as Epic, Story or Bug. */
    readonly source?: string;
    readonly provider: "jira" | "linear";
}

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
    readonly at: number;
    readonly updatedAt: number;
}

export interface ProjectBoard {
    /** The project's folder as the core names it. */
    readonly project: string;
    readonly cards: BoardCard[];
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
