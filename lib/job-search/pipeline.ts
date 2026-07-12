// Pull -> normalise -> dedupe -> hard-filter -> rank -> insert.
// Cheap axes only for now. Match-to-user + career-fit (LLM) added in next iteration.

import { createServerSupabaseClient } from "@/lib/supabase-server";
import type { SearchCriteria, FilterableWorkingModel, CommuteMode } from "./types";
import { normalise, type NormalisedJob } from "./normalise";
import { reedAdapter } from "./sources/reed";
import { adzunaAdapter } from "./sources/adzuna";
import type { JobSourceAdapter, PullInput } from "./types";
import { extractSearchTerms } from "./title-suggestions";
import { enrichBatch } from "@/lib/enrichment/batch";
import { normaliseCompanyName } from "@/lib/enrichment/normalise-company";

export interface RunSearchInput {
  userId: string;
  searchId: string;
  name: string;
  description: string | null;
  criteria: SearchCriteria;
  jobsPerRun: number;
  trigger: "manual" | "scheduled";
}

export type TermsSource = "keywords" | "target_titles" | "description" | "browse";

export interface RunSearchResult {
  shortlisted: number;
  pulled: number;
  deduped: number;
  filtered: number;
  runId: string | null;
  error?: string;
  searchTermsUsed?: string[];
  termsDerivedFrom?: TermsSource;
}

// Resolve what to actually send to the job APIs. The search NAME is a label,
// never a query. Priority: user's explicit keywords → explicit target titles
// → terms extracted from the description. If none of those produce anything,
// we run in BROWSE mode — no keyword sent to the APIs, the pull is driven by
// location + salary + working-model filters. A "general" search of the form
// "hybrid, decent pay, 40 miles from home" is legitimate and should return
// jobs across sectors, not fail.
function resolveSearchTerms(
  criteria: SearchCriteria,
  description: string | null
): { terms: string; source: TermsSource; extracted?: string[] } {
  const kw = (criteria.keywords ?? "").trim();
  if (kw) return { terms: kw, source: "keywords" };
  if (criteria.target_titles?.length) {
    return { terms: criteria.target_titles.join(", "), source: "target_titles" };
  }
  const extracted = extractSearchTerms(description ?? "");
  if (extracted.length) {
    return { terms: extracted.join(", "), source: "description", extracted };
  }
  return { terms: "", source: "browse" };
}

// Mode-aware minutes → straight-line miles. Assumed average speeds:
//   car          30 mph  (motorway/A-road mix, off-peak)
//   public       18 mph  (bus/train + walk to station)
//   cycle        12 mph  (urban commuter pace)
// These are approximations — actual per-postcode commute lives behind the
// Google Distance Matrix wiring in step 6 of the build order.
const COMMUTE_MPH: Record<CommuteMode, number> = {
  car: 30,
  public_transport: 18,
  cycle: 12,
};

function resolveRadiusMiles(loc: SearchCriteria["location"]): number | null {
  if (loc.willing_to_relocate) return null;
  const mode = loc.filter_mode ?? "distance";
  if (mode === "anywhere") return null;
  if (mode === "commute" && loc.max_commute_minutes) {
    const mph = COMMUTE_MPH[loc.commute_mode] ?? 20;
    return Math.max(1, Math.round((loc.max_commute_minutes / 60) * mph));
  }
  if (mode === "distance" && loc.max_distance_miles) {
    return Math.max(1, Math.round(loc.max_distance_miles));
  }
  // Legacy row without an explicit mode set — fall back to whichever value
  // is populated (older rows only stored max_commute_minutes).
  if (loc.max_distance_miles) return Math.max(1, Math.round(loc.max_distance_miles));
  if (loc.max_commute_minutes) {
    const mph = COMMUTE_MPH[loc.commute_mode] ?? 20;
    return Math.max(1, Math.round((loc.max_commute_minutes / 60) * mph));
  }
  return loc.fallback_radius_miles;
}

// Tokenise a free-text field into content words. Cheap, no dependencies.
const STOPWORDS = new Set([
  "the","a","an","and","or","of","to","in","for","with","on","at","by","from","as","is","are",
  "be","been","being","this","that","these","those","i","you","we","they","it","my","our","your",
  "will","would","should","can","have","has","had","do","does","did","not","but","if","then","so",
  "job","role","position","company","team","work","working","experience","looking","looking",
]);

