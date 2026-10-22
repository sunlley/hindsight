/**
 * The API key the control plane sends to the Hindsight API.
 *
 * It starts as `HINDSIGHT_CP_DATAPLANE_API_KEY` (if set) and is held in memory, never on disk: everything about
 * API authorization is done from the page. Turning authorization on from Settings, or typing the key into the
 * page's prompt after a restart, replaces it here. Kept on `globalThis` because Next.js may load this module
 * once per route bundle, and every route has to see the same key.
 */
interface KeyHolder {
  key: string | null;
}

const holder = ((globalThis as { __hindsightDataplaneKey?: KeyHolder }).__hindsightDataplaneKey ??=
  {
    key: null,
  });

/** The key set from the page, if any (not the environment's). */
export function getSavedDataplaneApiKey(): string | null {
  return holder.key;
}

export function getDataplaneApiKey(): string {
  return holder.key ?? (process.env.HINDSIGHT_CP_DATAPLANE_API_KEY || "");
}

/** Remember the key the API now requires (`null`: it requires none, so fall back to the environment). */
export function saveDataplaneApiKey(key: string | null): void {
  holder.key = key;
}
