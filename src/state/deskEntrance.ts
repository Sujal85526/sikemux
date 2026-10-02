/* Only a desk someone just opened animates in. One restored with the window draws in place. */
const entering = new Set<string>();

export const DESK_OPEN_MS = 600;

export function expectDeskEntrance(paneId: string): void {
    entering.add(paneId);
}

export function takeDeskEntrance(paneId: string): boolean {
    return entering.delete(paneId);
}