// Stopwords used specifically for TITLE-relevance filtering. Kept short —
// don't strip content words we care about (analyst, driver, engineer, etc.).
const TITLE_STOP = new Set(["the","a","an","and","or","of","to","in","for","with","on","at","by","from","-"]);

// Words that mark seniority, not role type. Stripped from the chip during
// title matching so "Senior Data Analyst" filters the same as "Data Analyst"
// but "Head of Marketing" still requires Head (Head IS the role type here).
const SENIORITY_MARKERS = new Set([
  "junior", "senior", "entry", "mid", "graduate", "intern", "trainee",
  "apprentice", "experienced", "level", "principal", "staff",
]);

// Light stemmer for job-title matching. Strips common English plural and
// gerund suffixes so "Analysts" ~ "Analyst", "Buyers" ~ "Buyer",
// "Managing" ~ "Manage". Keeps short words untouched.
// See feedback_input_tolerance_saas — every match is case-insensitive
// and stem-normalised, otherwise real users get zero results from a plural.
function stemWord(w: string): string {
  const s = w.toLowerCase();
  if (s.length < 5) return s;
  if (s.endsWith("ies") && s.length > 5) return s.slice(0, -3) + "y";
  if (s.endsWith("sses")) return s.slice(0, -2);
  if (s.endsWith("s") && !s.endsWith("ss") && !s.endsWith("us") && !s.endsWith("is")) return s.slice(0, -1);
  if (s.endsWith("ing") && s.length > 6) return s.slice(0, -3);
  if (s.endsWith("ed") && s.length > 5) return s.slice(0, -2);
  return s;
}

// Does the title contain `word` (or its stem)? Both sides are stem-compared,
// so "Analysts"/"Analyst" and "Buyers"/"Buyer" match either way.
function titleContainsStem(titleLower: string, word: string): boolean {
  const wordStem = stemWord(word);
  // Whole-word regex; then stem-compare each hit / miss.
  if (new RegExp(`\\b${word}\\b`, "i").test(titleLower)) return true;
  // Search stems of each title word.
  for (const t of titleLower.split(/[^a-z0-9]+/)) {
    if (t && stemWord(t) === wordStem) return true;
  }
  return false;
}

// True if a job title is relevant to a target chip. The rule:
//   1. Full-phrase substring match (highest signal) → accept.
//   2. Strip seniority markers (senior, junior, entry, mid, graduate, etc.).
//   3. If 1 content word remains: title must contain it (stem-matched).
//      "Analyst" chip → any Analyst title.
//   4. If 2+ content words remain: LAST is the role noun, the rest are
//      qualifiers. Title must contain the role noun AND at least one
//      qualifier. This prevents "Marketing Manager" from matching a
//      "Construction Site Manager" chip via bare "manager", while still
//      accepting "Site Manager" (role=manager, has qualifier "site") and
//      "Construction Manager" (role=manager, has qualifier "construction").
//   5. If the chip is pure seniority (e.g. "Senior"), fall back to matching
//      any of those words in the title.
function titleRelevantOne(title: string, phrase: string, askWords: string[]): boolean {
  const t = title.toLowerCase();
  if (phrase && t.includes(phrase)) return true;
  if (!askWords.length) return true;

  const contentWords = askWords.filter((w) => !SENIORITY_MARKERS.has(w));

  if (contentWords.length === 0) {
    return askWords.some((w) => titleContainsStem(t, w));
  }

  if (contentWords.length === 1) {
    return titleContainsStem(t, contentWords[0]);
  }

  const roleNoun = contentWords[contentWords.length - 1];
  const qualifiers = contentWords.slice(0, -1);
  if (!titleContainsStem(t, roleNoun)) return false;
  return qualifiers.some((q) => titleContainsStem(t, q));
}

// True if the job title matches ANY of the user's target phrases. Multi-role
// search — e.g. accept jobs matching "supply chain analyst" OR "buyer".
function titleRelevantAny(title: string, targets: Array<{ phrase: string; words: string[] }>): boolean {
  return targets.some((t) => titleRelevantOne(title, t.phrase, t.words));
}

