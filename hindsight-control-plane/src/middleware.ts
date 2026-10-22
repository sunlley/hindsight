import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { localizeApiErrorPayload } from "@/lib/i18n/api-errors";
import createIntlMiddleware from "next-intl/middleware";

import { isAccountSessionValid, isLoginRequired } from "@/lib/auth/account";
import {
  ACCESS_KEY_COOKIE,
  ACCOUNT_SESSION_COOKIE,
  SESSION_REQUIRED_HEADER,
  verifySessionToken,
} from "@/lib/auth/session";
import { sanitizeReturnTo, stripBasePath, withBasePath } from "@/lib/base-path";
import { routing } from "@/i18n/routing";

// Routes that don't require authentication
const PUBLIC_PATTERNS = [
  "/login",
  "/api/auth/",
  "/api/health",
  "/api/version",
  "/logo.png",
  "/favicon",
  "/_next",
  "/fonts",
  "/static",
];

const intlMiddleware = createIntlMiddleware(routing);

interface SignIn {
  /** Whether this deployment asks for a sign-in at all. */
  required: boolean;
  /** Whether this request carries a valid one. */
  ok: boolean;
}

/**
 * The admin account set up on the Settings page takes over; without one, the access key from the environment
 * still works, as before; with neither the page is open.
 */
async function checkSignIn(request: NextRequest): Promise<SignIn> {
  if (await isLoginRequired()) {
    return {
      required: true,
      ok: await isAccountSessionValid(request.cookies.get(ACCOUNT_SESSION_COOKIE)?.value),
    };
  }
  const accessKey = process.env.HINDSIGHT_CP_ACCESS_KEY;
  if (accessKey) {
    return {
      required: true,
      ok: await verifySessionToken(request.cookies.get(ACCESS_KEY_COOKIE)?.value, accessKey),
    };
  }
  return { required: false, ok: true };
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const appPathname = stripBasePath(pathname);

  // API routes are not locale-prefixed — handle auth directly without i18n routing.
  if (appPathname.startsWith("/api/")) {
    const isPublic = PUBLIC_PATTERNS.some((pattern) => appPathname.startsWith(pattern));
    if (isPublic) {
      return NextResponse.next();
    }

    const signIn = await checkSignIn(request);
    if (!signIn.required) {
      return NextResponse.next();
    }

    if (!signIn.ok) {
      return NextResponse.json(
        localizeApiErrorPayload(request, {
          error: "Unauthorized",
          errorKey: "api.errors.auth.unauthorized",
        }),
        // The header tells the browser this 401 is about its own session, so only
        // this one sends it to the login form. A 401 forwarded from the dataplane
        // can't be fixed by re-entering the UI key.
        { status: 401, headers: { [SESSION_REQUIRED_HEADER]: "1" } }
      );
    }

    return NextResponse.next();
  }

  // Page routes: enforce auth first, then delegate to the i18n middleware for
  // locale negotiation and rewriting. With localePrefix "never" the locale is
  // never in the path, so appPathname is already the canonical route.
  const isPublic = PUBLIC_PATTERNS.some((pattern) => appPathname.startsWith(pattern));
  const isLogin = appPathname === "/login";

  if (!isPublic || isLogin) {
    const signIn = await checkSignIn(request);

    if (isLogin) {
      // Already signed in: skip the form and continue where the link pointed.
      if (signIn.required && signIn.ok) {
        const target = sanitizeReturnTo(request.nextUrl.searchParams.get("returnTo"));
        return NextResponse.redirect(new URL(withBasePath(target), request.url));
      }
    } else if (signIn.required && !signIn.ok) {
      // Next.js middleware redirects do not automatically inherit next.config basePath.
      // Prefix the target explicitly, but keep returnTo as the app-relative path so
      // client-side router.push() does not double-prefix after login.
      const loginUrl = new URL(withBasePath("/login"), request.url);
      loginUrl.searchParams.set("returnTo", appPathname);
      return NextResponse.redirect(loginUrl);
    }
  }

  return intlMiddleware(request);
}

export const config = {
  // Match all paths except Next.js internals and static assets.
  // - Use an explicit file extension allowlist instead of .*\..* so that
  //   dynamic segments containing dots (e.g. bank IDs like
  //   "SX.Products.GovComply.Build") still get the i18n locale rewrite.
  matcher:
    "/((?!_next|_vercel|.*\\.(?:png|jpe?g|gif|svg|webp|ico|css|js|map|woff2?|ttf|eot|txt|xml|json)$).*)",
};
