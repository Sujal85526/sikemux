/** An agent that just changed lines another agent had uncommitted, or a file another holds a claim on, as the core marks it. */
export interface CollisionMark {
    /** The agents it collided with, by name; empty when the change came from outside the agents' edits. */
    with: string[];
    /** The file, from the project's folder. */
    path: string;
    /** A lockfile, migration or generated file two agents edited, rather than the same lines. */
    claim: boolean;
    at: number;
}

function joined(names: readonly string[]): string {
    if (names.length < 2) return names[0] ?? "";
    return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** What a collision mark says, for its tooltip and screen readers. */
export function collisionLabel(mark: CollisionMark): string {
    const others = joined(mark.with);
    if (mark.claim) return `Edited ${mark.path} together with ${others}; one agent at a time should change it`;
    if (!others) return `Its uncommitted lines in ${mark.path} were changed outside its edits`;
    return `Changed the same lines as ${others} in ${mark.path}`;
}
