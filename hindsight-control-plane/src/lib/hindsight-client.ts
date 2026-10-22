/**
 * Shared Hindsight API client instance for the control plane.
 * Configured to connect to the dataplane API server.
 */

import {
  HindsightClient,
  HindsightError,
  createClient,
  createConfig,
  sdk,
} from "@vectorize-io/hindsight-client";
import { version } from "../../package.json";
import { getDataplaneApiKey } from "./dataplane-key";

export const DATAPLANE_URL = process.env.HINDSIGHT_CP_DATAPLANE_API_URL || "http://localhost:8888";

/** Sent on every dataplane request so the API can tell control-plane traffic apart. */
export const USER_AGENT = `hindsight-control-plane/${version}`;

/**
 * Auth headers for direct fetch calls to the dataplane API.
 */
export function getDataplaneHeaders(
  extra?: Record<string, string>,
  /** Send this key instead of the current one: a change of the API's key is authorised by the old key. */
  apiKey?: string
): Record<string, string> {
  const headers: Record<string, string> = { "User-Agent": USER_AGENT, ...extra };
  const key = apiKey ?? getDataplaneApiKey();
  if (key) {
    headers["Authorization"] = `Bearer ${key}`;
  }
  return headers;
}

/**
 * Build a dataplane URL for a bank-scoped endpoint with the bank id properly encoded.
 * Bank ids may contain `:`, `/`, `%`, etc. (e.g. openclaw `agent::channel::user`),
 * which must be percent-encoded before being interpolated into a URL path.
 */
export function dataplaneBankUrl(bankId: string, suffix = ""): string {
  return `${DATAPLANE_URL}/v1/default/banks/${encodeURIComponent(bankId)}${suffix}`;
}

/**
 * High-level client with convenience methods.
 *
 * The key it sends can change while the server runs (see dataplane-key.ts), and HindsightClient fixes it at
 * construction. So the client is rebuilt when the key changes, and this stands in for whichever is current.
 */
let highLevelClient: { key: string; client: HindsightClient } | null = null;

function currentHindsightClient(): HindsightClient {
  const key = getDataplaneApiKey();
  if (highLevelClient?.key !== key) {
    highLevelClient = {
      key,
      client: new HindsightClient({
        baseUrl: DATAPLANE_URL,
        apiKey: key || undefined,
        userAgent: USER_AGENT,
      }),
    };
  }
  return highLevelClient.client;
}

export const hindsightClient: HindsightClient = new Proxy({} as HindsightClient, {
  get: (_target, property) => {
    const client = currentHindsightClient();
    const value = Reflect.get(client, property, client);
    return typeof value === "function" ? value.bind(client) : value;
  },
});

/**
 * Low-level client for direct SDK access
 */
export const lowLevelClient = createClient(
  createConfig({
    baseUrl: DATAPLANE_URL,
    headers: { "User-Agent": USER_AGENT },
  })
);

// The key is looked up per request, not fixed here, so a key saved from the Settings page applies at once.
lowLevelClient.interceptors.request.use((request) => {
  const key = getDataplaneApiKey();
  if (key) {
    request.headers.set("Authorization", `Bearer ${key}`);
  } else {
    request.headers.delete("Authorization");
  }
  return request;
});

/**
 * Export SDK functions for direct API access
 */
export { sdk };

/**
 * Export HindsightError for error handling
 */
export { HindsightError };
