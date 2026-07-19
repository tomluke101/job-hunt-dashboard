// Pull -> normalise -> geo -> cross-source dedupe -> hard-filter -> rank -> insert.
//
// SUPPLY (2026-07-12): three sources, not two.
//   • ATS CORPUS  — first-party jobs straight from employers' own Greenhouse /
//     Lever / Ashby / SmartRecruiters / Recruitee / Workday boards. Served from
//     the LOCAL corpus that lib/ats/ingest.ts fills in the background, because an
//     ATS board has no keyword or radius parameter — you get the company's entire
//     global board or nothing, so it cannot be polled per-search. Zero recruiters
//     by construction. This is the moat.
//   • Reed, Adzuna — commodity aggregators. Breadth. Every competitor has them too.
//
// Two things ATS supply forced into existence, both of which fix latent bugs that
// pre-dated it:
//   1. A REAL POST-PULL DISTANCE FILTER (lib/geo). There was none: the pipeline
//      trusted each source's server-side radius search. ATS boards vouch for
//      nothing — Palantir's board offers Seoul and Palo Alto next to London.
//   2. CROSS-SOURCE DEDUPE (lib/job-search/canonical.ts). The same role now
//      arrives via Reed AND Adzuna AND the employer's own board. `dedupe_hash`
//      cannot see that — it hashes the JD text, and every source rewrites the JD.

import { createServerSupabaseClient } from "@/lib/supabase-server";
import type { SearchCriteria, FilterableWorkingModel, CommuteMode } from "./types";
import { hasTrustedRadius, isAtsSource, readDimensionFilter } from "./types";
import { normalise, type NormalisedJob } from "./normalise";
import { reedAdapter } from "./sources/reed";
import { adzunaAdapter } from "./sources/adzuna";
import { pullFromCorpus } from "./sources/ats-corpus";
import type { JobSourceAdapter, PullInput, SourceType } from "./types";
import { extractSearchTerms } from "./title-suggestions";
import { enrichBatch } from "@/lib/enrichment/batch";
import { normaliseCompanyName } from "@/lib/enrichment/normalise-company";
import { detectRecruiter } from "@/lib/enrichment/recruiter-detect";
import { buildTargets, titleRelevantAny, type TargetTitle } from "./title-match";
import { classifyJob } from "./classify";
import { canonicalKey, dedupeByCanonicalKey } from "./canonical";
import { parseSalaryFromText } from "./salary-parse";
import { atsColumnsAvailable, embeddingColumnsAvailable } from "./schema-guard";
import { ensureSearchEmbedding } from "./search-embedding";
import { embeddingsConfigured, semanticScoreFromSimilarity } from "@/lib/embeddings";
import {
  resolveOrigin,
  resolveJobLocation,
  distanceMiles,
  type GeoPoint,
  type JobLocation,
} from "@/lib/geo";

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
  /** Per-source pull counts. Surfaced so a source silently returning ZERO can
   *  never again masquerade as "no jobs matched" — see the Adzuna incident. */
  sourceCounts?: Record<string, number>;
  sourceWarnings?: string[];
}

// Resolve what to actually send to the job APIs. The search NAME is a label,
// never a query. Priority: user's explicit keywords → explicit target titles
// → terms extracted from the description. If none of those produce anything,
// we run in BROWSE mode — no keyword sent to the APIs, the pull is driven by
// location + salary + working-model filters.
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

/**
 * How much the semantic (embedding) axis moves the final rank.
 *
 * The cheap composite already encodes title precision, JD quality, salary fit and
 * the first-party bonus — signal we do NOT want a fuzzy vector match to override
 * wholesale. So semantic RE-RANKS within the heuristically-good set rather than
 * replacing it: at 0.35 a strong semantic match can lift a job several places, but
 * a job with a wrong title (already gated out upstream) can't semantic its way in.
 *
 * A job with no embedding (every aggregator job, and any corpus job not yet
 * backfilled) keeps its cheap composite unblended — it is scored on what we know,
 * never penalised for a signal we simply don't have for it.
 */
const SEMANTIC_WEIGHT = 0.35;

/**
 * Must-have boost.
 *
 * The AI parse (lib/job-search/ai-parse.ts) turns "with a strong training programme"
 * in the user's description into a must_have. When a job description actually mentions
 * it, that is a real, specific reason this role fits the user better than one that
 * doesn't — so it earns a small, bounded, EXPLAINED nudge, surfaced on the card as
 * "matches what you asked for: training programme".
 *
 * It is a bonus, never a filter (silent-drop rule): a job that matches none of the
 * must-haves simply gets no boost, it is not removed. Additive to the semantic axis
 * and capped, so it can lift a genuinely-matching job a few places without letting a
 * keyword coincidence override title precision or meaning-match.
 */
const MUST_HAVE_BONUS_EACH = 3;
const MUST_HAVE_BONUS_MAX = 9;

function matchMustHaves(j: NormalisedJob, mustHaves: string[]): string[] {
  if (!mustHaves.length) return [];
  const hay = `${j.title}\n${j.jd_text}`.toLowerCase();
  const seen = new Set<string>();
  const hits: string[] = [];
  for (const m of mustHaves) {
    const phrase = m.trim();
    const needle = phrase.toLowerCase();
    // Guard against a 1-2 char must-have matching everything.
    if (needle.length < 3 || seen.has(needle)) continue;
    if (hay.includes(needle)) {
      seen.add(needle);
      hits.push(phrase);
    }
  }
  return hits;
}

