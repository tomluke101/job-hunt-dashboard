// The ingest worker: registry → every employer's board → the job_postings corpus.
//
// WHY A BACKGROUND WORKER AND NOT A SEARCH-TIME PULL
// --------------------------------------------------
// An ATS board endpoint has no keyword parameter and no radius parameter. You get
// the company's ENTIRE GLOBAL BOARD or you get nothing. So there is no way to ask
// 2,000 boards "any supply chain analysts near Birmingham?" inside a 60s request.
//
// Instead this worker pulls every board on a schedule and writes the jobs into
// job_postings, geocoded and canonically keyed. Search time then queries that
// corpus with plain SQL — no network, no per-search API budget, and it scales to
// however many boards we register. THAT is what makes ATS-direct the default
// supply rather than a bolt-on.

import { createServerSupabaseClient } from "@/lib/supabase-server";
import { getProvider } from "./providers";
import { PROVIDER_STATUS, type AtsProviderId } from "./types";
import type { RegistryBoard } from "./registry";
import { markPolled } from "./registry";
import { normalise } from "@/lib/job-search/normalise";
import { canonicalKey } from "@/lib/job-search/canonical";
import { parseSalaryFromText } from "@/lib/job-search/salary-parse";
import { normaliseCompanyName } from "@/lib/enrichment/normalise-company";
import { resolveJobLocation, type JobLocation } from "@/lib/geo";
import type { RawJob } from "@/lib/job-search/types";

export interface IngestStats {
  boards_polled: number;
  boards_failed: number;
  jobs_seen: number;
  jobs_upserted: number;
  jobs_dropped_foreign: number;
  jobs_dropped_unresolved: number;
  provider_counts: Record<string, number>;
  provider_boards: Record<string, number>;
  provider_errors: Record<string, string[]>;
  elapsed_ms: number;
  budget_exhausted: boolean;
}

export interface IngestOptions {
  budgetMs?: number;
  concurrency?: number;
  trigger?: "manual" | "cron";
  /** Don't write — just report what would happen. */
  dryRun?: boolean;
  onProgress?: (msg: string) => void;
}

/**
 * A provider whose boards ALL return zero jobs is a DEAD PROVIDER, not an empty
 * job market. This is the exact failure that let Adzuna return zero for ten days
 * while looking perfectly healthy — a source returning 0 is indistinguishable
 * from "no jobs matched" unless you assert per-source counts. Never again.
 *
 * Returns human-readable problems; the caller must surface them loudly.
 */
export function assertProviderHealth(stats: IngestStats): string[] {
  const problems: string[] = [];
  for (const [provider, boards] of Object.entries(stats.provider_boards)) {
    if (PROVIDER_STATUS[provider as AtsProviderId] !== "verified") continue;
    // One or two empty boards is normal — that employer isn't hiring. Three or
    // more boards with a combined zero is a provider-level fault.
    if (boards >= 3 && (stats.provider_counts[provider] ?? 0) === 0) {
      problems.push(
        `PROVIDER DEAD? ${provider}: polled ${boards} boards, got 0 jobs total. ` +
          `Either every one of those employers has nothing open, or the API changed. Investigate.`
      );
    }
  }
  return problems;
}

/** Map a resolved location onto the columns job_postings stores. */
function geoColumns(loc: JobLocation) {
  const place = loc.places[0];
  return {
    lat: place?.lat ?? null,
    lng: place?.lng ?? null,
    place_name: place?.name ?? null,
    country_code: place?.country ?? (loc.is_remote && !loc.is_foreign ? null : null),
    is_remote: loc.is_remote,
    geo_resolved: loc.places.length > 0,
  };
}

