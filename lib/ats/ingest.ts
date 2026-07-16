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
import { getProvider, pullBoard } from "./providers";
import { PROVIDER_STATUS, type AtsProviderId } from "./types";
import type { RegistryBoard } from "./registry";
import { markPolled } from "./registry";
import { normalise } from "@/lib/job-search/normalise";
import { canonicalKey } from "@/lib/job-search/canonical";
import { parseSalaryFromText } from "@/lib/job-search/salary-parse";
import { classifyRawJob } from "@/lib/job-search/classify";
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
  /** Boards whose pull hit the job cap or the clock — i.e. we served a PARTIAL board. */
  truncated_boards: string[];
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

/**
 * A board we only half-pulled is a board we are half-serving — and it looks
 * identical to a small board. Same shape as the dead-source bug: the failure is
 * invisible because the number that comes back is plausible.
 *
 * This became real, not theoretical: AstraZeneca's Workday board has 1,314 jobs,
 * MAX_JOBS_PER_BOARD was 1000, and every ingest silently discarded 314 of them.
 * The cap and the clock are both legitimate protections — but hitting one must be
 * REPORTED, never absorbed. Surfacing it as a "problem" routes it into the
 * ats_ingest_runs.error column, which is exactly what verify-ats.ts asserts on.
 */
export function assertNoSilentTruncation(stats: IngestStats): string[] {
  const problems: string[] = [];
  if (stats.truncated_boards.length) {
    problems.push(
      `PARTIAL BOARDS (${stats.truncated_boards.length}): hit the job cap or the per-board clock, ` +
        `so we are serving only PART of these employers' boards — ${stats.truncated_boards.join(", ")}. ` +
        `Raise MAX_JOBS_PER_BOARD / DEFAULT_BOARD_BUDGET_MS, or page the remainder on the next run.`
    );
  }
  if (stats.budget_exhausted) {
    problems.push(
      `RUN BUDGET EXHAUSTED: only ${stats.boards_polled} boards were polled before the clock ran out. ` +
        `The rest of the registry did not refresh. Boards are polled oldest-first so the next run ` +
        `continues, but if this recurs the corpus is permanently stale at the tail.`
    );
  }
  return problems;
}

/** Cyrillic, CJK, Kana, Hangul, Arabic, Thai — scripts no UK job ad is titled in. */
export const NON_LATIN_TITLE = /[Ѐ-ӿ一-鿿぀-ヿ가-힯؀-ۿ฀-๿]/;

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

/**
 * Every page URL this board already has in the corpus. Fuel for the jsonld
 * provider's incremental refresh: a URL still enumerated by the site is a job
 * still open, reported WITHOUT re-fetching its page. That is what makes a
 * 1,000-page employer cost one sitemap fetch per night instead of a re-crawl —
 * and what lets boards bigger than one run's page cap complete themselves
 * across consecutive runs.
 */
async function knownSourceUrls(boardId: string): Promise<Set<string>> {
  const supabase = createServerSupabaseClient();
  const known = new Set<string>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from("job_postings")
      .select("source_url")
      .eq("ats_board_id", boardId)
      .range(from, from + 999);
    if (error) return known; // degrade to a full re-fetch, never fail the board
    const batch = data ?? [];
    for (const r of batch) if (r.source_url) known.add(r.source_url as string);
    if (batch.length < 1000) break;
  }
  // Pages fetched before that produced NO UK job (a global board's US pages).
  // Without these, FedEx's 3,500 mostly-foreign pages re-crawl every night.
  // Schema-guarded: if the table isn't there yet, we merely re-fetch — waste,
  // never wrongness.
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from("jsonld_seen_urls")
      .select("url")
      .eq("board_id", boardId)
      .range(from, from + 999);
    if (error) break;
    const batch = data ?? [];
    for (const r of batch) known.add(r.url as string);
    if (batch.length < 1000) break;
  }
  return known;
}

/**
 * Remember fetched pages that yielded nothing we kept, so they are never
 * fetched again. Only HTTP-200 pages reach here — a transient failure stays
 * un-cached and retries next run. A page whose posting later turns UK would be
 * missed; acceptable: postings don't change country, they expire.
 */
async function recordSeenNegatives(
  boardId: string,
  urls: string[],
  verdict: string
): Promise<void> {
  if (!urls.length) return;
  const supabase = createServerSupabaseClient();
  for (let i = 0; i < urls.length; i += 200) {
    const rows = urls.slice(i, i + 200).map((url) => ({ url, board_id: boardId, verdict }));
    const { error } = await supabase.from("jsonld_seen_urls").upsert(rows, { onConflict: "url" });
    if (error) return; // table not applied yet — degrade quietly to re-fetching
  }
}

/** Refresh last_seen_at for jobs whose page the provider verified as still listed. */
async function bumpStillListed(boardId: string, urls: string[]): Promise<number> {
  if (!urls.length) return 0;
  const supabase = createServerSupabaseClient();
  let bumped = 0;
  const now = new Date().toISOString();
  for (let i = 0; i < urls.length; i += 50) {
    const chunk = urls.slice(i, i + 50);
    const { error, count } = await supabase
      .from("job_postings")
      .update({ last_seen_at: now }, { count: "exact" })
      .eq("ats_board_id", boardId)
      .in("source_url", chunk);
    if (!error) bumped += count ?? 0;
  }
  return bumped;
}

