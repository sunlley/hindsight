import { NextRequest, NextResponse } from "next/server";
import { localizeApiErrorPayload } from "@/lib/i18n/api-errors";
import { isLoginRequired } from "@/lib/auth/account";
import { browserAddress, signInWithAccount, startSession } from "@/lib/auth/account-login";

import {
  ACCESS_KEY_COOKIE,
  SESSION_MAX_AGE_SECONDS,
  createSessionToken,
  sessionCookieOptions,
} from "@/lib/auth/session";

/** Sign in with the admin account set up on the Settings page; the API checks it. */
async function accountLogin(request: NextRequest) {
  const { username, password } = (await request.json().catch(() => ({}))) as {
    username?: string;
    password?: string;
  };
  const failure = (status: number, error: string, errorKey: string) =>
    NextResponse.json(localizeApiErrorPayload(request, { error, errorKey }), { status });

  if (!username || !password) {
    return failure(401, "Wrong username or password", "api.errors.auth.invalidCredentials");
  }
  try {
    const result = await signInWithAccount(username, password, browserAddress(request));
    if (!result.ok) {
      return result.status === 429
        ? failure(429, "Too many attempts", "api.errors.auth.tooManyAttempts")
        : failure(401, "Wrong username or password", "api.errors.auth.invalidCredentials");
    }
    const response = NextResponse.json({ success: true });
    startSession(response, request, result.session);
    return response;
  } catch (err) {
    console.error("Error signing in:", err);
    return failure(502, "Could not reach the API", "api.errors.auth.apiUnreachable");
  }
}

export async function POST(request: NextRequest) {
  // The admin account, once set up on the Settings page, replaces the access key from the environment.
  if (await isLoginRequired({ fresh: true })) {
    return accountLogin(request);
  }

  const accessKey = process.env.HINDSIGHT_CP_ACCESS_KEY;

  // If no access key is configured, return 503
  if (!accessKey) {
    return NextResponse.json(
      localizeApiErrorPayload(request, {
        error: "Access key not configured",
        errorKey: "api.errors.auth.accessKeyNotConfigured",
      }),
      { status: 503 }
    );
  }

  let body: { key?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      localizeApiErrorPayload(request, {
        error: "Invalid request body",
        errorKey: "api.errors.auth.invalidRequestBody",
      }),
      { status: 400 }
    );
  }

  const providedKey = body.key;

  // Constant-time comparison to prevent timing attacks
  const isValid = providedKey && constantTimeCompare(providedKey, accessKey);

  if (!isValid) {
    return NextResponse.json(
      localizeApiErrorPayload(request, {
        error: "Invalid access key",
        errorKey: "api.errors.auth.invalidAccessKey",
      }),
      { status: 401 }
    );
  }

  const response = NextResponse.json({ success: true });

  response.cookies.set({
    name: ACCESS_KEY_COOKIE,
    value: await createSessionToken(accessKey),
    ...sessionCookieOptions(request),
    maxAge: SESSION_MAX_AGE_SECONDS,
  });

  return response;
}

/**
 * Constant-time string comparison to prevent timing attacks.
 */
function constantTimeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }

  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }

  return result === 0;
}
