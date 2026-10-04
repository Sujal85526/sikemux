import { create } from "zustand";
import { onPaneClosed, openSurface } from "../../plugin-api/host";
import { DATABASE_BROWSER } from "./kinds";

export interface DatabaseView {
    /** The saved connection shown beside the list. */
    selected: string | null;
    /** Whether the form is open, for a new connection or for the selected one. */
    editing: "new" | "selected" | null;
}

const FIRST_VIEW: DatabaseView = { selected: null, editing: null };

const useViews = create<{ views: Record<string, DatabaseView> }>(() => ({ views: {} }));

onPaneClosed((paneId) =>
    useViews.setState((state) => {
        const views = { ...state.views };
        delete views[paneId];
        return { views };
    }),
);

export const useDatabaseView = (paneId: string): DatabaseView => useViews((state) => state.views[paneId] ?? FIRST_VIEW);

export function updateDatabaseView(paneId: string, change: Partial<DatabaseView>): void {
    useViews.setState((state) => ({ views: { ...state.views, [paneId]: { ...(state.views[paneId] ?? FIRST_VIEW), ...change } } }));
}

export const openDatabase = (): string | null => openSurface(DATABASE_BROWSER);
