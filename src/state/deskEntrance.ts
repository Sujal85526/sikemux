/* Only a desk someone just opened slides in. One restored with the window draws in place. */
const entering = new Set<string>();

export function expectDeskEntrance(paneId: string): void {
    entering.add(paneId);
}

export function takeDeskEntrance(paneId: string): boolean {
    return entering.delete(paneId);
}
