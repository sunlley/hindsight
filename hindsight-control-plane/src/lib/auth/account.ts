/**
 * The page's sign-in with the admin account. The account lives on the API, so this asks it: whether a login is
 * required at all, and whether a session cookie is still valid. Edge-safe (plain fetch, no Node APIs), because
 * the middleware calls it on every request; answers are cached for a few seconds so that is not a round trip each.
 */
const DATAPLANE_URL = process.env.HINDSIGHT_CP_DATAPLANE_API_URL || "http://localhost:8888";

const LOGIN_REQUIRED_TTL_MS = 5_000;
const SESSION_TTL_MS = 30_000;
const MAX_CACHED_SESSIONS = 200;

let loginRequired: { value: boolean; at: number } | null = null;
const sessions = new Map<string, number>();

/** Whether the page asks for a username and password. When the API cannot be reached, the last answer stands. */
export async function isLoginRequired(options: { fresh?: boolean } = {}): Promise<boolean> {
  const now = Date.now();
  if (!options.fresh && loginRequired && now - loginRequired.at < LOGIN_REQUIRED_TTL_MS) {
    return loginRequired.value;
  }
  try {
    const response = await fetch(`${DATAPLANE_URL}/v1/default/auth/status`, { cache: "no-store" });
    if (response.ok) {
      const body = (await response.json()) as { login_required?: boolean };
      loginRequired = { value: body.login_required === true, at: now };
    }
  } catch {
    // Unreachable API: keep what we knew. Nothing else works either, so there is nothing to protect.
  }
  return loginRequired?.value ?? false;
}

/** Whether the session token is one the API still accepts. */
export async function isAccountSessionValid(token: string | undefined): Promise<boolean> {
  if (!token) return false;
  const now = Date.now();
  const validUntil = sessions.get(token);
  if (validUntil !== undefined && validUntil > now) return true;
  try {
    const response = await fetch(`${DATAPLANE_URL}/v1/default/auth/session`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    if (!response.ok) {
      sessions.delete(token);
      return false;
    }
  } catch {
    return false;
  }
  if (sessions.size >= MAX_CACHED_SESSIONS) sessions.clear();
  sessions.set(token, now + SESSION_TTL_MS);
  return true;
}

/** Forget what was cached, so a change made here (sign-in on or off) shows on the next request. */
export function resetAccountCache(): void {
  loginRequired = null;
  sessions.clear();
}
