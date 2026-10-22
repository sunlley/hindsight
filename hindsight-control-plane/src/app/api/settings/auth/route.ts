import { NextResponse } from "next/server";
import { localizeApiErrorPayload } from "@/lib/i18n/api-errors";
import { DATAPLANE_URL, getDataplaneHeaders } from "@/lib/hindsight-client";
import {
  getDataplaneApiKey,
  getSavedDataplaneApiKey,
  saveDataplaneApiKey,
} from "@/lib/dataplane-key";
import { proxySettings } from "@/lib/settings-proxy";

const AUTH_URL = `${DATAPLANE_URL}/v1/default/settings/auth`;

interface AuthState {
  enabled: boolean;
  api_key_hint: string | null;
  managed_by_extension: boolean;
}

interface AuthUpdate {
  enabled: boolean;
  api_key?: string | null;
}

/** One call to the API's auth settings, sending `apiKey` rather than whichever key is current. */
function callAuth(method: "GET" | "PUT", apiKey: string, body?: AuthUpdate) {
  return fetch(AUTH_URL, {
    method,
    headers: getDataplaneHeaders(body ? { "Content-Type": "application/json" } : undefined, apiKey),
    body: body ? JSON.stringify(body) : undefined,
  });
}

function failure(request: Request, status: number, errorKey: string, error: string) {
  return NextResponse.json(localizeApiErrorPayload(request, { error, errorKey }), { status });
}

function refusalKey(status: number): string {
  switch (status) {
    case 401:
      return "api.errors.settings.authUnauthorized";
    case 409:
      return "api.errors.settings.authManaged";
    case 422:
      return "api.errors.settings.authKeyRequired";
    default:
      return "api.errors.settings.auth";
  }
}

export async function GET(request: Request) {
  return proxySettings(
    request,
    "GET",
    "/auth",
    "api.errors.settings.auth",
    "Failed to get settings"
  );
}

/**
 * Turning API authorization on (or changing its key) would lock this control plane out of the API it is
 * talking to, so the change is made in three steps: the API takes the new key (authorised by the old one),
 * the control plane starts sending it, and a request with it proves both still work. If that request fails,
 * the API is put back the way it was. The control plane keeps the key in memory only (see dataplane-key.ts).
 */
export async function PUT(request: Request) {
  const update = (await request.json()) as AuthUpdate;
  const error = "Failed to save API authorization";
  const previousKey = getDataplaneApiKey();
  const previousSaved = getSavedDataplaneApiKey();
  try {
    const before = await callAuth("GET", previousKey);
    if (!before.ok) {
      return failure(request, before.status, refusalKey(before.status), error);
    }
    const was = (await before.json()) as AuthState;

    const applied = await callAuth("PUT", previousKey, update);
    if (!applied.ok) {
      console.error("API error saving API authorization:", await applied.text());
      return failure(request, applied.status, refusalKey(applied.status), error);
    }
    const state = (await applied.json()) as AuthState;

    // From here on the API wants the new key (or none); the control plane has to send the same.
    const newKey = update.enabled ? (update.api_key ?? previousKey) : "";
    saveDataplaneApiKey(update.enabled ? newKey : null);

    const accepted = (await callAuth("GET", getDataplaneApiKey())).ok;
    if (!accepted) {
      console.error("Control plane not accepted by the API after saving authorization; reverting");
      await callAuth(
        "PUT",
        newKey,
        was.enabled ? { enabled: true, api_key: previousKey } : { enabled: false }
      );
      saveDataplaneApiKey(previousSaved);
      return failure(request, 502, "api.errors.settings.authRejected", error);
    }
    return NextResponse.json(state, { status: 200 });
  } catch (err) {
    console.error("Error saving API authorization:", err);
    return failure(request, 500, "api.errors.settings.auth", error);
  }
}
