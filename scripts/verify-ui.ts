/**
 * Drive the REAL signed-in production site and screenshot it.
 *
 * Every route sits behind Clerk's `auth.protect()`, so an unauthenticated
 * request 404s — which meant a change could be deployed but never actually SEEN
 * before being handed to Tom. This closes that gap.
 *
 * How it works: the Clerk instance is a TEST instance (`sk_test_`), so we can
 * mint a real session for a test user through the Clerk Backend API and drop
 * the resulting JWT into the `__session` cookie the middleware reads. That
 * skips the sign-in form entirely — which matters, because this instance
 * enforces a second factor that an API-created user doesn't have.
 *
 * Nothing here weakens the app's auth: no bypass is added to the app, and the
 * script refuses to run against anything but a test Clerk instance.
 *
 * Clerk session JWTs live ~60s, so we mint a fresh one before each navigation.
 *
 *   npx tsx scripts/verify-ui.ts                    # prod
 *   npx tsx scripts/verify-ui.ts http://localhost:3000
 *
 * Screenshots land in scripts/.screenshots/ (gitignored).
 */

import { readFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

function loadEnvLocal() {
  const raw = readFileSync(resolve(process.cwd(), ".env.local"), "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!process.env[k]) process.env[k] = v;
  }
}
loadEnvLocal();

const BASE = process.argv[2] ?? "https://job-hunt-dashboard-two.vercel.app";
const PASSWORD = process.env.VERIFY_USER_PASSWORD ?? "HuntHQ-verify-2026!x";
const EMAIL = process.env.VERIFY_USER_EMAIL ?? "claude+clerk_test@grainandframe.com";
// Clerk test instances accept this fixed code for any `+clerk_test` address.
const TEST_OTP = "424242";
const SHOTS = resolve(process.cwd(), "scripts/.screenshots");
const CLERK_API = "https://api.clerk.com/v1";

const SK = process.env.CLERK_SECRET_KEY ?? "";

async function clerkFetch(path: string, init?: RequestInit) {
  const res = await fetch(`${CLERK_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${SK}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const body = await res.json();
  if (!res.ok) {
    throw new Error(`Clerk ${path} -> ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
  }
  return body;
}

/** Find the test user, creating it if this is a fresh machine. */
async function ensureTestUser(): Promise<string> {
  const found = (await clerkFetch(
    `/users?email_address=${encodeURIComponent(EMAIL)}`
  )) as Array<{ id: string }>;
  if (Array.isArray(found) && found.length) return found[0].id;

  const created = (await clerkFetch("/users", {
    method: "POST",
    body: JSON.stringify({
      email_address: [EMAIL],
      password: process.env.VERIFY_USER_PASSWORD ?? "HuntHQ-verify-2026!x",
      skip_password_checks: true,
    }),
  })) as { id: string };
  console.log(`   created test user ${created.id}`);
  return created.id;
}

async function mintSessionJwt(userId: string): Promise<string> {
  const session = (await clerkFetch("/sessions", {
    method: "POST",
    body: JSON.stringify({ user_id: userId }),
  })) as { id: string };
  const tok = (await clerkFetch(`/sessions/${session.id}/tokens`, {
    method: "POST",
    body: JSON.stringify({}),
  })) as { jwt: string };
  return tok.jwt;
}

async function main() {
  if (!SK.startsWith("sk_test_")) {
    throw new Error("Refusing to run: CLERK_SECRET_KEY is not a test-instance key.");
  }
  mkdirSync(SHOTS, { recursive: true });

  const { chromium } = await import("@playwright/test");
  const { clerkSetup, setupClerkTestingToken } = await import("@clerk/testing/playwright");

  process.env.CLERK_PUBLISHABLE_KEY ??= process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  await clerkSetup();

  console.log(`\nBase: ${BASE}`);
  console.log(`User: ${EMAIL}\n`);

  console.log("1. Establishing session...");
  await ensureTestUser();

  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  page.setDefaultTimeout(90_000);
  await setupClerkTestingToken({ page });

  // Sign in through Clerk's JS SDK rather than the sign-in form.
  //
  // Two things make this fiddly and are worth writing down:
  //
  //   1. A dev instance needs the dev-browser handshake, which only happens
  //      in-page. A `__session` cookie minted from the Backend API is silently
  //      ignored — you get HTTP 200 and the SIGN-IN PAGE.
  //   2. This instance ENFORCES A SECOND FACTOR (email_code). `clerk.signIn()`
  //      resolves without throwing but leaves the attempt at
  //      `needs_second_factor` and creates no session. The test user's address
  //      contains `+clerk_test`, which Clerk test instances accept with the
  //      fixed code 424242 — no inbox required.
  await page.goto(`${BASE}/sign-in`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !!(window as { Clerk?: { loaded?: boolean } }).Clerk?.loaded);

  const signInResult = await page.evaluate(
    async ({ identifier, password, code }) => {
      /* eslint-disable @typescript-eslint/no-explicit-any */
      const C = (window as any).Clerk;
      let si = await C.client.signIn.create({ strategy: "password", identifier, password });
      if (si.status === "needs_second_factor") {
        await si.prepareSecondFactor({ strategy: "email_code" });
        si = await si.attemptSecondFactor({ strategy: "email_code", code });
      }
      if (si.status === "complete") {
        await C.setActive({ session: si.createdSessionId });
      }
      return { status: si.status as string };
    },
    { identifier: EMAIL, password: PASSWORD, code: TEST_OTP }
  );

  if (signInResult.status !== "complete") {
    throw new Error(`Clerk sign-in ended at status "${signInResult.status}", not "complete".`);
  }

  // Clerk writes `__session` asynchronously after signIn() resolves. Navigating
  // before it lands means the SSR middleware sees an anonymous request and
  // serves the sign-in page (with a cheerful HTTP 200).
  const deadline = Date.now() + 30_000;
  let cookieNames: string[] = [];
  for (;;) {
    cookieNames = (await context.cookies()).map((c) => c.name);
    if (cookieNames.includes("__session")) break;
    if (Date.now() > deadline) {
      throw new Error(`__session cookie never appeared. Cookies present: ${cookieNames.join(", ") || "(none)"}`);
    }
    await page.waitForTimeout(500);
  }
  console.log(`   signed in via Clerk SDK (cookies: ${cookieNames.join(", ")})\n`);

  const results: Array<{ path: string; status: number; heading: string }> = [];

  for (const path of ["/roles", "/debug/enrichment"]) {
    console.log(`2. Loading ${path} ...`);
    const resp = await page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded" });
    const status = resp?.status() ?? 0;
    await page.waitForLoadState("networkidle", { timeout: 60_000 }).catch(() => {});

    const name = path.replace(/\W+/g, "_").replace(/^_/, "");
    await page.screenshot({ path: resolve(SHOTS, `${name}.png`), fullPage: true });

    // HTTP 200 is NOT proof of anything: when the session isn't accepted the app
    // happily returns 200 and renders the SIGN-IN FORM. Assert we're actually on
    // the page we asked for.
    const onSignIn =
      page.url().includes("/sign-in") ||
      (await page.locator('input[name="identifier"]').count()) > 0;
    if (onSignIn) {
      throw new Error(
        `${path} rendered the SIGN-IN form (HTTP ${status}) — the session was not accepted. ` +
          `See scripts/.screenshots/${name}.png`
      );
    }
    if (status >= 400) {
      throw new Error(`${path} returned HTTP ${status} while signed in — a real failure.`);
    }

    const heading =
      (await page.locator("h1, h2").first().textContent().catch(() => null))?.trim() ?? "-";
    console.log(`   HTTP ${status} | heading="${heading}"`);
    console.log(`   -> scripts/.screenshots/${name}.png\n`);
    results.push({ path, status, heading });
  }

  console.log("Signed-in pages verified:");
  for (const r of results) console.log(`  ${r.path.padEnd(20)} HTTP ${r.status}  "${r.heading}"`);
  console.log();

  await browser.close();
}

main().catch((e) => {
  console.error("\nFAILED:", e instanceof Error ? e.message : e);
  process.exit(1);
});
