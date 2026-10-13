/*
 * Stands in for the Mac app's store when its chat view runs in a browser. The view reads only
 * which plugins are switched off, and no plugin runs here.
 */
const state = {
  disabledPlugins: [] as string[],
  pluginManifests: [] as unknown[],
};

export function getState() {
  return state;
}

export function useStore<T>(select: (current: typeof state) => T): T {
  return select(state);
}
