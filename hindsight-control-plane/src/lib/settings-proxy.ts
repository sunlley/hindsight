import { NextResponse } from "next/server";
import { localizeApiErrorPayload } from "@/lib/i18n/api-errors";
import { DATAPLANE_URL, getDataplaneHeaders } from "@/lib/hindsight-client";

const REFUSAL_STATUSES = ["auth_failed", "unreachable", "timeout"];

/** A save the server refused (409) says why the model could not be reached; pick the matching message. */
function refusalKey(status: number, body: string): string | null {
  if (status !== 409) return null;
  try {
    const reason = JSON.parse(body)?.detail?.status;
    return REFUSAL_STATUSES.includes(reason) ? `api.errors.settings.rejected_${reason}` : null;
  } catch {
    return null;
  }
}

/** Forward a global-settings request to the dataplane, mapping failures to a localized error. */
export async function proxySettings(
  request: Request,
  method: "GET" | "PUT" | "POST",
  path: string,
  errorKey: string,
  error: string
) {
  try {
    const hasBody = method !== "GET";
    const response = await fetch(`${DATAPLANE_URL}/v1/default/settings${path}`, {
      method,
      headers: getDataplaneHeaders(hasBody ? { "Content-Type": "application/json" } : undefined),
      body: hasBody ? JSON.stringify(await request.json()) : undefined,
    });

    if (!response.ok) {
      const body = await response.text();
      console.error(`API error ${method} global settings${path}:`, body);
      return NextResponse.json(
        localizeApiErrorPayload(request, {
          error,
          errorKey: refusalKey(response.status, body) ?? errorKey,
        }),
        { status: response.status }
      );
    }

    return NextResponse.json(await response.json(), { status: 200 });
  } catch (err) {
    console.error(`Error ${method} global settings${path}:`, err);
    return NextResponse.json(localizeApiErrorPayload(request, { error, errorKey }), {
      status: 500,
    });
  }
}
