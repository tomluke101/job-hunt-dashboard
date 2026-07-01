// Pull -> normalise -> dedupe -> hard-filter -> rank -> insert.
// Cheap axes only for now. Match-to-user + career-fit (LLM) added in next iteration.

import { createServerSupabaseClient } from "@/lib/supabase-server";
import type { SearchCriteria, FilterableWorkingModel } from "./types";
import { normalise, type NormalisedJob } from "./normalise";
import { reedAdapter } from "./sources/reed";

export interface RunSearchInput {
  userId: string;
  searchId: string;
  name: string;
  criteria: SearchCriteria;
  jobsPerRun: number;
  trigger: "manual" | "scheduled";
}

export interface RunSearchResult {
  shortlisted: number;
  pulled: number;
  deduped: number;
  filtered: number;
  runId: string | null;
  error?: string;
}

// Rough conversion. Real commute calc lives behind a maps API and gets wired
// in step 6 of the build order. For now: 20 mph average → miles ≈ minutes/3.
function commuteMinutesToRadiusMiles(mins: number | null, fallback: number | null): number | null {
  if (mins) return Math.max(5, Math.round(mins / 3));
  return fallback;
}

// Tokenise a free-text field into content words. Cheap, no dependencies.
const STOPWORDS = new Set([
  "the","a","an","and","or","of","to","in","for","with","on","at","by","from","as","is","are",
  "be","been","being","this","that","these","those","i","you","we","they","it","my","our","your",
  "will","would","should","can","have","has","had","do","does","did","not","but","if","then","so",
  "job","role","position","company","team","work","working","experience","looking","looking",
]);

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
  const filterDrops: Record<string, number> = { salary_floor: 0, working_model: 0, hidden_salary: 0, industry_exclude: 0, expired: 0 };
  const allRaw: NormalisedJob[] = [];

  const keywords = (input.criteria.keywords || input.name).trim();

  // ---- Pull: Reed ----
  try {
    const radius = commuteMinutesToRadiusMiles(
      input.criteria.location.max_commute_minutes,
      input.criteria.location.fallback_radius_miles
    );
    const reed = await reedAdapter.pull({
      keywords,
      locationText: input.criteria.location.postcode,
      postcode: input.criteria.location.postcode,
      radiusMiles: radius,
      minSalary: input.criteria.salary.floor,
      maxSalary: null,
      limit: Math.max(50, input.jobsPerRun * 5),
      sinceDate: null,
    });
    sourceCounts.reed = reed.jobs.length;
    if (reed.error) console.error("[runSearch] Reed error:", reed.error);
    for (const j of reed.jobs) allRaw.push(normalise(j));
  } catch (e) {
    console.error("[runSearch] Reed pull threw", e);
    sourceCounts.reed = 0;
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

  for (const j of deduped) {
    if (j.expires_at && new Date(j.expires_at).getTime() < now) {
      filterDrops.expired++;
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
  const top = ranked.slice(0, input.jobsPerRun);

  // ---- Upsert postings + shortlist ----
  let shortlisted = 0;
  for (let i = 0; i < top.length; i++) {
    const { j, r } = top[i];
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

    const short = await supabase
      .from("job_shortlist")
      .upsert(
        {
          user_id: input.userId,
          search_id: input.searchId,
          posting_id,
          state: "new",
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
            of: top.length,
          },
        },
        { onConflict: "user_id,search_id,posting_id" }
      )
      .select("id");
    if (short.error) console.error("[runSearch] shortlist upsert failed", short.error);
    else shortlisted++;
  }

  await supabase
    .from("job_search_runs")
    .update({
      finished_at: new Date().toISOString(),
      source_counts: sourceCounts,
      dedupe_stats: { before: pulled, after: deduped.length },
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
  };
}
