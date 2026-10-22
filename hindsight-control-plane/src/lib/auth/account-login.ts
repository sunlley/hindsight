import type { NextRequest, NextResponse } from "next/server";

import { DATAPLANE_URL } from "@/lib/hindsight-client";
import { saveDataplaneApiKey } from "@/lib/dataplane-key";
import { ACCOUNT_SESSION_COOKIE, sessionCookieOptions } from "@/lib/auth/session";
import { resetAccountCache } from "@/lib/auth/account";

interface Session {
  session_token: string;
  expires_at: string;
  api_key: string | null;
}

export type SignInResult = { ok: true; session: Session } | { ok: false; status: number };

/** The browser's address, for the API's failed-sign-in throttle: every sign-in reaches the API from this server. */
export function browserAddress(request: Request): string {
  return (request.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "unknown";
}

/**
 * Ask the API to check the admin account's credentials. Public on the API side, so no key is sent. The
 * browser's address goes along so that the API throttles failures per browser: counted on this server's
 * address alone, a few wrong passwords from anyone would lock the admin out too.
 */
export async function signInWithAccount(
  username: string,
  password: string,
  clientAddress: string
): Promise<SignInResult> {
  const response = await fetch(`${DATAPLANE_URL}/v1/default/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Forwarded-For": clientAddress },
    body: JSON.stringify({ username, password }),
    cache: "no-store",
  });
  if (!response.ok) return { ok: false, status: response.status };
  return { ok: true, session: (await response.json()) as Session };
}

/**
 * Start the browser's session, and take the API key the API hands over with it. Nobody types the key: a
 * signed-in user is who it is for, and after a control plane restart, signing in again brings it back.
 */
export function startSession(response: NextResponse, request: NextRequest, session: Session): void {
  response.cookies.set({
    name: ACCOUNT_SESSION_COOKIE,
    value: session.session_token,
    ...sessionCookieOptions(request),
    expires: new Date(session.expires_at),
  });
  saveDataplaneApiKey(session.api_key);
  resetAccountCache();
}

export function endSession(response: NextResponse, request: NextRequest): void {
  response.cookies.set({
    name: ACCOUNT_SESSION_COOKIE,
    value: "",
    ...sessionCookieOptions(request),
    maxAge: 0,
  });
  resetAccountCache();
}
