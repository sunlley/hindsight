import { NextResponse } from "next/server";

import { isLoginRequired } from "@/lib/auth/account";

/**
 * Which form the login page shows, and what a 401 from the API should lead to: the admin account's username and
 * password, the access key from the environment, or nothing (the page is open).
 */
export async function GET() {
  const mode = (await isLoginRequired({ fresh: true }))
    ? "account"
    : process.env.HINDSIGHT_CP_ACCESS_KEY
      ? "key"
      : "none";
  return NextResponse.json({ mode });
}