async function ingestBoard(
  board: RegistryBoard,
  stats: IngestStats,
  opts: IngestOptions,
  /** The RUN's deadline. A board pull must never outlive the run — on Vercel the
   * function itself dies at maxDuration, killing the pull mid-board with no
   * markPolled, so the same (still oldest-polled) board would head the queue
   * again next night: a livelock where nothing else ever refreshes. */
  runDeadline?: number
): Promise<void> {
  const provider = getProvider(board.provider);
  if (!provider) return;

  // jsonld boards get the incremental treatment; API providers return the full
  // board in one or few calls and need none of it.
  const skipUrls = board.provider === "jsonld" ? await knownSourceUrls(board.id) : undefined;
  const pullOpts = {
    ...(skipUrls?.size ? { skipUrls } : {}),
    ...(runDeadline ? { budgetMs: Math.max(20_000, runDeadline - Date.now()) } : {}),
  };
  const result = await pullBoard(board, Object.keys(pullOpts).length ? pullOpts : undefined);
  stats.provider_boards[board.provider] = (stats.provider_boards[board.provider] ?? 0) + 1;

  // Still-listed pages are LIVE jobs confirmed by enumeration — bump their
  // last_seen_at so prune-corpus keeps them, and count them as seen so a
  // steady-state night (0 new pages anywhere) doesn't read as a dead provider.
  if (!opts.dryRun && result.stillListedUrls?.length) {
    const bumped = await bumpStillListed(board.id, result.stillListedUrls);
    stats.jobs_seen += bumped;
    stats.provider_counts[board.provider] = (stats.provider_counts[board.provider] ?? 0) + bumped;
  }

  // A PARTIAL board is not a complete board. Every provider has always set this
  // flag and nothing has ever read it — which is how AstraZeneca quietly served
  // 1,000 of its 1,314 jobs. The tail of an ATS board is not "the foreign jobs we'd
  // drop anyway"; it's an arbitrary slice of the employer's ENTIRE global board.
  if (result.truncated) {
    stats.truncated_boards.push(
      `${board.provider}/${board.token}${board.workday?.site ? "/" + board.workday.site : ""}` +
        ` (${result.jobs.length} pulled)`
    );
  }

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
  // Which fetched pages produced a row we KEPT — the complement feeds the
  // jsonld negative cache (see recordSeenNegatives).
  const keptPages = new Set<string>();

  for (const raw of result.jobs) {
    // A UK job ad has a Latin-script title. A Cyrillic/CJK/Arabic title is a
    // foreign posting whose LOCATION the geo layer cannot read either — PepsiCo
    // writes "Москва завод Шерризон", which is not in any UK gazetteer, so the
    // job sails through as "unresolved" and the keep-unresolved policy (meant
    // for UK towns postcodes.io missed) stores it. 94 such rows were live in
    // the corpus before this check existed (2026-07-16).
    if (NON_LATIN_TITLE.test(raw.title)) {
      stats.jobs_dropped_foreign++;
      continue;
    }
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
      // The three filter dimensions, CLASSIFIED rather than copied.
      //
      // The provider's raw `job_function` is the employer's internal team name —
      // "SMB Hub", "Echo", "Somnia", "Other" — 177 distinct values across the
      // corpus. It is a signal, not a taxonomy, and a filter dropdown built on it
      // is unusable. Same for seniority: only 21% of ATS jobs carry a hint, so a
      // filter that trusted the column would hide the other 79%.
      //
      // classifyJob() folds the provider's field in as a high-confidence prior and
      // derives the rest from title + JD, so every job — ATS or aggregator — is
      // classified on the same basis. The raw employer string stays in `department`,
      // which is what we derive FROM and never filter ON.
      department: raw.department ?? raw.job_function ?? null,
      ...(() => {
        const c = classifyRawJob(raw);
        return {
          employment_type: c.employment_type,
          seniority_hint: c.seniority,
          job_function: c.job_function,
        };
      })(),
      ...geo,
      ats_board_id: board.id,
      last_seen_at: new Date().toISOString(),
    });

    const pageUrl = (raw.raw as { __pageUrl?: string } | undefined)?.__pageUrl;
    if (pageUrl) keptPages.add(pageUrl);
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

  // Fetched pages we kept nothing from — mostly a global board's foreign
  // pages, plus editorial pages living under job-ish paths. Never fetch again.
  if (result.fetchedUrls?.length) {
    const negatives = result.fetchedUrls.filter((u) => !keptPages.has(u));
    await recordSeenNegatives(board.id, negatives, "no_uk_job");
  }

  // The board's live size = newly fetched + still-listed. Counting only the
  // fetched delta would flip an incremental jsonld board to "empty" on any
  // night with no new postings.
  await markPolled(
    board.id,
    result.jobs.length + (result.stillListedUrls?.length ?? 0),
    upserted,
    null
  );
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
    truncated_boards: [],
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
        await ingestBoard(board, stats, opts, started + budgetMs);
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
    // Truncation is recorded ALONGSIDE the errors, not inside them: a partial board
    // is not a provider fault, and burying it in provider_errors would let a real
    // provider failure hide behind it.
    provider_errors: { ...stats.provider_errors, __truncated: stats.truncated_boards },
    error: problems.length ? problems.join(" | ") : null,
  });
}
