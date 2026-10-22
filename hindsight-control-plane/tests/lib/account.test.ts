import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** account.ts keeps its answers at module level, so every test gets a fresh copy of it. */
async function freshAccount() {
  vi.resetModules();
  return import("@/lib/auth/account");
}

function respond(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

describe("page login state", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("asks the API whether a login is required, and reuses the answer for a few seconds", async () => {
    const { isLoginRequired } = await freshAccount();
    fetchSpy.mockResolvedValue(respond({ login_required: true }));

    expect(await isLoginRequired()).toBe(true);
    expect(await isLoginRequired()).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("asks again when told the answer must be fresh", async () => {
    const { isLoginRequired } = await freshAccount();
    fetchSpy.mockResolvedValueOnce(respond({ login_required: false }));
    fetchSpy.mockResolvedValueOnce(respond({ login_required: true }));

    expect(await isLoginRequired()).toBe(false);
    expect(await isLoginRequired({ fresh: true })).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("keeps the last answer when the API cannot be reached, and assumes open before it ever answered", async () => {
    const { isLoginRequired } = await freshAccount();
    fetchSpy.mockRejectedValue(new Error("connection refused"));
    expect(await isLoginRequired({ fresh: true })).toBe(false);

    fetchSpy.mockResolvedValueOnce(respond({ login_required: true }));
    expect(await isLoginRequired({ fresh: true })).toBe(true);
    fetchSpy.mockRejectedValue(new Error("connection refused"));
    expect(await isLoginRequired({ fresh: true })).toBe(true);
  });

  it("accepts a session token the API accepts, and sends it as a Bearer token", async () => {
    const { isAccountSessionValid } = await freshAccount();
    fetchSpy.mockResolvedValue(respond({ username: "admin" }));

    expect(await isAccountSessionValid("token-1")).toBe(true);
    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer token-1");
  });

  it("does not ask the API again for a token it just accepted", async () => {
    const { isAccountSessionValid } = await freshAccount();
    fetchSpy.mockResolvedValue(respond({ username: "admin" }));

    await isAccountSessionValid("token-1");
    await isAccountSessionValid("token-1");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("refuses a missing token without asking, and a token the API refuses", async () => {
    const { isAccountSessionValid } = await freshAccount();
    expect(await isAccountSessionValid(undefined)).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();

    fetchSpy.mockResolvedValue(respond({ detail: "No valid session." }, 401));
    expect(await isAccountSessionValid("forged")).toBe(false);
    // A refusal is not remembered: the next request asks again.
    expect(await isAccountSessionValid("forged")).toBe(false);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("refuses a token when the API cannot be reached", async () => {
    const { isAccountSessionValid } = await freshAccount();
    fetchSpy.mockRejectedValue(new Error("connection refused"));
    expect(await isAccountSessionValid("token-1")).toBe(false);
  });

  it("forgets what it cached when told to, so a change shows on the next request", async () => {
    const { isAccountSessionValid, isLoginRequired, resetAccountCache } = await freshAccount();
    fetchSpy.mockResolvedValue(respond({ login_required: false, username: "admin" }));
    await isLoginRequired();
    await isAccountSessionValid("token-1");

    resetAccountCache();
    await isLoginRequired();
    await isAccountSessionValid("token-1");
    expect(fetchSpy).toHaveBeenCalledTimes(4);
  });
});
