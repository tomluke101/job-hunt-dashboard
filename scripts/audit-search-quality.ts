/**
 * scripts/audit-search-quality.ts — THE SEARCH-QUALITY SCOREBOARD.
 *
 * The product's job is to find users the BEST jobs: comprehensive supply +
 * precise selection, bullshit stripped. This script MEASURES how close we are,
 * so fixes get sequenced on evidence instead of guesswork. It is the permanent
 * scoreboard / regression gate.
 *
 * WHAT IT DOES (all REAL — no mocks, no assertions of quality without evidence):
 *   1. Runs ~10 realistic user searches through the ACTUAL runSearch() pipeline
 *      against the LIVE prod corpus + LIVE Reed/Adzuna aggregators + LIVE OpenAI
 *      semantic ranking. Same code path a signed-in user hits on prod.
 *   2. Reads the top-10 results per search and captures, per result:
 *        - source + first-party(ATS) vs aggregator
 *        - recruiter flag (same detector the pipeline ranks with)
 *        - whether semantic ranking FIRED (match_to_user_score present)
 *        - salary listed
 *        - location correctness (UK? within radius / remote?)
 *        - source_url LIVENESS (real HTTP check for dead/expired links)
 *   3. Grades each result's RELEVANCE to the search intent with an LLM judge
 *      (Haiku 4.5 — cheap, bounded, one call per search): on_target /
 *      loosely_related / off_target.
 *   4. Computes per-search: relevance %, bullshit rate (recruiter + dead-link +
 *      duplicate + wrong-location), first-party/aggregator mix, semantic-fired %.
 *   5. COVERAGE spot-check (Adzuna API ground-truth) on selected searches:
 *      market breadth vs our first-party depth vs what we actually surfaced.
 *
 * HONESTY GUARD: preflight ABORTS if any source key is missing or the semantic
 * axis cannot fire. A scoreboard run with semantic OFF or an aggregator silently
 * returning zero would be a LIE — the exact failure mode this codebase keeps
 * getting bitten by. Better no number than a wrong one.
 *
 *   npx tsx scripts/audit-search-quality.ts                 # full run (10 searches + coverage)
 *   npx tsx scripts/audit-search-quality.ts --searches=1,5  # subset by id (fast iteration)
 *   npx tsx scripts/audit-search-quality.ts --no-coverage   # skip Adzuna coverage
 *   npx tsx scripts/audit-search-quality.ts --no-judge      # skip the Haiku judge
 *
 * Env: reads .env.local from cwd, then merges the canonical HuntHQ key store
 * (OneDrive clone) for any missing API keys. Never writes secrets anywhere.
 *
 * Writes raw results JSON next to the console scoreboard; cleans up every test
 * search it creates (runs against the Clerk TEST user, never Tom's account).
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

// ------------------------------------------------------------------ env ----
function loadEnvFiles(paths: string[]) {
  for (const p of paths) {
    if (!p || !existsSync(p)) continue;
    const raw = readFileSync(p, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const eq = t.indexOf("=");
      if (eq === -1) continue;
      const k = t.slice(0, eq).trim();
      let v = t.slice(eq + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (!process.env[k]) process.env[k] = v; // first file wins
    }
  }
}
loadEnvFiles([
  resolve(process.cwd(), ".env.local"),
  process.env.AUDIT_ENV_FILE ?? "",
  // Canonical HuntHQ key store (reference-api-keys-hunthq.md). Fills Reed/Adzuna/
  // OpenAI/Anthropic when the local clone's .env.local only has Clerk+Supabase.
  "C:/Users/tomlu/OneDrive/Desktop/Money/Job hunt SaaS/job-hunt-dashboard/.env.local",
]);

// ------------------------------------------------------------- preflight ----
function assertKeys() {
  const required = [
    "NEXT_PUBLIC_SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "OPENAI_API_KEY",   // semantic axis — without it the scoreboard is a lie
    "REED_API_KEY",     // aggregator breadth
    "ADZUNA_APP_ID",
    "ADZUNA_APP_KEY",
    "ANTHROPIC_API_KEY", // the relevance judge
  ];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) {
    console.error("\n❌ PREFLIGHT FAILED — missing keys:", missing.join(", "));
    console.error("   Running a degraded audit (no semantic / no aggregators) would produce a");
    console.error("   dishonest scoreboard. Point AUDIT_ENV_FILE at a complete .env.local.\n");
    process.exit(2);
  }
}

// --------------------------------------------------------- the searches ----
type SearchDef = {
  id: number;
  label: string;
  category: string;
  keywords: string;
  target_titles: string[];
  postcode: string | null; // null => nationwide / remote
  place: string;           // human-readable location for the judge + coverage
  adzunaWhere: string | null;
};

const SEARCHES: SearchDef[] = [
  { id: 1, label: "Marketing Manager / London", category: "common", keywords: "Marketing Manager",
    target_titles: ["Marketing Manager", "Senior Marketing Manager", "Brand Manager", "Digital Marketing Manager"],
    postcode: "EC1A 1BB", place: "London", adzunaWhere: "London" },
  { id: 2, label: "Actuarial Analyst / Manchester", category: "niche", keywords: "Actuarial Analyst",
    target_titles: ["Actuarial Analyst", "Actuary", "Pricing Analyst", "Reserving Analyst"],
    postcode: "M1 1AE", place: "Manchester", adzunaWhere: "Manchester" },
  { id: 3, label: "Warehouse Operative / Leeds", category: "regional non-London",
    keywords: "Warehouse Operative",
    target_titles: ["Warehouse Operative", "Warehouse Assistant", "Picker Packer", "Warehouse Worker"],
    postcode: "LS1 1BA", place: "Leeds", adzunaWhere: "Leeds" },
  { id: 4, label: "Head of Finance / remote", category: "senior / remote", keywords: "Head of Finance",
    target_titles: ["Head of Finance", "Finance Director", "Financial Controller", "Head of Financial Planning"],
    postcode: null, place: "Remote (UK)", adzunaWhere: null },
  { id: 5, label: "Graduate Software Engineer / Birmingham", category: "graduate",
    keywords: "Graduate Software Engineer",
    target_titles: ["Graduate Software Engineer", "Junior Software Engineer", "Graduate Developer", "Software Engineer"],
    postcode: "B1 1AA", place: "Birmingham", adzunaWhere: "Birmingham" },
  { id: 6, label: "Electrician / Bristol", category: "trade", keywords: "Electrician",
    target_titles: ["Electrician", "Maintenance Electrician", "Domestic Electrician", "Electrical Technician"],
    postcode: "BS1 4DJ", place: "Bristol", adzunaWhere: "Bristol" },
  { id: 7, label: "Registered Nurse / Glasgow", category: "healthcare / regional Scotland",
    keywords: "Registered Nurse",
    target_titles: ["Registered Nurse", "Staff Nurse", "RGN", "Registered General Nurse"],
    postcode: "G1 1XW", place: "Glasgow", adzunaWhere: "Glasgow" },
  { id: 8, label: "Data Analyst / remote", category: "common tech / remote", keywords: "Data Analyst",
    target_titles: ["Data Analyst", "Business Analyst", "Analytics Analyst", "Insight Analyst"],
    postcode: null, place: "Remote (UK)", adzunaWhere: null },
  { id: 9, label: "Care Assistant / Cardiff", category: "care / Wales / high-volume",
    keywords: "Care Assistant",
    target_titles: ["Care Assistant", "Healthcare Assistant", "Support Worker", "Care Worker"],
    postcode: "CF10 1EP", place: "Cardiff", adzunaWhere: "Cardiff" },
  { id: 10, label: "Primary School Teacher / Sheffield", category: "education / regional",
    keywords: "Primary School Teacher",
    target_titles: ["Primary School Teacher", "Primary Teacher", "KS1 Teacher", "KS2 Teacher"],
    postcode: "S1 2HH", place: "Sheffield", adzunaWhere: "Sheffield" },
];

const COVERAGE_IDS = [1, 3, 5, 9]; // common / regional / grad-tech / high-volume-care

const TEST_USER_ID = process.env.VERIFY_CLERK_USER_ID ?? "user_3GOvhiCIGhdEIkKSJqxkw2AUyXg";
const TOP_N = 10;

// ATS-direct sources (first-party). Mirrors lib/job-search/types.ts ATS_SOURCES.
const ATS = new Set(["greenhouse", "lever", "ashby", "smartrecruiters", "recruitee", "workday", "workable", "jsonld", "teaching_vacancies", "nhs_jobs"]);

// -------------------------------------------------------- HTTP liveness ----
// "blocked" matters: aggregator redirect services (Adzuna, Reed) return 401/403/
// 429 to non-browser clients — that is bot-blocking, NOT a dead posting. Counting
// those as dead would inflate the bullshit rate with false positives (it did: 7 of
// 8 "dead" links in the first baseline were Adzuna 403s). Only 404/410/5xx and a
// hard network failure are genuinely dead. "blocked" links are UNVERIFIABLE and are
// excluded from the bullshit rate.
type Liveness = "live" | "dead" | "blocked" | "unreachable" | "no_url";

async function checkLiveness(url: string | null): Promise<{ status: Liveness; code: number | null }> {
  if (!url) return { status: "no_url", code: null };
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10_000);
  try {
    // HEAD first; many ATS/aggregator hosts reject HEAD, so fall back to a GET.
    let res: Response;
    try {
      res = await fetch(url, { method: "HEAD", redirect: "follow", signal: ctrl.signal,
        headers: { "user-agent": "Mozilla/5.0 (HuntHQ link-check)" } });
      if (res.status === 405 || res.status === 501) throw new Error("head-unsupported");
    } catch {
      res = await fetch(url, { method: "GET", redirect: "follow", signal: ctrl.signal,
        headers: { "user-agent": "Mozilla/5.0 (HuntHQ link-check)" } });
    }
    clearTimeout(t);
    if (res.status >= 200 && res.status < 400) return { status: "live", code: res.status };
    // Bot-block / rate-limit — can't confirm dead-or-alive from an automated check.
    if (res.status === 401 || res.status === 403 || res.status === 429) return { status: "blocked", code: res.status };
    // 404/410 = expired posting; other 4xx/5xx = broken.
    return { status: "dead", code: res.status };
  } catch {
    clearTimeout(t);
    return { status: "unreachable", code: null };
  }
}

async function livenessBatch(urls: (string | null)[], concurrency = 8) {
  const out = new Array<{ status: Liveness; code: number | null }>(urls.length);
  let cursor = 0;
  async function worker() {
    for (;;) {
      const i = cursor++;
      if (i >= urls.length) return;
      out[i] = await checkLiveness(urls[i]);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return out;
}

// ------------------------------------------------------- relevance judge ----
type Verdict = "on_target" | "loosely_related" | "off_target" | "unjudged";

async function judgeRelevance(
  search: SearchDef,
  results: Array<{ title: string; company: string; place: string | null; salary: string; working_model?: string }>
): Promise<Array<{ verdict: Verdict; reason: string }>> {
  if (!results.length) return [];
  const Anthropic = (await import("@anthropic-ai/sdk")).default;
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const isRemoteSearch = search.postcode === null;
  const list = results
    .map((r, i) => {
      const wm = r.working_model && r.working_model !== "unknown" ? ` — working model: ${r.working_model}` : "";
      return `${i}. "${r.title}" @ ${r.company} — ${r.place ?? "location?"} — ${r.salary}${wm}`;
    })
    .join("\n");
  const sys =
    "You grade the RELEVANCE of job-search results to a user's intent. Be a strict but fair " +
    "UK recruiter. Return ONLY JSON.";
  // For a REMOTE search the location the user cares about is the WORKING MODEL,
  // not the office city. A role whose working model is "remote" satisfies a
  // "Remote (UK)" search even when it lists a head-office town (that is the
  // company HQ, not where the person must sit) — judging it "not remote" off the
  // city alone is the exact confusion defect #3 was about, and it under-counts a
  // correctly-enforced remote result. It must still be the right role + seniority.
  const remoteNote = isRemoteSearch
    ? `\nThis is a REMOTE search. A role whose stated working model is "remote" (or a UK ` +
      `home-based / work-from-home role) is LOCATION-APPROPRIATE even if it also names a ` +
      `head-office city — do NOT mark it off/loose for "not remote" when its working model ` +
      `is remote. Grade it on role family + seniority. A role that is office/hybrid, or has ` +
      `no remote signal, is a wrong-location result.\n`
    : "";
  const prompt =
    `The user searched for the role "${search.keywords}" in "${search.place}".\n` +
    `Their acceptable job titles are: ${search.target_titles.join(", ")}.\n` +
    remoteNote +
    `\nGrade each result's relevance to that INTENT:\n` +
    `- "on_target": a job someone running this exact search would genuinely want — right role ` +
    `family AND a sensible seniority match AND plausibly the right place.\n` +
    `- "loosely_related": same broad field but wrong seniority/specialism, or an adjacent role.\n` +
    `- "off_target": wrong role or field entirely, or clearly the wrong location.\n\n` +
    `Results:\n${list}\n\n` +
    `Return a JSON array of exactly ${results.length} objects in order: ` +
    `[{"i":0,"verdict":"on_target|loosely_related|off_target","reason":"<=12 words"}]`;
  try {
    const msg = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1500,
      temperature: 0,
      system: sys,
      messages: [{ role: "user", content: prompt }],
    });
    const text = msg.content.filter((c) => c.type === "text").map((c: any) => c.text).join("");
    const jsonStart = text.indexOf("[");
    const jsonEnd = text.lastIndexOf("]");
    const parsed = JSON.parse(text.slice(jsonStart, jsonEnd + 1)) as Array<{ i: number; verdict: string; reason: string }>;
    const byIdx = new Map(parsed.map((p) => [p.i, p]));
    return results.map((_, i) => {
      const p = byIdx.get(i);
      const v = p?.verdict as Verdict;
      const ok: Verdict[] = ["on_target", "loosely_related", "off_target"];
      return { verdict: ok.includes(v) ? v : "unjudged", reason: p?.reason ?? "" };
    });
  } catch (e) {
    console.error(`   [judge] failed for search ${search.id}: ${String(e).slice(0, 120)}`);
    return results.map(() => ({ verdict: "unjudged" as Verdict, reason: "" }));
  }
}

// --------------------------------------------------------- Adzuna truth ----
type AzResult = {
  title: string;
  company: string;
  place: string;
  url: string | null;
  salary_min: number | null;
  salary_max: number | null;
};
async function adzunaSearch(what: string, where: string | null) {
  const params = new URLSearchParams({
    app_id: process.env.ADZUNA_APP_ID!,
    app_key: process.env.ADZUNA_APP_KEY!,
    results_per_page: "20",
    what: what,
    max_days_old: "30",
    "content-type": "application/json",
  });
  if (where) params.set("where", where);
  const url = `https://api.adzuna.com/v1/api/jobs/gb/search/1?${params.toString()}`;
  const res = await fetch(url);
  if (!res.ok) return { count: null as number | null, results: [] as AzResult[], error: `HTTP ${res.status}` };
  const j = (await res.json()) as any;
  return {
    count: typeof j.count === "number" ? j.count : null,
    results: ((j.results ?? []) as unknown[]).map((r: any): AzResult => ({
      title: r.title as string,
      company: (r.company?.display_name ?? "?") as string,
      place: (r.location?.display_name ?? "?") as string,
      url: (r.redirect_url ?? null) as string | null,
      salary_min: r.salary_min ?? null,
      salary_max: r.salary_max ?? null,
    })),
    error: undefined as string | undefined,
  };
}

// --------------------------------------------------------------- helpers ----
function salaryStr(min: number | null, max: number | null, listed: boolean): string {
  // 0/0 is Reed's "salary not stated" sentinel, not a real £0 band.
  if ((!min || min === 0) && (!max || max === 0)) return "no salary";
  if (min && max) return `£${Math.round(min / 1000)}k–£${Math.round(max / 1000)}k`;
  if (min) return `£${Math.round(min / 1000)}k+`;
  if (max) return `up to £${Math.round(max / 1000)}k`;
  return "no salary";
}
function pct(n: number, d: number): number {
  return d === 0 ? 0 : Math.round((n / d) * 1000) / 10;
}

// ------------------------------------------------------------------ main ----
async function main() {
  assertKeys();

  const args = process.argv.slice(2);
  const subset = args.find((a) => a.startsWith("--searches="))?.split("=")[1]?.split(",").map(Number);
  const doCoverage = !args.includes("--no-coverage");
  const doJudge = !args.includes("--no-judge");

  const { createServerSupabaseClient } = await import("@/lib/supabase-server");
  const { runSearch } = await import("@/lib/job-search/pipeline");
  const { DEFAULT_CRITERIA } = await import("@/lib/job-search/types");
  const { detectRecruiter } = await import("@/lib/enrichment/recruiter-detect");
  const { normaliseCompanyName } = await import("@/lib/enrichment/normalise-company");
  const { embeddingsConfigured } = await import("@/lib/embeddings");
  const { embeddingColumnsAvailable } = await import("@/lib/job-search/schema-guard");

  const supabase = createServerSupabaseClient();

  // HONESTY GUARD 2: prove semantic CAN fire before we run a single search.
  if (!embeddingsConfigured()) { console.error("❌ embeddingsConfigured()=false — semantic axis would be OFF. Abort."); process.exit(2); }
  if (!(await embeddingColumnsAvailable(supabase))) { console.error("❌ embedding columns absent in DB — semantic axis would be OFF. Abort."); process.exit(2); }
  console.log("✅ preflight: all keys present; semantic axis is live.\n");

  // Clear any stale audit searches from a previous aborted run.
  {
    const { data: stale } = await supabase.from("job_searches").select("id").eq("user_id", TEST_USER_ID).like("name", "AUDIT:%");
    for (const s of stale ?? []) {
      await supabase.from("job_shortlist").delete().eq("search_id", s.id);
      await supabase.from("job_search_runs").delete().eq("search_id", s.id);
      await supabase.from("job_searches").delete().eq("id", s.id);
    }
    if (stale?.length) console.log(`(cleared ${stale.length} stale audit search(es))\n`);
  }

  const toRun = SEARCHES.filter((s) => !subset || subset.includes(s.id));
  const perSearch: any[] = [];
  // REGRESSION GATE. Invariant: kept > 0 ⇒ shortlisted > 0. The salary-int crash
  // violated it (searches #3/#6/#9 kept 22/38/54 jobs → shortlisted 0). This audit
  // runs DEFAULT_CRITERIA, whose selection pass drops nothing (all sizes accepted,
  // unknown kept, no recruiter/dimension filter), so kept>0 always implies at least
  // one job SHOULD reach the shortlist — a 0 there is a write crash, not a thin
  // market. Any violation fails the whole run (exit 3).
  const regressions: string[] = [];

  for (const s of toRun) {
    const t0 = Date.now();
    // A search with no postcode is a REMOTE search (place = "Remote (UK)"). It
    // must express remote intent the same way the editor does when the user picks
    // the Remote chip: working_model.accepted = ["remote"]. Without this the search
    // accepts all three models and is indistinguishable from "willing to relocate
    // anywhere" — which is the exact ambiguity defect #3 is about, and why office
    // roles UK-wide leaked in. Location-based searches keep the default (all three).
    const isRemoteSearch = s.postcode === null;
    const criteria: any = {
      ...DEFAULT_CRITERIA,
      keywords: s.keywords,
      target_titles: s.target_titles,
      working_model: isRemoteSearch
        ? { ...DEFAULT_CRITERIA.working_model, accepted: ["remote"] }
        : DEFAULT_CRITERIA.working_model,
      location: {
        ...DEFAULT_CRITERIA.location,
        postcode: s.postcode,
        filter_mode: s.postcode ? "distance" : "anywhere",
        max_distance_miles: s.postcode ? 25 : null,
        willing_to_relocate: !s.postcode,
      },
    };

    const { data: search, error: insErr } = await supabase
      .from("job_searches")
      .insert({ user_id: TEST_USER_ID, name: `AUDIT: ${s.label}`, description: null, criteria, active: true })
      .select("id").single();
    if (insErr) { console.error(`create search failed (${s.label}): ${insErr.message}`); continue; }
    const searchId = search!.id as string;

    const run = await runSearch({
      userId: TEST_USER_ID, searchId, name: s.label, description: null,
      criteria, jobsPerRun: TOP_N, trigger: "manual",
    });

    // Read back the top-N the user would actually see.
    const { data: rows } = await supabase
      .from("job_shortlist")
      .select("composite_rank, match_to_user_score, match_to_search_score, ranking_explanation, " +
        "job_postings(source, source_url, company, title, place_name, country_code, salary_min, salary_max, salary_listed, is_remote, working_model, location_raw)")
      .eq("search_id", searchId)
      .order("composite_rank", { ascending: false })
      .limit(TOP_N);

    // Run stats (supply + selection loss).
    const { data: runRow } = await supabase
      .from("job_search_runs")
      .select("source_counts, filter_drops, dedupe_stats, shortlist_count")
      .eq("id", run.runId!).single();

    const results = (rows ?? []).map((r: any) => {
      const jp = r.job_postings;
      const source = jp.source as string;
      const firstParty = ATS.has(source);
      const recruiter = firstParty ? false : detectRecruiter(null, jp.company).is_recruiter;
      const semanticFired = r.match_to_user_score !== null && r.match_to_user_score !== undefined;
      const re = r.ranking_explanation ?? {};
      const withinRadius = s.postcode
        ? (typeof re.distance_miles === "number" ? re.distance_miles <= 25 : (jp.is_remote ?? false))
        : true; // nationwide / remote search: distance not applicable
      const ukOk = jp.country_code == null || jp.country_code === "GB";
      const locationCorrect = ukOk && withinRadius;
      // Remote-intent evidence (defect #3): the job's stored working model, plus
      // whether the pipeline confirmed it remote (ranking_explanation.remote_*).
      const workingModel = (jp.working_model ?? "unknown") as string;
      const remoteConfirmed = re.remote_confirmed === true || jp.is_remote === true || workingModel === "remote";
      return {
        rank: r.composite_rank,
        source, firstParty, recruiter, semanticFired,
        company: jp.company as string,
        title: jp.title as string,
        place: (jp.place_name ?? jp.location_raw) as string | null,
        country_code: jp.country_code as string | null,
        working_model: workingModel,
        remoteConfirmed,
        distance_miles: typeof re.distance_miles === "number" ? re.distance_miles : null,
        salary_listed: (jp.salary_min ?? 0) > 0 || (jp.salary_max ?? 0) > 0,
        salary: salaryStr(jp.salary_min, jp.salary_max, !!jp.salary_listed),
        source_url: jp.source_url as string | null,
        match_to_user_score: r.match_to_user_score,
        match_to_search_score: r.match_to_search_score,
        locationCorrect, ukOk, withinRadius,
      };
    });

    // Liveness (real HTTP).
    const live = await livenessBatch(results.map((r) => r.source_url));
    results.forEach((r, i) => ((r as any).liveness = live[i].status, (r as any).http_code = live[i].code));

    // Duplicate detection within the surfaced set (company + title tokens + place).
    const seen = new Map<string, number>();
    results.forEach((r) => {
      const key = `${normaliseCompanyName(r.company)}|${r.title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()}|${(r.place ?? "").toLowerCase()}`;
      seen.set(key, (seen.get(key) ?? 0) + 1);
      (r as any)._dupKey = key;
    });
    results.forEach((r) => ((r as any).duplicate = (seen.get((r as any)._dupKey) ?? 0) > 1));

    // Relevance judge.
    const verdicts = doJudge
      ? await judgeRelevance(s, results.map((r) => ({ title: r.title, company: r.company, place: r.place, salary: r.salary, working_model: r.working_model })))
      : results.map(() => ({ verdict: "unjudged" as Verdict, reason: "" }));
    results.forEach((r, i) => ((r as any).relevance = verdicts[i]?.verdict, (r as any).relevance_reason = verdicts[i]?.reason));

    // Per-search metrics.
    const n = results.length;
    const onTarget = results.filter((r: any) => r.relevance === "on_target").length;
    const loose = results.filter((r: any) => r.relevance === "loosely_related").length;
    const off = results.filter((r: any) => r.relevance === "off_target").length;
    const dead = results.filter((r: any) => r.liveness === "dead" || r.liveness === "unreachable").length;
    const rec = results.filter((r: any) => r.recruiter).length;
    const dup = results.filter((r: any) => r.duplicate).length;
    const wrongLoc = results.filter((r: any) => !r.locationCorrect).length;
    const bullshit = results.filter((r: any) => r.recruiter || r.liveness === "dead" || r.liveness === "unreachable" || r.duplicate || !r.locationCorrect).length;
    const fp = results.filter((r: any) => r.firstParty).length;
    const sem = results.filter((r: any) => r.semanticFired).length;
    const salListed = results.filter((r: any) => r.salary_listed).length;
    // Remote-intent proof (defect #3): on a remote search this should be ~100%;
    // on a location search it is not meaningful (not enforced) — reported anyway.
    const remoteConfirmed = results.filter((r: any) => r.remoteConfirmed).length;

    const metrics = {
      n,
      relevance_on_target_pct: pct(onTarget, n),
      relevance_on_or_loose_pct: pct(onTarget + loose, n),
      off_target_pct: pct(off, n),
      remote_confirmed_pct: pct(remoteConfirmed, n),
      bullshit_rate_pct: pct(bullshit, n),
      recruiter_pct: pct(rec, n),
      dead_link_pct: pct(dead, n),
      duplicate_pct: pct(dup, n),
      wrong_location_pct: pct(wrongLoc, n),
      first_party_pct: pct(fp, n),
      aggregator_pct: pct(n - fp, n),
      semantic_fired_pct: pct(sem, n),
      salary_listed_pct: pct(salListed, n),
    };

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`#${s.id} ${s.label}  (${elapsed}s)`);
    console.log(`   supply: pulled=${run.pulled} deduped=${run.deduped} kept=${run.filtered} shortlisted=${run.shortlisted}  sources=${JSON.stringify(run.sourceCounts)}`);
    if (run.sourceWarnings?.length) console.log(`   ⚠️  warnings: ${JSON.stringify(run.sourceWarnings)}`);
    if (run.filtered > 0 && run.shortlisted === 0) {
      const msg = `#${s.id} ${s.label}: kept=${run.filtered} but shortlisted=0 — write crash (salary-int regression?)`;
      console.log(`   🔴 REGRESSION — ${msg}`);
      regressions.push(msg);
    }
    console.log(`   selection loss: ${JSON.stringify(runRow?.filter_drops)}`);
    console.log(`   RESULT (top ${n}): on=${onTarget} loose=${loose} off=${off} | bullshit=${bullshit} (rec=${rec} dead=${dead} dup=${dup} wrongLoc=${wrongLoc}) | 1stParty=${fp} semantic=${sem} salary=${salListed} remote=${remoteConfirmed}`);
    results.forEach((r: any, i) => {
      const flags = [r.firstParty ? "ATS" : r.source, r.recruiter ? "REC" : "", r.semanticFired ? "sem" : "", `wm:${r.working_model === "unknown" ? "?" : r.working_model}`, r.remoteConfirmed ? "REMOTE" : "", r.liveness !== "live" ? r.liveness.toUpperCase() : "", r.duplicate ? "DUP" : "", !r.locationCorrect ? "WRONGLOC" : ""].filter(Boolean).join(",");
      console.log(`      ${String(i + 1).padStart(2)}. [${r.relevance}] "${r.title}" @ ${r.company} — ${r.place ?? "?"} — ${r.salary}  {${flags}}  ${r.relevance_reason ? "// " + r.relevance_reason : ""}`);
    });
    console.log();

    perSearch.push({ search: s, metrics, run: { pulled: run.pulled, deduped: run.deduped, filtered: run.filtered, shortlisted: run.shortlisted, sourceCounts: run.sourceCounts, sourceWarnings: run.sourceWarnings, filter_drops: runRow?.filter_drops, dedupe_stats: runRow?.dedupe_stats }, results });

    // Cleanup this search.
    await supabase.from("job_shortlist").delete().eq("search_id", searchId);
    await supabase.from("job_search_runs").delete().eq("search_id", searchId);
    await supabase.from("job_searches").delete().eq("id", searchId);
  }

  // -------------------------------------------------- Adzuna coverage ----
  const coverage: any[] = [];
  if (doCoverage) {
    console.log("=".repeat(70));
    console.log("COVERAGE SPOT-CHECK (Adzuna ground-truth)\n");
    for (const id of COVERAGE_IDS) {
      const s = SEARCHES.find((x) => x.id === id)!;
      if (subset && !subset.includes(id)) continue;
      if (!s.adzunaWhere) continue;
      const az = await adzunaSearch(s.keywords, s.adzunaWhere);
      // First-party corpus depth for this role+place (direct corpus query).
      const like = `%${s.keywords.split(" ")[0]}%`;
      const { count: corpusCount } = await supabase
        .from("job_postings")
        .select("id", { count: "exact", head: true })
        .in("source", [...ATS])
        .ilike("title", like)
        .eq("place_name", s.adzunaWhere);
      // Judge Adzuna's top-20 for on-target (same judge).
      const azJudged = doJudge
        ? await judgeRelevance(s, az.results.map((r) => ({ title: r.title, company: r.company, place: r.place, salary: salaryStr(r.salary_min, r.salary_max, r.salary_min != null || r.salary_max != null) })))
        : az.results.map(() => ({ verdict: "unjudged" as Verdict, reason: "" }));
      const azOnTarget = az.results.filter((_, i) => azJudged[i]?.verdict === "on_target").length;
      const azRecruiters = az.results.filter((r) => detectRecruiter(null, r.company).is_recruiter).length;
      console.log(`#${s.id} ${s.label}`);
      console.log(`   Adzuna market: count=${az.count} (last 30d)  top20: on_target=${azOnTarget} recruiters=${azRecruiters}${az.error ? "  ERR=" + az.error : ""}`);
      console.log(`   Our first-party corpus depth (${s.adzunaWhere}, title~"${s.keywords.split(" ")[0]}"): ${corpusCount ?? "?"}\n`);
      coverage.push({ id, label: s.label, adzuna_count: az.count, adzuna_top20_on_target: azOnTarget, adzuna_top20_recruiters: azRecruiters, corpus_first_party_depth: corpusCount ?? null, adzuna_error: az.error });
    }
  }

  // ------------------------------------------------------- scoreboard ----
  const agg = (key: string) => {
    const vals = perSearch.map((p) => p.metrics[key]).filter((v) => typeof v === "number");
    return vals.length ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10 : 0;
  };
  console.log("=".repeat(70));
  console.log("SCOREBOARD (mean across searches)\n");
  console.log(`  relevance on-target:      ${agg("relevance_on_target_pct")}%`);
  console.log(`  relevance on+loose:       ${agg("relevance_on_or_loose_pct")}%`);
  console.log(`  off-target:               ${agg("off_target_pct")}%`);
  console.log(`  remote-confirmed:         ${agg("remote_confirmed_pct")}%   (remote searches only — enforced)`);
  console.log(`  BULLSHIT rate:            ${agg("bullshit_rate_pct")}%   (recruiter+dead+dup+wrongLoc)`);
  console.log(`    - recruiter:            ${agg("recruiter_pct")}%`);
  console.log(`    - dead link:            ${agg("dead_link_pct")}%`);
  console.log(`    - duplicate:            ${agg("duplicate_pct")}%`);
  console.log(`    - wrong location:       ${agg("wrong_location_pct")}%`);
  console.log(`  first-party (ATS):        ${agg("first_party_pct")}%`);
  console.log(`  aggregator:               ${agg("aggregator_pct")}%`);
  console.log(`  semantic fired:           ${agg("semantic_fired_pct")}%`);
  console.log(`  salary listed:            ${agg("salary_listed_pct")}%`);

  const outPath = resolve(process.cwd(), "scripts", `audit-results-latest.json`);
  const payload = {
    generated_at: new Date().toISOString(),
    top_n: TOP_N,
    scoreboard: {
      relevance_on_target_pct: agg("relevance_on_target_pct"),
      relevance_on_or_loose_pct: agg("relevance_on_or_loose_pct"),
      off_target_pct: agg("off_target_pct"),
      remote_confirmed_pct: agg("remote_confirmed_pct"),
      bullshit_rate_pct: agg("bullshit_rate_pct"),
      recruiter_pct: agg("recruiter_pct"),
      dead_link_pct: agg("dead_link_pct"),
      duplicate_pct: agg("duplicate_pct"),
      wrong_location_pct: agg("wrong_location_pct"),
      first_party_pct: agg("first_party_pct"),
      aggregator_pct: agg("aggregator_pct"),
      semantic_fired_pct: agg("semantic_fired_pct"),
      salary_listed_pct: agg("salary_listed_pct"),
    },
    per_search: perSearch,
    coverage,
  };
  writeFileSync(outPath, JSON.stringify(payload, null, 2));
  console.log(`\nRaw results -> ${outPath}`);

  // REGRESSION GATE — fail loudly if the kept>0 ⇒ shortlisted>0 invariant broke.
  if (regressions.length) {
    console.error(`\n🔴 ${regressions.length} REGRESSION(S) — kept>0 but shortlisted=0 (the salary-int crash class):`);
    for (const r of regressions) console.error(`   - ${r}`);
    process.exit(3);
  }
  console.log(`\n✅ regression gate: every search with kept>0 also shortlisted>0.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
