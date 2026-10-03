const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export type RunningUpdate = { id: string | null; createdAt: Date | null; embedded: boolean };

/** The installed version, then the over-the-air update running on top of it, if any: `0.1.0 · update a1b2c3d (3 Oct)`. */
export function versionLabel(version: string | null, update: RunningUpdate): string {
  const installed = version ?? 'Unknown version';
  if (update.embedded || !update.id) return installed;
  const short = update.id.replace(/-/g, '').slice(0, 7).toLowerCase();
  const date = update.createdAt ? ` (${update.createdAt.getDate()} ${MONTHS[update.createdAt.getMonth()]})` : '';
  return `${installed} · update ${short}${date}`;
}
