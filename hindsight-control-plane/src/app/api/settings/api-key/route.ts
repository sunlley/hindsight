import { NextResponse } from "next/server";
import { localizeApiErrorPayload } from "@/lib/i18n/api-errors";
import { DATAPLANE_URL, getDataplaneHeaders } from "@/lib/hindsight-client";
import { saveDataplaneApiKey } from "@/lib/dataplane-key";

/**
 * The page's "enter the API key" prompt: the API wants a key this control plane does not have (it was
 * restarted, or someone turned authorization on elsewhere). The key is checked against the API with a call
 * that always needs it, and only a key the API accepts is kept.
 */
export async function POST(request: Request) {
  const { api_key: apiKey } = (await request.json()) as { api_key?: string };
  const error = "Failed to use the API key";
  try {
    if (!apiKey || !apiKey.trim()) {
      return NextResponse.json(
        localizeApiErrorPayload(request, { error, errorKey: "api.errors.apiKey.invalid" }),
        { status: 400 }
      );
    }
    const key = apiKey.trim();
    const check = await fetch(`${DATAPLANE_URL}/v1/default/banks?limit=1`, {
      headers: getDataplaneHeaders(undefined, key),
    });
    if (check.status === 401 || check.status === 403) {
      return NextResponse.json(
        localizeApiErrorPayload(request, { error, errorKey: "api.errors.apiKey.invalid" }),
        { status: 401 }
      );
    }
    if (!check.ok) {
      return NextResponse.json(
        localizeApiErrorPayload(request, { error, errorKey: "api.errors.apiKey.check" }),
        { status: check.status }
      );
    }
    saveDataplaneApiKey(key);
    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (err) {
    console.error("Error checking the API key:", err);
    return NextResponse.json(
      localizeApiErrorPayload(request, { error, errorKey: "api.errors.apiKey.check" }),
      { status: 500 }
    );
  }
}