function tokens(s: string): string[] {
  return s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

// Cheap keyword-based match-to-search axis: how well does this job match what
// the user asked for? Title hits weighted heavier than JD hits; description
// terms weighted heavier than the raw keywords string.
function matchToSearchScore(
  j: NormalisedJob,
  criteria: SearchCriteria,
  searchName: string,
  description: string | null | undefined
): { score: number; hits: string[] } {
  const askTerms = new Set([
    ...tokens(criteria.keywords || ""),
    ...tokens(searchName || ""),
    ...tokens(description || ""),
  ]);
  if (askTerms.size === 0) return { score: 50, hits: [] };

  const titleTokens = new Set(tokens(j.title));
  const jdTokens = new Set(tokens(j.jd_text));

  const titleHits: string[] = [];
  const jdHits: string[] = [];
  for (const t of askTerms) {
    if (titleTokens.has(t)) titleHits.push(t);
    else if (jdTokens.has(t)) jdHits.push(t);
  }

  const titleCoverage = titleHits.length / askTerms.size;
  const jdCoverage = jdHits.length / askTerms.size;
  // Weight title matches 3x JD matches. Full title coverage caps at 100.
  const raw = titleCoverage * 75 + jdCoverage * 40;
  const score = Math.max(0, Math.min(100, Math.round(raw)));
  return { score, hits: [...titleHits, ...jdHits].slice(0, 8) };
}

// Salary vs target — used as a soft signal, not a hard rank axis.
function salaryFitScore(j: NormalisedJob, criteria: SearchCriteria): number {
  const target = criteria.salary.target;
  const salaryMid = j.salary_min && j.salary_max
    ? (j.salary_min + j.salary_max) / 2
    : (j.salary_min ?? j.salary_max ?? null);
  if (!target || !salaryMid) return j.salary_listed ? 60 : 40;
  if (salaryMid >= target) return 100;
  return Math.max(20, Math.round((salaryMid / target) * 100));
}

// Composite: match-to-search 45% + quality 35% + salary-fit 20%.
// (match-to-user + career-fit come online in the next step and take share
// from quality + salary-fit.)
function cheapRankScore(
  j: NormalisedJob,
  criteria: SearchCriteria,
  searchName: string,
  description: string | null | undefined
): { composite: number; match_to_search: number; quality: number; salary_fit: number; hits: string[] } {
  const mts = matchToSearchScore(j, criteria, searchName, description);
  const q = j.quality_score ?? 50;
  const sf = salaryFitScore(j, criteria);
  const composite = Math.round(mts.score * 0.45 + q * 0.35 + sf * 0.20);
  return {
    composite,
    match_to_search: mts.score,
    quality: q,
    salary_fit: sf,
    hits: mts.hits,
  };
}

export async function runSearch(input: RunSearchInput): Promise<RunSearchResult> {
  const supabase = createServerSupabaseClient();

  const runInsert = await supabase
    .from("job_search_runs")
    .insert({
      user_id: input.userId,
      search_id: input.searchId,
      trigger: input.trigger,
    })
    .select("id")
    .single();
  const runId = runInsert.data?.id ?? null;

  const sourceCounts: Record<string, number> = {};
  const filterDrops: Record<string, number> = {
    salary_floor: 0, working_model: 0, hidden_salary: 0, industry_exclude: 0,
    expired: 0, already_decided: 0,
    // Post-enrichment filters (recorded during upsert phase, not the hard-filter phase).
    company_size: 0, recruiter: 0,
  };
  const allRaw: NormalisedJob[] = [];

  // Cross-search "already decided" gate. Jobs the user has explicitly
  // rejected / marked interested / applied to / deleted stay hidden across
  // every future search — one decision is enough. Transient "new" rows do
  // NOT block, so deleting a search (which cascade-wipes its 'new' rows)
  // frees those jobs to resurface, which is what makes iterative testing
  // bearable. Match by (source, source_id) — the stable identity of a
  // posting across runs.
  const DECIDED_STATES = ["rejected_user", "rejected_employer", "interested", "applied", "deleted"] as const;
  const decidedKeys = new Set<string>();
  {
    const { data: decidedRows } = await supabase
      .from("job_shortlist")
      .select("posting_id")
      .eq("user_id", input.userId)
      .in("state", DECIDED_STATES as unknown as string[]);
    const decidedPostingIds = (decidedRows ?? []).map((r) => r.posting_id as string);
    if (decidedPostingIds.length) {
      const { data: postings } = await supabase
        .from("job_postings")
        .select("source, source_id")
        .in("id", decidedPostingIds);
      for (const p of postings ?? []) {
        if (p.source && p.source_id) decidedKeys.add(`${p.source}|${p.source_id}`);
      }
    }
  }

  const resolved = resolveSearchTerms(input.criteria, input.description);
  const keywords = resolved.terms;
  const isBrowseMode = resolved.source === "browse";

  // ---- Fan out across sources in parallel ----
  // Every adapter shares the same PullInput. Cross-source dedupe runs below.
  const radius = resolveRadiusMiles(input.criteria.location);
  const isNationwide =
    input.criteria.location.willing_to_relocate ||
    input.criteria.location.filter_mode === "anywhere";
  const pullInput: PullInput = {
    keywords,
    locationText: isNationwide ? null : input.criteria.location.postcode,
    postcode: input.criteria.location.postcode,
    radiusMiles: isNationwide ? null : radius,
    minSalary: input.criteria.salary.floor,
    maxSalary: null,
    limit: Math.max(50, input.jobsPerRun * 5),
    sinceDate: null,
  };

  const sources: JobSourceAdapter[] = [reedAdapter, adzunaAdapter];
  const settled = await Promise.allSettled(sources.map((s) => s.pull(pullInput)));
  for (let i = 0; i < sources.length; i++) {
    const type = sources[i].type;
    const r = settled[i];
    if (r.status !== "fulfilled") {
      console.error(`[runSearch] ${type} pull threw`, r.reason);
      sourceCounts[type] = 0;
      continue;
    }
    sourceCounts[type] = r.value.jobs.length;
    if (r.value.error) console.error(`[runSearch] ${type} error:`, r.value.error);
    for (const j of r.value.jobs) allRaw.push(normalise(j));
  }

  const pulled = allRaw.length;

  // ---- Dedupe within the run ----
  const seenHashes = new Set<string>();
  const deduped: NormalisedJob[] = [];
  for (const j of allRaw) {
    if (!seenHashes.has(j.dedupe_hash)) {
      seenHashes.add(j.dedupe_hash);
      deduped.push(j);
    }
  }

  // ---- Hard filters ----
  const kept: NormalisedJob[] = [];
  const now = Date.now();
  const acceptedWM = new Set<FilterableWorkingModel>(input.criteria.working_model.accepted);
  const includeUnknownWM = input.criteria.working_model.include_unknown;
  const excludes = input.criteria.industries_exclude.map((s) => s.toLowerCase());

  // Title-relevance hard filter. Uses the explicit `target_titles` list if
  // the user set one (multi-role searches like ["supply chain analyst",
  // "procurement analyst", "buyer"]). Falls back to splitting the keywords
  // string on the same separators the target_titles input accepts. Never
  // uses the search NAME — the name is a label, not a query. In BROWSE mode
  // (no keywords, no titles, no description-derived terms) targetSets stays
  // empty and this filter becomes a no-op — the pull is filter-driven only.
  const rawTargets = input.criteria.target_titles?.length
    ? input.criteria.target_titles
    : (input.criteria.keywords ?? "")
        .split(/[,/\n]+|\s+and\s+/gi)
        .map((s) => s.trim())
        .filter(Boolean);
  const targetSets = rawTargets
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean)
    .map((phrase) => ({
      phrase,
      words: phrase.split(/\s+/).filter((w) => w.length > 2 && !TITLE_STOP.has(w)),
    }));
  filterDrops.title_irrelevant = 0;

  for (const j of deduped) {
    if (decidedKeys.has(`${j.source}|${j.source_id}`)) {
      filterDrops.already_decided++;
      continue;
    }
    if (j.expires_at && new Date(j.expires_at).getTime() < now) {
      filterDrops.expired++;
      continue;
    }
    if (targetSets.length && !titleRelevantAny(j.title, targetSets)) {
      filterDrops.title_irrelevant++;
      continue;
    }
    if (input.criteria.salary.floor && j.salary_max !== null && j.salary_max < input.criteria.salary.floor) {
      filterDrops.salary_floor++;
      continue;
    }
    if (input.criteria.salary.drop_hidden_salary && !j.salary_listed) {
      filterDrops.hidden_salary++;
      continue;
    }
    if (j.working_model === "unknown") {
      if (!includeUnknownWM) {
        filterDrops.working_model++;
        continue;
      }
    } else if (!acceptedWM.has(j.working_model as FilterableWorkingModel)) {
      filterDrops.working_model++;
      continue;
    }
    if (excludes.length) {
      const hay = `${j.company} ${j.title} ${j.jd_text}`.toLowerCase();
      if (excludes.some((x) => x && hay.includes(x))) {
        filterDrops.industry_exclude++;
        continue;
      }
    }
    kept.push(j);
  }

  // ---- Cheap ranking ----
  // Look up the search description once for match-to-search axis.
  const { data: searchRow } = await supabase
    .from("job_searches")
    .select("description")
    .eq("id", input.searchId)
    .single();
  const description = (searchRow?.description as string | null | undefined) ?? null;

  const ranked = kept
    .map((j) => ({ j, r: cheapRankScore(j, input.criteria, input.name, description) }))
    .sort((a, b) => b.r.composite - a.r.composite);

  // ---- Companies House enrichment (best-effort, budget-capped) ----
  //
  // We enrich a MUCH bigger pool than jobsPerRun so the size + recruiter
  // filters have room to work. If a user asks for 10 mid/large/enterprise
  // jobs, we can't just enrich the top-10 by rank — most of those will be
  // small businesses posting on Reed/Adzuna. Enrich the top-K by rank (K=50)
  // and let the filter loop below pick the top-N survivors.
  //
  // Budget: 45s (Vercel function has 60s max via /roles page-level
  // maxDuration). Cached rows are near-instant (~200ms each); only fresh CH
  // fetches burn real budget (~5s each). If budget runs out, remaining
  // companies stay un-enriched → filter treats them as size=unknown.
  const ENRICH_POOL_MAX = 50;
  const enrichPoolLen = Math.min(ENRICH_POOL_MAX, ranked.length);
  const enrichPool = ranked.slice(0, enrichPoolLen);
  const uniqueCompanies = Array.from(new Set(enrichPool.map(({ j }) => j.company).filter(Boolean)));
  const enrichmentResult = await enrichBatch(uniqueCompanies, 45_000);
  const enrichmentByNorm = enrichmentResult.byNormalisedName;
  console.log(
    `[runSearch] enrichment stats: pool=${enrichPoolLen} unique=${uniqueCompanies.length} ` +
    `processed=${enrichmentResult.stats.processed} deferred=${enrichmentResult.stats.deferred} ` +
    `elapsed=${enrichmentResult.stats.elapsed_ms}ms`
  );

  // ---- Upsert postings + shortlist ----
  // Look up which posting_ids already sit on this user's shortlist for this
  // search — so we can UPDATE ranking without resurrecting rows the user has
  // already decided on (rejected/applied/etc.).
  const existingByPosting = new Map<string, { id: string; state: string }>();
  {
    const { data: existing } = await supabase
      .from("job_shortlist")
      .select("id, posting_id, state")
      .eq("user_id", input.userId)
      .eq("search_id", input.searchId);
    for (const row of existing ?? []) existingByPosting.set(row.posting_id as string, { id: row.id as string, state: row.state as string });
  }

  // Company-size + recruiter filters. Applied at upsert time because they
  // depend on enrichment data we just fetched. Postings that don't yet have
  // an enrichment row are treated as size='unknown' — filtered per the
  // user's include_unknown flag (defaults on).
  const acceptedSizes = new Set<string>(input.criteria.company_size?.accepted ?? []);
  const includeUnknownSize = input.criteria.company_size?.include_unknown ?? true;
  const hideRecruiters = input.criteria.hide_recruiters === true;

  // Per-bucket drop breakdown so we can tell the user WHICH sizes were filtered.
  const sizeDropByBucket: Record<string, number> = {
    startup: 0, small: 0, mid: 0, large: 0, enterprise: 0, unknown: 0,
  };

  // Iterate the FULL ranked list. For each candidate:
  //   1. Upsert to job_postings (ALWAYS — so its enrichment_id persists and
  //      future runs / after()-sweeps have a stable record). This keeps the
  //      pipeline stateful across runs, so cache warmth grows monotonically.
  //   2. Apply size + recruiter filter.
  //   3. If passes filter AND we haven't hit jobsPerRun yet, upsert to
  //      job_shortlist.
  //   4. Stop iterating when the shortlist target is reached (no wasted work
  //      past that point).
  let shortlisted = 0;
  for (let i = 0; i < ranked.length && shortlisted < input.jobsPerRun; i++) {
    const { j, r } = ranked[i];
    const normalisedCompany = normaliseCompanyName(j.company);
    const enrichment = normalisedCompany ? enrichmentByNorm.get(normalisedCompany) : null;

    // Company-size filter (recorded but doesn't skip the job_postings upsert).
    const bucket = (enrichment?.size_bucket as string | null) ?? "unknown";
    const bucketKnown = bucket !== "unknown" && !!enrichment;
    let passesFilter = true;
    if (bucketKnown) {
      if (acceptedSizes.size > 0 && !acceptedSizes.has(bucket)) {
        passesFilter = false;
        filterDrops.company_size++;
        sizeDropByBucket[bucket] = (sizeDropByBucket[bucket] ?? 0) + 1;
      }
    } else {
      if (!includeUnknownSize) {
        passesFilter = false;
        filterDrops.company_size++;
        sizeDropByBucket.unknown++;
      }
    }
    if (passesFilter && hideRecruiters && enrichment?.is_likely_recruiter) {
      passesFilter = false;
      filterDrops.recruiter++;
    }

    const upsert = await supabase
      .from("job_postings")
      .upsert(
        {
          source: j.source,
          source_id: j.source_id,
          source_url: j.source_url,
          company: j.company,
          title: j.title,
          location_raw: j.location_raw,
          working_model: j.working_model,
          hybrid_days_office: j.hybrid_days_office,
          salary_min: j.salary_min,
          salary_max: j.salary_max,
          salary_currency: j.salary_currency,
          salary_listed: j.salary_listed,
          jd_text: j.jd_text,
          jd_html: j.jd_html,
          posted_at: j.posted_at,
          expires_at: j.expires_at,
          dedupe_hash: j.dedupe_hash,
          quality_score: j.quality_score,
          normalised_company_name: normalisedCompany || null,
          enrichment_id: enrichment?.id ?? null,
          last_seen_at: new Date().toISOString(),
        },
        { onConflict: "source,source_id" }
      )
      .select("id")
      .single();
    if (upsert.error || !upsert.data) {
      console.error("[runSearch] posting upsert failed", upsert.error);
      continue;
    }
    const posting_id = upsert.data.id;

    // If the posting was upserted but failed the size/recruiter filter, skip
    // the shortlist step. The job_postings row still persists so its
    // enrichment_id (and any future re-derivations) live on.
    if (!passesFilter) continue;

    const rankingPayload = {
      quality_score: r.quality,
      match_to_search_score: r.match_to_search,
      composite_rank: r.composite,
      ranking_explanation: {
        phase: "cheap-only",
        note: "Match-to-search + quality + salary-fit. Match-to-you + career-fit come online next.",
        match_to_search: r.match_to_search,
        quality: r.quality,
        salary_fit: r.salary_fit,
        keyword_hits: r.hits,
        quality_reasons: j.quality_reasons,
        rank_position: i + 1,
        of: ranked.length,
      },
    } as const;

    const existing = existingByPosting.get(posting_id);
    if (existing) {
      // Preserve the user's decision (rejected/applied/interested/deleted).
      // Just refresh ranking scores so re-runs update stale positions.
      const short = await supabase
        .from("job_shortlist")
        .update(rankingPayload)
        .eq("id", existing.id);
      if (short.error) console.error("[runSearch] shortlist update failed", short.error);
      else shortlisted++;
    } else {
      const short = await supabase
        .from("job_shortlist")
        .insert({
          user_id: input.userId,
          search_id: input.searchId,
          posting_id,
          state: "new",
          ...rankingPayload,
        })
        .select("id");
      if (short.error) console.error("[runSearch] shortlist insert failed", short.error);
      else shortlisted++;
    }
  }

  const searchTermsUsed: string[] =
    resolved.source === "keywords"
      ? [keywords]
      : resolved.source === "target_titles"
      ? input.criteria.target_titles ?? []
      : resolved.source === "description"
      ? resolved.extracted ?? []
      : []; // browse mode — no query terms
  void isBrowseMode; // reserved for adapter-specific handling; currently
                      // adapters already treat empty keywords as browse.

  await supabase
    .from("job_search_runs")
    .update({
      finished_at: new Date().toISOString(),
      source_counts: sourceCounts,
      dedupe_stats: {
        before: pulled,
        after: deduped.length,
        search_terms: searchTermsUsed,
        terms_source: resolved.source,
        enrichment: enrichmentResult.stats,
        size_drops_by_bucket: sizeDropByBucket,
        ranked_pool: ranked.length,
        jobs_per_run_target: input.jobsPerRun,
      },
      filter_drops: filterDrops,
      shortlist_count: shortlisted,
    })
    .eq("id", runId!);

  await supabase
    .from("job_searches")
    .update({ last_run_at: new Date().toISOString() })
    .eq("id", input.searchId);

  return {
    shortlisted,
    pulled,
    deduped: deduped.length,
    filtered: kept.length,
    runId,
    searchTermsUsed,
    termsDerivedFrom: resolved.source,
  };
}
