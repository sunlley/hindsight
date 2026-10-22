import { NextRequest, NextResponse } from "next/server";
import { localizeApiErrorPayload } from "@/lib/i18n/api-errors";
import { DATAPLANE_URL, getDataplaneHeaders } from "@/lib/hindsight-client";
import {
  browserAddress,
  endSession,
  signInWithAccount,
  startSession,
} from "@/lib/auth/account-login";
import { resetAccountCache } from "@/lib/auth/account";

const ADMIN_URL = `${DATAPLANE_URL}/v1/default/settings/auth/admin`;

function failure(request: Request, status: number, errorKey: string, error: string) {
  return NextResponse.json(localizeApiErrorPayload(request, { error, errorKey }), { status });
}

/**
 * Set (or replace) the account the page signs in with. Whoever sets it is signed in at once: otherwise the
 * next click would send them to a login form for an account they just made.
 */
export async function PUT(request: NextRequest) {
  const { username, password } = (await request.json()) as { username: string; password: string };
  const error = "Failed to save the page login";
  try {
    const saved = await fetch(ADMIN_URL, {
      method: "PUT",
      headers: getDataplaneHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ username, password }),
    });
    if (!saved.ok) {
      console.error("API error saving the page login:", await saved.text());
      return failure(request, saved.status, "api.errors.settings.pageLogin", error);
    }
    const state = await saved.json();
    resetAccountCache();

    const result = await signInWithAccount(username, password, browserAddress(request));
    const response = NextResponse.json(state, { status: 200 });
    if (result.ok) startSession(response, request, result.session);
    return response;
  } catch (err) {
    console.error("Error saving the page login:", err);
    return failure(request, 500, "api.errors.settings.pageLogin", error);
  }
}

export async function DELETE(request: NextRequest) {
  const error = "Failed to turn off the page login";
  try {
    const removed = await fetch(ADMIN_URL, { method: "DELETE", headers: getDataplaneHeaders() });
    if (!removed.ok) {
      console.error("API error removing the page login:", await removed.text());
      return failure(request, removed.status, "api.errors.settings.pageLoginOff", error);
    }
    const response = NextResponse.json(await removed.json(), { status: 200 });
    endSession(response, request);
    return response;
  } catch (err) {
    console.error("Error removing the page login:", err);
    return failure(request, 500, "api.errors.settings.pageLoginOff", error);
  }
}
