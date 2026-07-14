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

  // ---- Title-chip autocomplete ----
  //
  // Reproduces the exact flow that was broken: open New search, type a partial
  // role, click the suggestion. The input used to blur on mousedown, which
  // committed the half-typed buffer ("supply chain ana") as a chip and swapped
  // the suggestion list out from under the click.
  console.log("3. Title-chip autocomplete (type partial role -> click suggestion)...");
  await page.goto(`${BASE}/roles`, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle", { timeout: 60_000 }).catch(() => {});

  // The button is "New search" in the empty state and a compact "+ New" once the
  // user has any searches — so the harness only worked on a virgin account, and
  // broke the moment it had successfully created a search on a previous run. A
  // test that passes exactly once is not a test.
  await page
    .getByRole("button", { name: /^(\+\s*)?new( search)?$/i })
    .first()
    .click();
  const chipInput = page.locator('input[placeholder*="press Enter" i]').first();
  await chipInput.waitFor({ state: "visible" });
  await chipInput.fill("supply chain ana");

  // The top suggestion should be the completed title.
  const suggestion = page.getByRole("button", { name: /^\+ Supply Chain Analyst$/i }).first();
  await suggestion.waitFor({ state: "visible" });
  await suggestion.click();

  await page.screenshot({ path: resolve(SHOTS, "title_chip.png"), fullPage: false });
  console.log("   -> scripts/.screenshots/title_chip.png");

  const chips = await page.locator('span:has(button[aria-label^="Remove"])').allTextContents();
  const cleaned = chips.map((c) => c.trim()).filter(Boolean);
  console.log(`   chips now: ${JSON.stringify(cleaned)}`);

  const truncated = cleaned.some((c) => /supply chain ana$/i.test(c));
  if (truncated) {
    throw new Error(`Chip committed the half-typed buffer: ${JSON.stringify(cleaned)}`);
  }
  if (!cleaned.some((c) => /supply chain analyst/i.test(c))) {
    throw new Error(`Expected a "Supply Chain Analyst" chip, got ${JSON.stringify(cleaned)}`);
  }
  console.log('   OK — chip is "Supply Chain Analyst", not the fragment.\n');

  // -------------------------------------------------------------------------
  // 4. A REAL SEARCH, END TO END.
  //
  // Everything above proves pages RENDER. None of it proves the product WORKS.
  // Nobody — not Claude, not Tom — had run an actual search on the live site since
  // ATS-direct supply landed, so "1,854 first-party jobs in the corpus" was a
  // database fact, not a user-visible one. This drives the thing a user does:
  // name a role, run it, and look at what comes back.
  //
  // The assertions are the ones that matter for the moat:
  //   • ATS (first-party) jobs actually REACH the shortlist, and
  //   • they are not sitting underneath recruiter spam.
  // -------------------------------------------------------------------------
  console.log("4. Running a REAL search end-to-end...");

  // Finish creating the search the chip test started.
  //
  // ⚠️ Select on the EXACT placeholder. A loose `input[placeholder*="e.g."]` matches
  // the POSTCODE box (placeholder "e.g. SW1A 1AA") before it matches anything else,
  // so the first version of this typed the search NAME into the postcode field, left
  // the name blank, and sat on a red "Give the search a name" error — while the
  // script sailed on. The screenshot is what caught it; the exit code said nothing.
  // ⚠️ THE QUERY IS PART OF THE TEST, AND IT HAS NOW BEEN WRONG IN BOTH DIRECTIONS.
  //
  // v1 searched "Supply Chain Analyst" near BIRMINGHAM and asserted ATS jobs must
  // appear. Zero did — the assertion was RIGHT to fire but WRONG about why. The
  // corpus then held ~1,900 first-party jobs, of which 553 were in London and EIGHT
  // in Birmingham, none supply-chain. It was measuring a COVERAGE gap in the
  // registry while claiming the moat was unplugged: opposite bugs, opposite fixes.
  //
  // v2 therefore moved to "Software Engineer" in LONDON — supply we KNEW existed —
  // so the harness tested the WIRING and not the registry's geography. Correct at
  // the time, but it meant the product's worst case was no longer being tested.
  //
  // v3 (2026-07-14) PUTS BIRMINGHAM BACK, because the coverage gap has been closed:
  // 52 -> 94 boards, and Birmingham first-party supply went 7 -> 169 jobs, including
  // Turner & Townsend's procurement desk, Baxi (Warwick) and Greene King (Burton).
  // London's share of first-party supply fell from 43% to 23%. This is now the
  // strictly HARDER test — if the Midlands works, London (with 9x the supply through
  // the identical code path) works.
  //
  // SEVERAL ROLE CHIPS, deliberately. `titleRelevantOne` requires the role noun AND
  // a qualifier, so a lone "Supply Chain Analyst" chip drops "Procurement Consultant"
  // by design (else "Analyst" matches the whole corpus). That is the documented chip
  // rule, NOT a coverage gap — and a harness that ignored it would re-diagnose a
  // working registry as broken, which is the exact mistake v1 made.
  await page.locator('input[placeholder*="remember it by" i]').first()
    .fill(`Claude verify — supply chain Birmingham ${Date.now()}`);
  await page.locator('input[placeholder*="SW1A" i]').first().fill("B1 1AA"); // Birmingham

  // Replace the chip the autocomplete test left behind.
  const removeChip = page.locator('button[aria-label^="Remove"]').first();
  if (await removeChip.count()) await removeChip.click();
  const chipBox = page.locator('input[placeholder*="press Enter" i]').first();
  for (const role of [
    "Supply Chain Analyst",
    "Procurement Consultant",
    "Supply Chain Coordinator",
    "Buyer",
  ]) {
    await chipBox.fill(role);
    await chipBox.press("Enter");
  }

  await page.getByRole("button", { name: /^create search$/i }).first().click();
  await page.waitForLoadState("networkidle", { timeout: 60_000 }).catch(() => {});
  await page.waitForTimeout(2000);
  await page.screenshot({ path: resolve(SHOTS, "search_saved.png"), fullPage: true });
  console.log("   -> scripts/.screenshots/search_saved.png");

  // The modal must actually be GONE. If validation failed it is still sitting there
  // and everything below would be asserting against a form, not a shortlist.
  if (await page.locator('input[placeholder*="remember it by" i]').count()) {
    throw new Error(
      "The New-search modal is still open — the search was not created (validation error?). " +
        "See scripts/.screenshots/search_saved.png"
    );
  }

  // Run it. The pull hits Reed + Adzuna live and queries the ATS corpus, so give
  // it room — a slow run is not a failed one.
  const runBtn = page.getByRole("button", { name: /^run now$/i }).first();
  await runBtn.waitFor({ state: "visible", timeout: 30_000 });
  await runBtn.click();
  console.log("   search running (up to 3 min)...");

  // Wait for the button to stop saying "Running…" — that is the real completion
  // signal. Waiting on networkidle alone returns while the server action is still
  // in flight, and we would screenshot an empty shortlist and call it a failure.
  await page
    .getByRole("button", { name: /^run now$/i })
    .first()
    .waitFor({ state: "visible", timeout: 240_000 })
    .catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: 180_000 }).catch(() => {});
  await page.waitForTimeout(5000);

  await page.screenshot({ path: resolve(SHOTS, "search_results.png"), fullPage: true });
  console.log("   -> scripts/.screenshots/search_results.png");

  // What actually came back? Read the source label off each card, in rank order.
  const bodyText = (await page.locator("body").innerText()).toLowerCase();
  const ATS_SOURCES = ["greenhouse", "lever", "ashby", "smartrecruiters", "workday", "recruitee"];
  const atsSeen = ATS_SOURCES.filter((s) => bodyText.includes(s));
  const aggSeen = ["reed", "adzuna"].filter((s) => bodyText.includes(s));

  console.log(`   ATS sources visible on the page : ${atsSeen.join(", ") || "(NONE)"}`);
  console.log(`   aggregator sources visible      : ${aggSeen.join(", ") || "(none)"}`);

  const empty = /no jobs|nothing matched|0 jobs/i.test(bodyText);
  if (empty) {
    throw new Error(
      "The search returned an EMPTY shortlist. A green render over zero results is exactly " +
        "the false pass this harness exists to prevent. See scripts/.screenshots/search_results.png"
    );
  }
  if (atsSeen.length === 0) {
    throw new Error(
      "NO first-party ATS job reached the shortlist for SUPPLY CHAIN roles in BIRMINGHAM — " +
        "where the corpus now definitely has them (169 first-party Birmingham jobs, incl. " +
        "Turner & Townsend procurement). This search returned ZERO before the 2026-07-14 " +
        "coverage block; if it is zero again, either the registry regressed or the moat came " +
        "unplugged from the product. See scripts/.screenshots/search_results.png"
    );
  }
  console.log("   OK — first-party ATS jobs reached the shortlist.");

  // And the moat has to actually WIN, not merely appear. A recruiter-posted ad at
  // the top of the list is the exact outcome ATS-direct supply exists to prevent —
  // it happened on the first live run of this harness (a recruiter ranked #1, above
  // Aldi and ZEISS), because ranking had a first-party BONUS and no recruiter PENALTY.
  const firstCardSource = (
    await page
      .locator("text=/^(reed|adzuna|greenhouse|lever|ashby|smartrecruiters|workday)$/i")
      .first()
      .textContent()
      .catch(() => null)
  )?.trim().toLowerCase();
  console.log(`   top-ranked result's source: ${firstCardSource ?? "(unreadable)"}`);
  if (firstCardSource && !ATS_SOURCES.includes(firstCardSource)) {
    console.log(
      `   ⚠️  the top result is from an AGGREGATOR (${firstCardSource}), not the employer's own board. ` +
        `Not fatal — an aggregator job can legitimately be the best match — but worth an eye.`
    );
  }
  console.log();

  await browser.close();
}

main().catch((e) => {
  console.error("\nFAILED:", e instanceof Error ? e.message : e);
  process.exit(1);
});