async function ingestBoard(
  board: RegistryBoard,
  stats: IngestStats,
  opts: IngestOptions
): Promise<void> {
  const provider = getProvider(board.provider);
  if (!provider) return;

  const result = await provider.listJobs(board);
  stats.provider_boards[board.provider] = (stats.provider_boards[board.provider] ?? 0) + 1;

  if (result.error) {
    (stats.provider_errors[board.provider] ??= []).push(`${board.token}: ${result.error}`);
  }
  if (result.error && result.jobs.length === 0) {
    stats.boards_failed++;
    if (!opts.dryRun) await markPolled(board.id, 0, 0, result.error);
    return;
  }

  stats.jobs_seen += result.jobs.length;
  stats.provider_counts[board.provider] =
    (stats.provider_counts[board.provider] ?? 0) + result.jobs.length;

  const rows: Record<string, unknown>[] = [];

  for (const raw of result.jobs) {
    const loc = await resolveJobLocation(raw.location_raw, {
      candidates: raw.location_candidates,
      countryHint: raw.country_hint,
      isRemote: raw.is_remote,
      lat: raw.lat,
      lng: raw.lng,
    });

    // A UK product does not need Palo Alto. Dropping foreign jobs at ingest keeps
    // the corpus (and every query over it) an order of magnitude smaller.
    if (loc.is_foreign) {
      stats.jobs_dropped_foreign++;
      continue;
    }
    // Unresolvable AND not remote: we cannot place it, so a radius search can
    // never honestly match it. Keep it anyway — a town postcodes.io missed is
    // still a real job, and nationwide searches can still surface it — but record
    // it so the number is visible rather than silently zero.
    if (loc.is_unresolved && !loc.is_remote && !loc.is_country_only) {
      stats.jobs_dropped_unresolved++;
    }

    const n = normalise(raw as RawJob);

    // ATS boards almost never ship a structured salary — UK employers write it in
    // the JD body. Without this the corpus's best jobs would look salary-less and
    // rank BELOW recruiter spam that ticked a salary box. See salary-parse.ts.
    let salary_min = n.salary_min;
    let salary_max = n.salary_max;
    let salary_listed = n.salary_listed;
    if (salary_min === null && salary_max === null) {
      const parsed = parseSalaryFromText(n.jd_text);
      if (parsed) {
        salary_min = parsed.min;
        salary_max = parsed.max;
        // A quoted day/hour rate has no annual figure, but the employer DID state
        // the pay — so it must not be treated as a hidden salary and binned.
        salary_listed = true;
      }
    }

    const geo = geoColumns(loc);

    rows.push({
      source: n.source,
      source_id: n.source_id,
      source_url: n.source_url,
      company: n.company || board.companyName,
      title: n.title,
      location_raw: n.location_raw,
      working_model: geo.is_remote ? "remote" : n.working_model,
      hybrid_days_office: n.hybrid_days_office,
      salary_min,
      salary_max,
      salary_currency: "GBP",
      salary_listed,
      jd_text: n.jd_text,
      jd_html: n.jd_html,
      posted_at: n.posted_at,
      expires_at: n.expires_at,
      dedupe_hash: n.dedupe_hash,
      quality_score: n.quality_score,
      normalised_company_name: normaliseCompanyName(n.company || board.companyName) || null,
      canonical_key: canonicalKey({
        company: n.company || board.companyName,
        title: n.title,
        location_raw: n.location_raw,
        place_name: geo.place_name,
        is_remote: geo.is_remote,
      }),
      department: raw.department ?? null,
      employment_type: raw.employment_type ?? null,
      seniority_hint: raw.seniority_hint ?? null,
      job_function: raw.job_function ?? null,
      ...geo,
      ats_board_id: board.id,
      last_seen_at: new Date().toISOString(),
    });
  }

  if (opts.dryRun) {
    stats.jobs_upserted += rows.length;
    return;
  }

  const supabase = createServerSupabaseClient();
  let upserted = 0;
  // Chunked: a 500-job board in one statement risks a payload/timeout failure that
  // would lose the whole board rather than one chunk.
  for (let i = 0; i < rows.length; i += 100) {
    const chunk = rows.slice(i, i + 100);
    const { error } = await supabase
      .from("job_postings")
      .upsert(chunk, { onConflict: "source,source_id" });
    if (error) {
      (stats.provider_errors[board.provider] ??= []).push(`${board.token} upsert: ${error.message}`);
    } else {
      upserted += chunk.length;
    }
  }
  stats.jobs_upserted += upserted;
  await markPolled(board.id, result.jobs.length, upserted, null);
}

export async function ingestBoards(
  boards: RegistryBoard[],
  opts: IngestOptions = {}
): Promise<IngestStats> {
  const started = Date.now();
  const budgetMs = opts.budgetMs ?? 5 * 60_000;
  const concurrency = opts.concurrency ?? 4;

  const stats: IngestStats = {
    boards_polled: 0,
    boards_failed: 0,
    jobs_seen: 0,
    jobs_upserted: 0,
    jobs_dropped_foreign: 0,
    jobs_dropped_unresolved: 0,
    provider_counts: {},
    provider_boards: {},
    provider_errors: {},
    elapsed_ms: 0,
    budget_exhausted: false,
  };

  let cursor = 0;
  async function worker(): Promise<void> {
    for (;;) {
      if (Date.now() - started > budgetMs) {
        stats.budget_exhausted = true;
        return;
      }
      const i = cursor++;
      if (i >= boards.length) return;
      const board = boards[i];
      try {
        await ingestBoard(board, stats, opts);
      } catch (e) {
        // One malformed board must never take down an ingest of thousands.
        stats.boards_failed++;
        (stats.provider_errors[board.provider] ??= []).push(`${board.token}: ${String(e)}`);
      }
      stats.boards_polled++;
      opts.onProgress?.(
        `[${stats.boards_polled}/${boards.length}] ${board.provider}/${board.token} — ` +
          `${stats.jobs_seen} seen, ${stats.jobs_upserted} upserted`
      );
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  stats.elapsed_ms = Date.now() - started;
  return stats;
}

/** Record the run so a zero can never hide. See ats_ingest_runs in the schema. */
export async function recordIngestRun(
  stats: IngestStats,
  trigger: "manual" | "cron",
  problems: string[]
): Promise<void> {
  const supabase = createServerSupabaseClient();
  await supabase.from("ats_ingest_runs").insert({
    finished_at: new Date().toISOString(),
    trigger,
    boards_polled: stats.boards_polled,
    boards_failed: stats.boards_failed,
    jobs_seen: stats.jobs_seen,
    jobs_upserted: stats.jobs_upserted,
    jobs_dropped_foreign: stats.jobs_dropped_foreign,
    jobs_dropped_unresolved: stats.jobs_dropped_unresolved,
    provider_counts: stats.provider_counts,
    provider_errors: stats.provider_errors,
    error: problems.length ? problems.join(" | ") : null,
  });
}
