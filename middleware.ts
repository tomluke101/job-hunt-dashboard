import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

const isPublicRoute = createRouteMatcher(["/sign-in(.*)", "/sign-up(.*)"]);

/**
 * Machine endpoints. Clerk only understands USER SESSIONS, so `auth.protect()`
 * 404s the Vercel cron — which would mean the ATS corpus silently never refreshes
 * and the whole freshness advantage over Reed/Adzuna quietly evaporates. (Verified:
 * GET /api/ats/ingest returned 404, not 401, before this.)
 *
 * These are NOT public. They are exempt from Clerk because they authenticate
 * themselves with a CRON_SECRET bearer token, which is the right credential for a
 * caller that has no user attached. The route rejects anything else with a 401.
 */
const isMachineRoute = createRouteMatcher(["/api/ats/ingest"]);

export default clerkMiddleware(async (auth, request) => {
  if (!isPublicRoute(request) && !isMachineRoute(request)) {
    await auth.protect();
  }
});

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
