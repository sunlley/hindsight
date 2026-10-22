import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { middleware } from "@/middleware";
import { isAccountSessionValid, isLoginRequired } from "@/lib/auth/account";
import { ACCESS_KEY_COOKIE, ACCOUNT_SESSION_COOKIE, createSessionToken } from "@/lib/auth/session";

// The real i18n middleware can't load under vitest; locale rewriting isn't what's tested.
vi.mock("next-intl/middleware", () => ({ default: () => () => NextResponse.next() }));

// Whether the admin account's login is on, and whether a session is valid, are the API's to say.
vi.mock("@/lib/auth/account", () => ({
  isLoginRequired: vi.fn(async () => false),
  isAccountSessionValid: vi.fn(async () => false),
}));

const KEY = "test-access-key";

async function request(path: string, withSession: boolean) {
  const req = new NextRequest(new URL(path, "http://localhost:9999"));
  if (withSession) req.cookies.set(ACCESS_KEY_COOKIE, await createSessionToken(KEY));
  return middleware(req);
}

describe("middleware session handling", () => {
  beforeEach(() => vi.stubEnv("HINDSIGHT_CP_ACCESS_KEY", KEY));
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.mocked(isLoginRequired).mockResolvedValue(false);
    vi.mocked(isAccountSessionValid).mockResolvedValue(false);
  });

  it("marks its own 401 so the browser knows to log in again", async () => {
    const res = await request("/api/banks", false);
    expect(res.status).toBe(401);
    expect(res.headers.get("x-hindsight-session-required")).toBe("1");
  });

  it("sends a signed-in visit to /login on to its returnTo", async () => {
    const res = await request("/login?returnTo=%2Fbanks%2Fa", true);
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("http://localhost:9999/banks/a");
  });

  it("never follows an off-site returnTo", async () => {
    const res = await request("/login?returnTo=%2F%2Fevil.com", true);
    expect(res.headers.get("location")).toBe("http://localhost:9999/dashboard");
  });

  it("still shows the login form without a valid session", async () => {
    const res = await request("/login", false);
    expect(res.headers.get("location")).toBeNull();
  });
});

describe("middleware with the admin account's login on", () => {
  // The account replaces the access key from the environment, which is still set here on purpose.
  beforeEach(() => {
    vi.stubEnv("HINDSIGHT_CP_ACCESS_KEY", KEY);
    vi.mocked(isLoginRequired).mockResolvedValue(true);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.mocked(isLoginRequired).mockResolvedValue(false);
    vi.mocked(isAccountSessionValid).mockResolvedValue(false);
  });

  async function visit(path: string, token?: string) {
    const req = new NextRequest(new URL(path, "http://localhost:9999"));
    if (token) req.cookies.set(ACCOUNT_SESSION_COOKIE, token);
    return middleware(req);
  }

  it("refuses an API call without a valid session, marked so the browser goes to the login form", async () => {
    const res = await visit("/api/banks");
    expect(res.status).toBe(401);
    expect(res.headers.get("x-hindsight-session-required")).toBe("1");
  });

  it("does not take the access key's cookie for a signed-in account", async () => {
    const req = new NextRequest(new URL("/api/banks", "http://localhost:9999"));
    req.cookies.set(ACCESS_KEY_COOKIE, await createSessionToken(KEY));
    expect((await middleware(req)).status).toBe(401);
  });

  it("lets a session the API accepts through, and passes that token to the API to check", async () => {
    vi.mocked(isAccountSessionValid).mockResolvedValue(true);
    const res = await visit("/api/banks", "good-token");
    expect(res.status).toBe(200);
    expect(isAccountSessionValid).toHaveBeenCalledWith("good-token");
  });

  it("sends a page visit without a session to the login form, remembering where it was going", async () => {
    const res = await visit("/banks/a");
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("http://localhost:9999/login?returnTo=%2Fbanks%2Fa");
  });

  it("keeps the login form and its API reachable without a session", async () => {
    expect((await visit("/login")).headers.get("location")).toBeNull();
    expect((await visit("/api/auth/login")).status).toBe(200);
    expect((await visit("/api/auth/mode")).status).toBe(200);
  });

  it("sends a signed-in visit to /login on to its returnTo", async () => {
    vi.mocked(isAccountSessionValid).mockResolvedValue(true);
    const res = await visit("/login?returnTo=%2Fbanks%2Fa", "good-token");
    expect(res.headers.get("location")).toBe("http://localhost:9999/banks/a");
  });
});

describe("middleware with no login of any kind", () => {
  it("leaves pages and API calls open", async () => {
    vi.unstubAllEnvs();
    vi.stubEnv("HINDSIGHT_CP_ACCESS_KEY", "");
    const page = await middleware(new NextRequest(new URL("/banks/a", "http://localhost:9999")));
    const api = await middleware(new NextRequest(new URL("/api/banks", "http://localhost:9999")));
    expect(page.headers.get("location")).toBeNull();
    expect(api.status).toBe(200);
    vi.unstubAllEnvs();
  });
});