// Mode-aware minutes → straight-line miles.
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
  if (loc.max_distance_miles) return Math.max(1, Math.round(loc.max_distance_miles));
  if (loc.max_commute_minutes) {
    const mph = COMMUTE_MPH[loc.commute_mode] ?? 20;
    return Math.max(1, Math.round((loc.max_commute_minutes / 60) * mph));
  }
  return loc.fallback_radius_miles;
}

const STOPWORDS = new Set([
  "the","a","an","and","or","of","to","in","for","with","on","at","by","from","as","is","are",
  "be","been","being","this","that","these","those","i","you","we","they","it","my","our","your",
  "will","would","should","can","have","has","had","do","does","did","not","but","if","then","so",
  "job","role","position","company","team","work","working","experience","looking",
]);

function tokens(s: string): string[] {
  return s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

// Cheap keyword-based match-to-search axis.
//
// Title hits are weighted far above JD hits ON PURPOSE. Reed keyword-matches the
// JD BODY, so a query for "supply chain analyst" comes back with Class 2 HGV
// Driver ads whose JD merely mentions a supply chain. The hard title filter bins
// most of those; this weighting makes sure any that survive still rank beneath a
// genuine title match rather than winning on a wall of incidental keywords.
//
// The "ask" is exactly what the user told us they want: keywords, target titles
// and the free-text description. The search NAME is NOT in it — it is a label the
// user files the search under ("just for you"), never a query, so it must not move
// any job's rank. (Before this it leaked in here, so naming a search "Birmingham
// roles" quietly boosted every job mentioning Birmingham.) The doctrine matches
// resolveSearchTerms() and buildQueryEmbeddingInput(), which also exclude the name.
function matchToSearchScore(
  j: NormalisedJob,
  criteria: SearchCriteria,
  description: string | null | undefined
): { score: number; hits: string[] } {
  const askTerms = new Set([
    ...tokens(criteria.keywords || ""),
    ...tokens((criteria.target_titles ?? []).join(" ")),
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
  const raw = titleCoverage * 80 + jdCoverage * 25;
  const score = Math.max(0, Math.min(100, Math.round(raw)));
  return { score, hits: [...titleHits, ...jdHits].slice(0, 8) };
}

function salaryFitScore(j: NormalisedJob, criteria: SearchCriteria): number {
  const target = criteria.salary.target;
  const salaryMid = j.salary_min && j.salary_max
    ? (j.salary_min + j.salary_max) / 2
    : (j.salary_min ?? j.salary_max ?? null);
  if (!target || !salaryMid) return j.salary_listed ? 60 : 40;
  if (salaryMid >= target) return 100;
  return Math.max(20, Math.round((salaryMid / target) * 100));
}

/**
 * First-party bonus. A job straight from the employer's own ATS is strictly
 * better than the same job seen through an aggregator: you apply on the
 * employer's site rather than through a middleman, the JD is the real one, the
 * employer is the actual employer (not "Client of Hays"), and it appeared the
 * hour it was posted. That is a genuine quality difference and the ranking
 * should say so.
 */
function firstPartyBonus(source: SourceType): number {
  return isAtsSource(source) ? 8 : 0;
}

/**
 * Recruiter penalty.
 *
 * The first-party BONUS existed; the recruiter PENALTY did not — so an agency job
 * competed on equal terms and, on a live search, a recruiter ("Bright Executive")
 * ranked FIRST, above Aldi and ZEISS. `hide_recruiters` is a hard filter and
 * defaults to OFF (plenty of users are happy to see agency roles), which left
 * nothing at all expressing that a recruiter-posted ad is a WORSE version of the
 * same job: the employer is hidden, the JD is rewritten, the salary is a band, and
 * you apply through a middleman who may not even have the mandate.
 *
 * A filter is the wrong instrument for that — it is all-or-nothing. Ranking is the
 * right one: agency roles stay visible, but they have to be genuinely better matches
 * to beat a direct one.
 *
 * This is name-based and PURE, so it costs nothing and — importantly — it works at
 * ranking time. The enrichment layer's flag would be no use here: enrichment runs
 * AFTER the ranking and is budget-capped to the top 50, so the very jobs whose rank
 * we need to fix are the ones it hasn't looked at yet.
 */
function recruiterPenalty(company: string, source: SourceType): number {
  // An ATS job is first-party by construction — the employer posted it on their own
  // board. Never penalise a consultancy (Accenture, Deloitte, KPMG) for posting its
  // OWN roles on its OWN board just because its name pattern-matches an agency.
  if (isAtsSource(source)) return 0;
  return detectRecruiter(null, company).is_recruiter ? -12 : 0;
}

function cheapRankScore(
  j: NormalisedJob,
  criteria: SearchCriteria,
  description: string | null | undefined
): { composite: number; match_to_search: number; quality: number; salary_fit: number; hits: string[] } {
  const mts = matchToSearchScore(j, criteria, description);
  const q = j.quality_score ?? 50;
  const sf = salaryFitScore(j, criteria);
  const composite = Math.max(
    0,
    Math.min(
      100,
      Math.round(mts.score * 0.45 + q * 0.35 + sf * 0.2) +
        firstPartyBonus(j.source) +
        recruiterPenalty(j.company, j.source)
    )
  );
  return { composite, match_to_search: mts.score, quality: q, salary_fit: sf, hits: mts.hits };
}

/** Resolve locations for a batch of jobs with bounded concurrency. */
async function resolveLocations(
  jobs: NormalisedJob[],
  concurrency = 8
): Promise<Map<NormalisedJob, JobLocation>> {
  const out = new Map<NormalisedJob, JobLocation>();
  let cursor = 0;
  async function worker() {
    for (;;) {
      const i = cursor++;
      if (i >= jobs.length) return;
      const j = jobs[i];
      try {
        const loc = await resolveJobLocation(j.location_raw, {
          candidates: j.location_candidates,
          countryHint: j.country_hint,
          isRemote: j.is_remote,
          lat: j.lat,
          lng: j.lng,
        });
        out.set(j, loc);
      } catch {
        out.set(j, {
          raw: j.location_raw ?? "",
          places: [],
          is_remote: false,
          is_foreign: false,
          is_unresolved: true,
          is_country_only: false,
        });
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return out;
}

/**
 * Semantic similarity for the corpus candidates, computed in the database.
 *
 * Returns posting_id → cosine similarity for every candidate that HAS an embedding.
 * Everything about this is best-effort: no key, no migration, no query vector, or an
 * RPC error all resolve to an empty map, and ranking silently falls back to the
 * heuristic axes. A search must never fail because the semantic layer did.
 *
 * Only corpus jobs are scored: they carry a job_postings.id (their `posting_id`) and
 * their JD is embedded by the backfill. Aggregator jobs have neither, so they're
 * absent here and rank on the cheap axes alone.
 */
async function computeSemanticSimilarities(
  supabase: ReturnType<typeof createServerSupabaseClient>,
  input: RunSearchInput,
  description: string | null,
  candidatePostingIds: string[]
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (candidatePostingIds.length === 0 || !embeddingsConfigured()) return out;
  if (!(await embeddingColumnsAvailable(supabase))) return out;

  const ensured = await ensureSearchEmbedding(supabase, {
    searchId: input.searchId,
    criteria: input.criteria,
    description,
  });
  if (!ensured.present) return out;

  const { data, error } = await supabase.rpc("match_job_embeddings", {
    p_search_id: input.searchId,
    p_posting_ids: candidatePostingIds,
  });
  if (error) {
    console.error("[runSearch] match_job_embeddings failed", error);
    return out;
  }
  for (const row of (data ?? []) as Array<{ posting_id: string; similarity: number }>) {
    if (typeof row.similarity === "number") out.set(row.posting_id, row.similarity);
  }
  return out;
}

export async function runSearch(input: RunSearchInput): Promise<RunSearchResult> {
  const supabase = createServerSupabaseClient();

  // Deploy-order safety: the code and the hand-applied SQL migration can land in
  // either order, and a search that silently returns zero is the worst outcome here.
  const hasAtsColumns = await atsColumnsAvailable(supabase);

  const runInsert = await supabase
    .from("job_search_runs")
    .insert({ user_id: input.userId, search_id: input.searchId, trigger: input.trigger })
    .select("id")
    .single();
  const runId = runInsert.data?.id ?? null;

  const sourceCounts: Record<string, number> = {};
  const sourceWarnings: string[] = [];
  const filterDrops: Record<string, number> = {
    salary_floor: 0, working_model: 0, hidden_salary: 0, industry_exclude: 0,
    expired: 0, already_decided: 0,
    company_size: 0, recruiter: 0,
    pruned_stale: 0,
    title_irrelevant: 0,
    // The three classified dimensions. Counted separately so a user who ticks
    // "Contract" and gets three results can SEE that job_type dropped 140 — rather
    // than concluding the product has no jobs.
    job_type: 0, seniority: 0, job_function: 0,
    // Geo. Before ATS these could not exist — every source did its own radius
    // search server-side and we trusted it.
    location_distance: 0,   // resolved, but further away than the user asked
    location_foreign: 0,    // not a UK job at all (an ATS board is global)
    location_unresolved: 0, // couldn't place it, and its source doesn't vouch for it
    // Cross-source duplicates collapsed into one shortlist row.
    cross_source_dupe: 0,
  };
  const allRaw: NormalisedJob[] = [];

  // Cross-search "already decided" gate.
  const DECIDED_STATES = ["rejected_user", "rejected_employer", "interested", "applied", "deleted"] as const;
  const decidedKeys = new Set<string>();
  const decidedCanonical = new Set<string>();
  {
    const { data: decidedRows } = await supabase
      .from("job_shortlist")
      .select("posting_id")
      .eq("user_id", input.userId)
      .in("state", DECIDED_STATES as unknown as string[]);
    const decidedPostingIds = (decidedRows ?? []).map((r) => r.posting_id as string);
    if (decidedPostingIds.length) {
      // Selecting a column the database doesn't have yet errors the WHOLE query and
      // returns no rows — which would quietly un-block every job the user has already
      // rejected. Only ask for canonical_key once it exists.
      const { data: postings } = await supabase
        .from("job_postings")
        .select(hasAtsColumns ? "source, source_id, canonical_key" : "source, source_id")
        .in("id", decidedPostingIds);
      for (const p of (postings ?? []) as unknown as Array<Record<string, unknown>>) {
        if (p.source && p.source_id) decidedKeys.add(`${p.source}|${p.source_id}`);
        // Also block by CANONICAL identity. Without this, rejecting the Reed copy
        // of a job leaves the employer's own ATS copy free to walk straight back
        // into the shortlist — a different (source, source_id), the same job. The
        // user would reject it again, and again.
        if (p.canonical_key) decidedCanonical.add(p.canonical_key as string);
      }
    }
  }

  const resolved = resolveSearchTerms(input.criteria, input.description);
  const keywords = resolved.terms;

  // ---- Targets (shared by the title filter AND the corpus query) ----
  const rawTargets = input.criteria.target_titles?.length
    ? input.criteria.target_titles
    : (input.criteria.keywords ?? "")
        .split(/[,/\n]+|\s+and\s+/gi)
        .map((s) => s.trim())
        .filter(Boolean);
  const targetSets: TargetTitle[] = buildTargets(rawTargets);

  // ---- Location ----
  const radius = resolveRadiusMiles(input.criteria.location);
  const isNationwide =
    input.criteria.location.willing_to_relocate ||
    input.criteria.location.filter_mode === "anywhere";

  const origin: GeoPoint | null =
    !isNationwide && input.criteria.location.postcode
      ? await resolveOrigin(input.criteria.location.postcode)
      : null;

  if (!isNationwide && input.criteria.location.postcode && !origin) {
    // We cannot place the USER. Every distance claim downstream would be a guess,
    // so say so rather than quietly returning jobs from anywhere in the country.
    sourceWarnings.push(
      `Could not resolve "${input.criteria.location.postcode}" to a location — distance filtering is OFF for this run.`
    );
  }

  const acceptRemote = input.criteria.working_model.accepted.includes("remote");

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

  // ---- Fan out: network aggregators + the local ATS corpus, in parallel ----
  const networkSources: JobSourceAdapter[] = [reedAdapter, adzunaAdapter];
  const [settled, corpus] = await Promise.all([
    Promise.allSettled(networkSources.map((s) => s.pull(pullInput))),
    pullFromCorpus({
      ...pullInput,
      origin,
      targetTitles: rawTargets,
      acceptRemote,
    }),
  ]);

  for (let i = 0; i < networkSources.length; i++) {
    const type = networkSources[i].type;
    const r = settled[i];
    if (r.status !== "fulfilled") {
      console.error(`[runSearch] ${type} pull threw`, r.reason);
      sourceCounts[type] = 0;
      sourceWarnings.push(`${type} failed: ${String(r.reason).slice(0, 140)}`);
      continue;
    }
    sourceCounts[type] = r.value.jobs.length;
    if (r.value.error) {
      console.error(`[runSearch] ${type} error:`, r.value.error);
      sourceWarnings.push(`${type}: ${r.value.error.slice(0, 140)}`);
    }
    for (const j of r.value.jobs) allRaw.push(normalise(j));
  }

  for (const [src, n] of Object.entries(corpus.bySource)) sourceCounts[src] = n;
  sourceCounts.ats_total = corpus.jobs.length;
  if (corpus.error) sourceWarnings.push(`ats corpus: ${corpus.error}`);
  for (const j of corpus.jobs) allRaw.push(normalise(j));

  // A source that returns ZERO is indistinguishable from "no jobs matched" unless
  // somebody says so out loud. Adzuna returned zero for TEN DAYS because nothing did.
  if (corpus.jobs.length === 0 && !corpus.error) {
    sourceWarnings.push(
      "ATS corpus returned 0 jobs. If the registry is populated, this is a fault — " +
        "run `npx tsx scripts/ingest-ats.ts` and check ats_ingest_runs."
    );
  }

  const pulled = allRaw.length;

  // ---- Dedupe within the run (exact) ----
  const seenHashes = new Set<string>();
  const exactDeduped: NormalisedJob[] = [];
  for (const j of allRaw) {
    if (!seenHashes.has(j.dedupe_hash)) {
      seenHashes.add(j.dedupe_hash);
      exactDeduped.push(j);
    }
  }

  // ---- Geo pass ----
  const locations = await resolveLocations(exactDeduped);

  // ---- Cross-source dedupe ----
  //
  // Runs AFTER geo because the canonical key uses the RESOLVED town: Reed says
  // "Birmingham, West Midlands", the ATS says "Birmingham" — the raw strings
  // differ, the resolved place doesn't. Keying on the resolved place is what
  // actually collapses the duplicate.
  const keyed = exactDeduped.map((j) => {
    const loc = locations.get(j);
    return {
      job: j,
      loc,
      key: canonicalKey({
        company: j.company,
        title: j.title,
        location_raw: j.location_raw,
        place_name: loc?.places[0]?.name ?? null,
        is_remote: loc?.is_remote ?? null,
      }),
    };
  });

  const groups = dedupeByCanonicalKey(
    keyed,
    (r) => r.key,
    (r) => ({
      source: r.job.source,
      salary_min: r.job.salary_min,
      salary_max: r.job.salary_max,
      jd_text: r.job.jd_text,
      posted_at: r.job.posted_at,
    })
  );
  filterDrops.cross_source_dupe = groups.reduce((n, g) => n + g.duplicates_merged, 0);

  const deduped = groups.map((g) => ({
    ...g.winner,
    also_seen_on: g.also_seen_on,
  }));

  // ---- Hard filters ----
  const kept: Array<{ job: NormalisedJob; loc?: JobLocation; key: string; also_seen_on: SourceType[] }> = [];
  const now = Date.now();
  const acceptedWM = new Set<FilterableWorkingModel>(input.criteria.working_model.accepted);
  const includeUnknownWM = input.criteria.working_model.include_unknown;
  const excludes = input.criteria.industries_exclude.map((s) => s.toLowerCase());

  for (const entry of deduped) {
    const j = entry.job;
    const loc = entry.loc;

    if (decidedKeys.has(`${j.source}|${j.source_id}`) || decidedCanonical.has(entry.key)) {
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

    // ---- Distance ----
    // Skipped entirely for a nationwide / willing-to-relocate search.
    if (!isNationwide && loc) {
      if (loc.is_foreign) {
        filterDrops.location_foreign++;
        continue;
      }
      const remoteOk = loc.is_remote && acceptRemote;
      if (!remoteOk && origin && radius) {
        const d = distanceMiles(origin, loc);
        if (d !== null) {
          if (d > radius) {
            filterDrops.location_distance++;
            continue;
          }
        } else if (!loc.is_country_only) {
          // No usable coordinates. Whether that's fatal depends on WHO gave us
          // the job: Reed and Adzuna already did a server-side radius search, so
          // they vouch for it. An ATS board vouches for nothing — it handed us
          // its entire global board — so an unplaceable ATS job must go, or
          // "within 25 miles of Birmingham" starts returning Palo Alto.
          if (!hasTrustedRadius(j.source)) {
            filterDrops.location_unresolved++;
            continue;
          }
        }
      }
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
    kept.push({ job: j, loc, key: entry.key, also_seen_on: entry.also_seen_on });
  }

  // ---- Ranking: heuristic axes fused with the semantic (embedding) axis ----
  const { data: searchRow } = await supabase
    .from("job_searches")
    .select("description")
    .eq("id", input.searchId)
    .single();
  const description = (searchRow?.description as string | null | undefined) ?? null;

  // Semantic similarity for the corpus candidates (best-effort — see the helper).
  const candidatePostingIds = kept
    .map((e) => e.job.posting_id)
    .filter((id): id is string => !!id);
  const semanticByPostingId = await computeSemanticSimilarities(
    supabase,
    input,
    description,
    candidatePostingIds
  );

  // Must-haves the user described (empty for a search with no AI parse). Applied as
  // an explained ranking bonus below, never as a filter.
  const mustHaves = input.criteria.ai_parsed?.must_haves ?? [];

  const ranked = kept
    .map((e) => {
      const cheap = cheapRankScore(e.job, input.criteria, description);
      const sim = e.job.posting_id ? semanticByPostingId.get(e.job.posting_id) ?? null : null;
      const semantic_score = sim !== null ? semanticScoreFromSimilarity(sim) : null;
      // Blend only when we have a semantic score. The cheap composite already
      // carries the first-party bonus and recruiter penalty, so both survive here.
      const blended =
        semantic_score !== null
          ? Math.round(cheap.composite * (1 - SEMANTIC_WEIGHT) + semantic_score * SEMANTIC_WEIGHT)
          : cheap.composite;
      // Must-have bonus rides on top of the blend, then the whole thing is clamped.
      const mustHaveHits = matchMustHaves(e.job, mustHaves);
      const mustHaveBonus = Math.min(mustHaveHits.length * MUST_HAVE_BONUS_EACH, MUST_HAVE_BONUS_MAX);
      const composite = Math.max(0, Math.min(100, blended + mustHaveBonus));
      return {
        ...e,
        r: {
          composite,
          cheap_composite: cheap.composite,
          match_to_search: cheap.match_to_search,
          quality: cheap.quality,
          salary_fit: cheap.salary_fit,
          semantic_score,
          semantic_similarity: sim,
          hits: cheap.hits,
          must_have_hits: mustHaveHits,
          must_have_bonus: mustHaveBonus,
          phase: semantic_score !== null ? ("fused" as const) : ("cheap-only" as const),
        },
      };
    })
    .sort((a, b) => b.r.composite - a.r.composite);

  const semanticScored = ranked.filter((e) => e.r.semantic_score !== null).length;

  // ---- Companies House enrichment — CACHE-ONLY in the hot path ----
  // A fresh CH lookup is 3-6s each and used to block the run for up to 45s. Those
  // fresh lookups now run in the post-response after() sweep (postRunEnrichmentSweep
  // in searches.ts), which warms the cache so the NEXT run's size/recruiter filters
  // see more companies. This run applies whatever enrichment is ALREADY cached — a
  // single fast lookup, no CH round-trips on the critical path.
  const ENRICH_POOL_MAX = 50;
  const enrichPoolLen = Math.min(ENRICH_POOL_MAX, ranked.length);
  const enrichPool = ranked.slice(0, enrichPoolLen);
  const uniqueCompanies = Array.from(new Set(enrichPool.map((e) => e.job.company).filter(Boolean)));
  const enrichmentResult = await enrichBatch(uniqueCompanies, 0, { cacheOnly: true });
  const enrichmentByNorm = enrichmentResult.byNormalisedName;

  // ---- Upsert postings + shortlist ----
  const existingByPosting = new Map<string, { id: string; state: string }>();
  {
    const { data: existing } = await supabase
      .from("job_shortlist")
      .select("id, posting_id, state")
      .eq("user_id", input.userId)
      .eq("search_id", input.searchId);
    for (const row of existing ?? []) {
      existingByPosting.set(row.posting_id as string, { id: row.id as string, state: row.state as string });
    }
  }

  const acceptedSizes = new Set<string>(input.criteria.company_size?.accepted ?? []);
  const includeUnknownSize = input.criteria.company_size?.include_unknown ?? true;
  const hideRecruiters = input.criteria.hide_recruiters === true;

  // The three classified dimensions. readDimensionFilter() tolerates the legacy
  // `seniority: string[]` shape still sitting in older saved searches.
  const fType = readDimensionFilter(input.criteria.job_type);
  const fSeniority = readDimensionFilter(input.criteria.seniority);
  const fFunction = readDimensionFilter(input.criteria.job_function);

  const sizeDropByBucket: Record<string, number> = {
    startup: 0, small: 0, mid: 0, large: 0, enterprise: 0, unknown: 0,
  };

  const keptPostingIds = new Set<string>();

  // ---- Selection pass (pure, no I/O) ----
  // Classify + filter every ranked job in memory, collecting a posting row for
  // each job we examine and a shortlist payload for each that survives. The DB
  // writes are BATCHED after this loop: the old code did two awaited round-trips
  // PER job (a posting upsert then a shortlist insert/update), which was a big
  // slice of the 30-50s a run took. Selection stops once jobsPerRun jobs pass.
  const selected: Array<{
    srcKey: string;
    postingRow: Record<string, unknown>;
    rankingPayload: Record<string, unknown> | null;
  }> = [];
  const seenSrcKeys = new Set<string>();
  let passedFilter = 0;

  for (let i = 0; i < ranked.length && passedFilter < input.jobsPerRun; i++) {
    const { job: j, loc, key, also_seen_on, r } = ranked[i];

    // A duplicate (source, source_id) inside one batch upsert makes Postgres
    // ON CONFLICT fail the WHOLE statement ("cannot affect row a second time"),
    // which would empty the run. Dedupe defensively, keeping the higher-ranked
    // one. (Upstream dedupe should already guarantee uniqueness here.)
    const srcKey = `${j.source} ${j.source_id}`;
    if (seenSrcKeys.has(srcKey)) continue;
    seenSrcKeys.add(srcKey);

    const normalisedCompany = normaliseCompanyName(j.company);
    const enrichment = normalisedCompany ? enrichmentByNorm.get(normalisedCompany) : null;

    // Classify ONCE, up here: the same values decide whether the job survives the
    // filters below AND get persisted on the posting row further down. Deriving them
    // twice invites the two copies to drift, which is how a job gets filtered on one
    // value and displayed with another.
    const cls = classifyJob({
      title: j.title,
      jd_text: j.jd_text,
      employment_type: j.employment_type,
      seniority_hint: j.seniority_hint,
      department: j.department,
      job_function: j.job_function,
    });

    const bucket = (enrichment?.size_bucket as string | null) ?? "unknown";
    const bucketKnown = bucket !== "unknown" && !!enrichment;
    let passesFilter = true;
    if (bucketKnown) {
      if (acceptedSizes.size > 0 && !acceptedSizes.has(bucket)) {
        passesFilter = false;
        filterDrops.company_size++;
        sizeDropByBucket[bucket] = (sizeDropByBucket[bucket] ?? 0) + 1;
      }
    } else if (!includeUnknownSize) {
      passesFilter = false;
      filterDrops.company_size++;
      sizeDropByBucket.unknown++;
    }

    // An ATS-direct job is first-party BY CONSTRUCTION — the employer posted it on
    // their own board. A recruitment agency cannot appear here, so the recruiter
    // flag (a name heuristic built for aggregator data) must not be applied to it.
    // Without this guard, a consultancy like Accenture posting its OWN roles on its
    // OWN Workday board could be name-matched as an "agency" and binned.
    if (passesFilter && hideRecruiters && !isAtsSource(j.source) && enrichment?.is_likely_recruiter) {
      passesFilter = false;
      filterDrops.recruiter++;
    }

    // The three classified dimensions. Each behaves identically:
    //   accepted is empty            → no filter at all
    //   value known, not accepted    → drop
    //   value null (unclassified)    → keep, UNLESS the user cleared include_unknown
    //
    // The unknown branch is the dangerous one and it is why include_unknown defaults
    // to true. classify.ts returns null whenever the signal genuinely isn't there,
    // and it is honest about that rather than guessing — so "unknown" is a real,
    // populated bucket, not an empty edge case. Every drop is counted into
    // filter_drops and shown in the run stats: a filter must never remove jobs
    // silently.
    // Each dimension carries a different string union, so they are compared as
    // plain strings here. The unions are enforced where it matters — the values
    // come from classify.ts and the accepted lists are typed on SearchCriteria.
    const dims: Array<{
      accepted: ReadonlySet<string>;
      includeUnknown: boolean;
      value: string | null;
      dropKey: string;
    }> = [
      { ...fType, value: cls.employment_type, dropKey: "job_type" },
      { ...fSeniority, value: cls.seniority, dropKey: "seniority" },
      { ...fFunction, value: cls.job_function, dropKey: "job_function" },
    ];
    for (const { accepted, includeUnknown, value, dropKey } of dims) {
      if (!passesFilter) break;
      if (accepted.size === 0) continue; // not filtering on this dimension
      if (value === null) {
        if (!includeUnknown) {
          passesFilter = false;
          filterDrops[dropKey]++;
        }
        continue;
      }
      if (!accepted.has(value)) {
        passesFilter = false;
        filterDrops[dropKey]++;
      }
    }

    // Salary stated in the JD body rather than a structured field — the norm for
    // ATS postings. Without this, our best jobs look salary-less.
    let salary_min = j.salary_min;
    let salary_max = j.salary_max;
    let salary_listed = j.salary_listed;
    if (salary_min === null && salary_max === null) {
      const parsed = parseSalaryFromText(j.jd_text);
      if (parsed) {
        salary_min = parsed.min;
        salary_max = parsed.max;
        salary_listed = true;
      }
    }

    const place = loc?.places[0] ?? null;

    const legacyColumns = {
      source: j.source,
      source_id: j.source_id,
      source_url: j.source_url,
      company: j.company,
      title: j.title,
      location_raw: j.location_raw,
      working_model: j.working_model,
      hybrid_days_office: j.hybrid_days_office,
      salary_min,
      salary_max,
      salary_currency: j.salary_currency,
      salary_listed,
      jd_text: j.jd_text,
      jd_html: j.jd_html,
      posted_at: j.posted_at,
      expires_at: j.expires_at,
      dedupe_hash: j.dedupe_hash,
      quality_score: j.quality_score,
      normalised_company_name: normalisedCompany || null,
      enrichment_id: enrichment?.id ?? null,
      last_seen_at: new Date().toISOString(),
    };

    // The corpus columns only exist once supabase-ats-schema.sql has been applied.
    // Sending them to a database that lacks them makes PostgREST reject EVERY
    // upsert, which would empty every search on this deploy. Degrade instead.
    const postingRow: Record<string, unknown> = hasAtsColumns
      ? {
          ...legacyColumns,
          canonical_key: key,
          also_seen_on,
          lat: place?.lat ?? null,
          lng: place?.lng ?? null,
          place_name: place?.name ?? null,
          country_code: place?.country ?? null,
          is_remote: loc?.is_remote ?? null,
          geo_resolved: !!place,
          // Classified, not copied — identically to the ATS ingest path.
          // Reed and Adzuna supply NO seniority and NO function at all, so
          // without this every aggregator job is "unknown" on all three
          // dimensions and any filter the user touches silently deletes them.
          department: j.department ?? null,
          employment_type: cls.employment_type,
          seniority_hint: cls.seniority,
          job_function: cls.job_function,
        }
      : legacyColumns;

    // Shortlist payload only for survivors; a filtered-out job still gets its
    // posting upserted below (keeps the corpus fresh) but no shortlist row.
    let rankingPayload: Record<string, unknown> | null = null;
    if (passesFilter) {
      const distance = origin && loc ? distanceMiles(origin, loc) : null;
      rankingPayload = {
        quality_score: r.quality,
        match_to_search_score: r.match_to_search,
        // The semantic score IS the match-to-you axis: how close the JD sits to the
        // user's own description in embedding space. Populating the existing column
        // lights up the axis tile the UI already renders. Null when unscored.
        match_to_user_score: r.semantic_score,
        composite_rank: r.composite,
        ranking_explanation: {
          phase: r.phase,
          match_to_search: r.match_to_search,
          quality: r.quality,
          salary_fit: r.salary_fit,
          // The semantic axis. cheap_composite is the pre-blend heuristic score, kept
          // so the panel can show exactly what the embedding match moved.
          semantic_score: r.semantic_score,
          semantic_similarity: r.semantic_similarity,
          cheap_composite: r.cheap_composite,
          semantic_weight: r.semantic_score !== null ? SEMANTIC_WEIGHT : 0,
          // What the user said they wanted ("training programme") that this JD actually
          // mentions — shown on the card as the "matches what you asked for" chips.
          must_have_hits: r.must_have_hits,
          must_have_bonus: r.must_have_bonus,
          keyword_hits: r.hits,
          quality_reasons: j.quality_reasons,
          first_party: isAtsSource(j.source),
          also_seen_on,
          distance_miles: distance !== null ? Math.round(distance) : null,
          place: place?.name ?? null,
          rank_position: i + 1,
          of: ranked.length,
        },
      };
      passedFilter++;
    }

    selected.push({ srcKey, postingRow, rankingPayload });
  }

  // ---- Batch upsert postings (one round-trip instead of one per job) ----
  // .select() returns both inserted and updated rows; map them back to the jobs
  // by their (source, source_id) natural key so the shortlist rows below can
  // attach posting_ids. A whole-batch failure logs and leaves postingIdByKey
  // empty, so nothing gets shortlisted rather than half-writing a run.
  const postingIdByKey = new Map<string, string>();
  if (selected.length) {
    const { data: upserted, error: upErr } = await supabase
      .from("job_postings")
      .upsert(
        selected.map((s) => s.postingRow),
        { onConflict: "source,source_id" }
      )
      .select("id, source, source_id");
    if (upErr) {
      console.error("[runSearch] batch posting upsert failed", upErr);
    } else {
      for (const row of upserted ?? []) {
        postingIdByKey.set(`${row.source} ${row.source_id}`, row.id as string);
      }
    }
  }

  // ---- Batch upsert shortlist (one round-trip instead of one per job) ----
  // job_shortlist has unique(user_id, search_id, posting_id), so a single upsert
  // covers both fresh inserts and re-ranks of existing rows. For an existing row
  // we send its CURRENT state, so a decided job (interested / applied / …) is
  // never reset to "new" — only the ranking columns move. Columns we don't send
  // (seen_at, reject_reason, jd_fit_summary, …) are left untouched on conflict.
  let shortlisted = 0;
  let shortlistWriteOk = true;
  const shortlistRows: Record<string, unknown>[] = [];
  for (const s of selected) {
    if (!s.rankingPayload) continue;
    const posting_id = postingIdByKey.get(s.srcKey);
    if (!posting_id) continue; // its posting upsert didn't come back — skip
    const existing = existingByPosting.get(posting_id);
    shortlistRows.push({
      user_id: input.userId,
      search_id: input.searchId,
      posting_id,
      state: existing ? existing.state : "new",
      ...s.rankingPayload,
    });
    keptPostingIds.add(posting_id);
  }
  if (shortlistRows.length) {
    const { data: written, error: slErr } = await supabase
      .from("job_shortlist")
      .upsert(shortlistRows, { onConflict: "user_id,search_id,posting_id" })
      .select("id");
    if (slErr) {
      console.error("[runSearch] batch shortlist upsert failed", slErr);
      shortlistWriteOk = false;
    } else {
      shortlisted = written?.length ?? shortlistRows.length;
    }
  }

  // Prune undecided leftovers that no longer match the current criteria — ONLY
  // when the shortlist write above succeeded, so a transient write failure can
  // never delete the user's existing shortlist.
  if (shortlistWriteOk) {
    const toPrune: string[] = [];
    for (const [postingId, row] of existingByPosting) {
      if (DECIDED_STATES.includes(row.state as (typeof DECIDED_STATES)[number])) continue;
      if (keptPostingIds.has(postingId)) continue;
      toPrune.push(row.id);
    }
    if (toPrune.length) {
      const del = await supabase.from("job_shortlist").delete().in("id", toPrune);
      if (del.error) console.error("[runSearch] shortlist prune failed", del.error);
      else filterDrops.pruned_stale = toPrune.length;
    }
  }

  // Semantic-axis observability. A silently-absent axis is exactly the failure mode
  // this codebase keeps getting bitten by — so the run record says out loud how many
  // candidates were semantically scored and what the similarity distribution was.
  // verify-embeddings.ts uses the same shape to calibrate SIM_FLOOR/SIM_CEIL.
  const sims = ranked
    .map((e) => e.r.semantic_similarity)
    .filter((s): s is number => s !== null)
    .sort((a, b) => a - b);
  const semanticStats = {
    scored: semanticScored,
    of: ranked.length,
    weight: SEMANTIC_WEIGHT,
    sim_min: sims.length ? Number(sims[0].toFixed(4)) : null,
    sim_median: sims.length ? Number(sims[Math.floor(sims.length / 2)].toFixed(4)) : null,
    sim_max: sims.length ? Number(sims[sims.length - 1].toFixed(4)) : null,
  };

  const searchTermsUsed: string[] =
    resolved.source === "keywords"
      ? [keywords]
      : resolved.source === "target_titles"
      ? input.criteria.target_titles ?? []
      : resolved.source === "description"
      ? resolved.extracted ?? []
      : [];

  await supabase
    .from("job_search_runs")
    .update({
      finished_at: new Date().toISOString(),
      source_counts: sourceCounts,
      dedupe_stats: {
        before: pulled,
        after: deduped.length,
        cross_source_merged: filterDrops.cross_source_dupe,
        search_terms: searchTermsUsed,
        terms_source: resolved.source,
        enrichment: enrichmentResult.stats,
        size_drops_by_bucket: sizeDropByBucket,
        ranked_pool: ranked.length,
        jobs_per_run_target: input.jobsPerRun,
        origin_resolved: !!origin,
        semantic: semanticStats,
        warnings: sourceWarnings,
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
    sourceCounts,
    sourceWarnings,
  };
}
