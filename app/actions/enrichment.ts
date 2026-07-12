"use server";

// Enrichment admin actions:
//   backfillEnrichment  — enrich all job_postings rows currently missing
//                         an enrichment_id (one budgeted batch per call).
//   refreshEnrichment   — force-refresh a single company's row.
//
// Both are Clerk-gated; only signed-in users can trigger. Companies House
// data is global so any authenticated user can trigger a backfill —
// results benefit everyone.

import { auth } from "@clerk/nextjs/server";
import { revalidatePath } from "next/cache";
import { createServerSupabaseClient } from "@/lib/supabase-server";
import { enrichBatch } from "@/lib/enrichment/batch";
import { enrichCompany } from "@/lib/enrichment/service";
import { normaliseCompanyName } from "@/lib/enrichment/normalise-company";

const BACKFILL_BUDGET_MS = 50_000; // page-level maxDuration=60 → keep ≥10s slack

export interface BackfillResult {
  processed_postings: number;         // job_postings rows updated with enrichment_id
  requested_companies: number;
  processed_companies: number;
  deferred_companies: number;
  matched: number;
  ambiguous: number;
  unmatched: number;
  errored: number;
  remaining_postings: number;         // postings still missing enrichment_id
  elapsed_ms: number;
  error?: string;
}

export async function backfillEnrichment(): Promise<BackfillResult> {
  const startedAt = Date.now();
  const empty: BackfillResult = {
    processed_postings: 0,
    requested_companies: 0,
    processed_companies: 0,
    deferred_companies: 0,
    matched: 0,
    ambiguous: 0,
    unmatched: 0,
    errored: 0,
    remaining_postings: 0,
    elapsed_ms: 0,
  };

  const { userId } = await auth();
  if (!userId) return { ...empty, error: "Unauthorised" };

  const supabase = createServerSupabaseClient();

  // Pull the next batch of unenriched postings. We cap this so one call is a
  // predictable chunk of work — click the button repeatedly to churn through.
  const { data: postings, error: postingsErr } = await supabase
    .from("job_postings")
    .select("id, company")
    .is("enrichment_id", null)
    .limit(300);
  if (postingsErr) {
    return { ...empty, error: `read job_postings: ${postingsErr.message}` };
  }

  if (!postings || postings.length === 0) {
    const { count } = await supabase
      .from("job_postings")
      .select("id", { count: "exact", head: true })
      .is("enrichment_id", null);
    return { ...empty, remaining_postings: count ?? 0, elapsed_ms: Date.now() - startedAt };
  }

  const uniqueCompanies = Array.from(
    new Set(postings.map((r) => (r.company as string) ?? "").filter(Boolean))
  );

  const { byNormalisedName, stats } = await enrichBatch(uniqueCompanies, BACKFILL_BUDGET_MS);

  // Bulk-update postings whose company we now have enrichment for.
  let processedPostings = 0;
  for (const row of postings) {
    const norm = normaliseCompanyName((row.company as string) ?? "");
    if (!norm) continue;
    const enrichment = byNormalisedName.get(norm);
    if (!enrichment) continue;
    const { error: updErr } = await supabase
      .from("job_postings")
      .update({
        normalised_company_name: norm,
        enrichment_id: enrichment.id,
      })
      .eq("id", row.id);
    if (updErr) {
      console.error("[backfillEnrichment] posting update failed", updErr);
      continue;
    }
    processedPostings++;
  }

  // Aggregate outcome counts across the batch.
  let matched = 0, ambiguous = 0, unmatched = 0, errored = 0;
  for (const e of byNormalisedName.values()) {
    if (e.enrichment_status === "matched") matched++;
    else if (e.enrichment_status === "ambiguous") ambiguous++;
    else if (e.enrichment_status === "unmatched") unmatched++;
    else if (e.enrichment_status === "error") errored++;
  }

  const { count: remaining } = await supabase
    .from("job_postings")
    .select("id", { count: "exact", head: true })
    .is("enrichment_id", null);

  revalidatePath("/debug/enrichment");

  return {
    processed_postings: processedPostings,
    requested_companies: stats.requested,
    processed_companies: stats.processed,
    deferred_companies: stats.deferred,
    matched,
    ambiguous,
    unmatched,
    errored,
    remaining_postings: remaining ?? 0,
    elapsed_ms: Date.now() - startedAt,
  };
}

export interface ReEnrichResult {
  attempted: number;
  succeeded: number;
  failed: number;
  deferred: number;
  elapsed_ms: number;
  remaining_stale: number;
  error?: string;
}

/**
 * Force-refresh every existing enrichment row. Used after a heuristic change
 * (e.g. adding statutory accounts-type as the primary size signal) so cached
 * rows re-derive with the new logic without waiting for the 90-day TTL.
 *
 * Runs one budgeted chunk per call — click again to work through the rest.
 * Marks rows as "needing refresh" by nulling their `last_refreshed_at` first,
 * so the enrichCompany cache path treats them as stale.
 */
export async function reEnrichAll(): Promise<ReEnrichResult> {
  const startedAt = Date.now();
  const empty: ReEnrichResult = {
    attempted: 0, succeeded: 0, failed: 0, deferred: 0,
    elapsed_ms: 0, remaining_stale: 0,
  };
  const { userId } = await auth();
  if (!userId) return { ...empty, error: "Unauthorised" };
  const supabase = createServerSupabaseClient();

  // Mark ALL rows stale on the first call — cheap, idempotent, ensures the
  // stale check inside enrichCompany fires no matter which chunk we're on.
  await supabase
    .from("company_enrichment")
    .update({ last_refreshed_at: null })
    .not("id", "is", null);

  const { data: rows, error } = await supabase
    .from("company_enrichment")
    .select("id, raw_names, normalised_name")
    .is("last_refreshed_at", null)
    .limit(60);   // ~3 CH calls each × 550ms → fits in the 50s budget
  if (error) return { ...empty, error: `read rows: ${error.message}` };
  if (!rows || rows.length === 0) return { ...empty, elapsed_ms: Date.now() - startedAt };

  const rawNames = rows.map(
    (r) => ((r.raw_names as string[] | null)?.[0]) ?? (r.normalised_name as string)
  ).filter(Boolean);

  const { byNormalisedName, stats } = await enrichBatch(rawNames, BACKFILL_BUDGET_MS);

  let succeeded = 0, failed = 0;
  for (const row of byNormalisedName.values()) {
    if (row.enrichment_status === "matched" || row.enrichment_status === "unmatched" ||
        row.enrichment_status === "ambiguous") {
      succeeded++;
    } else {
      failed++;
    }
  }

  const { count: remaining } = await supabase
    .from("company_enrichment")
    .select("id", { count: "exact", head: true })
    .is("last_refreshed_at", null);

  revalidatePath("/debug/enrichment");
  return {
    attempted: stats.processed,
    succeeded,
    failed,
    deferred: stats.deferred,
    elapsed_ms: Date.now() - startedAt,
    remaining_stale: remaining ?? 0,
  };
}

/**
 * Force-refresh a single company by raw name (bypasses the 90-day stale cache).
 */
export async function refreshCompany(rawName: string): Promise<{ ok: boolean; error?: string }> {
  const { userId } = await auth();
  if (!userId) return { ok: false, error: "Unauthorised" };
  if (!rawName?.trim()) return { ok: false, error: "Empty name" };
  const supabase = createServerSupabaseClient();
  const norm = normaliseCompanyName(rawName);
  if (norm) {
    await supabase
      .from("company_enrichment")
      .update({ last_refreshed_at: null })
      .eq("normalised_name", norm);
  }
  const row = await enrichCompany(rawName);
  revalidatePath("/debug/enrichment");
  return row ? { ok: true } : { ok: false, error: "Enrichment returned null" };
}

export interface EnrichmentAttentionRow {
  normalised_name: string;
  ch_company_name: string | null;
  enrichment_status: string;
  size_bucket: string | null;
  ch_accounts_type: string | null;
  ch_company_status: string | null;
  candidates: Array<{ company_number: string; title: string; company_status?: string; company_type?: string }>;
  enrichment_error: string | null;
  raw_names: string[];
}

export interface EnrichmentStatusSummary {
  total: number;
  by_status: Record<string, number>;
  by_size: Record<string, number>;
  by_confidence: Record<string, number>;
  recruiters_flagged: number;
  with_employee_count: number;
  postings_total: number;
  postings_enriched: number;
  postings_missing: number;
  recent: Array<{
    normalised_name: string;
    ch_company_name: string | null;
    enrichment_status: string;
    size_bucket: string | null;
    size_confidence: string | null;
    is_likely_recruiter: boolean;
    ch_sic_codes: string[];
    ch_accounts_type: string | null;
    ch_officers_active_count: number | null;
    ch_officers_total_count: number | null;
    ch_employee_count: number | null;
    ch_employee_count_period_end: string | null;
    ch_employee_count_status: string | null;
    last_refreshed_at: string | null;
    enrichment_error: string | null;
  }>;
  attention: EnrichmentAttentionRow[];
}

export async function getEnrichmentSummary(): Promise<EnrichmentStatusSummary> {
  const supabase = createServerSupabaseClient();
  const empty: EnrichmentStatusSummary = {
    total: 0,
    by_status: {},
    by_size: {},
    by_confidence: {},
    recruiters_flagged: 0,
    with_employee_count: 0,
    postings_total: 0,
    postings_enriched: 0,
    postings_missing: 0,
    recent: [],
    attention: [],
  };

  const [{ data: all }, { count: postingsTotal }, { count: postingsMissing }, { data: attentionRaw }] = await Promise.all([
    supabase
      .from("company_enrichment")
      .select(
        "normalised_name, ch_company_name, enrichment_status, size_bucket, size_confidence, is_likely_recruiter, ch_sic_codes, ch_accounts_type, ch_officers_active_count, ch_officers_total_count, ch_employee_count, ch_employee_count_period_end, ch_employee_count_status, last_refreshed_at, enrichment_error, updated_at"
      )
      .order("updated_at", { ascending: false })
      .limit(2000),
    supabase.from("job_postings").select("id", { count: "exact", head: true }),
    supabase.from("job_postings").select("id", { count: "exact", head: true }).is("enrichment_id", null),
    // Rows that need a human look: ambiguous, unmatched matches we might revisit,
    // or matched-but-unknown-bucket (dormant shell / dissolved / no data).
    supabase
      .from("company_enrichment")
      .select(
        "normalised_name, ch_company_name, enrichment_status, size_bucket, ch_accounts_type, ch_company_status, candidates, enrichment_error, raw_names, updated_at"
      )
      .or("enrichment_status.eq.ambiguous,size_bucket.eq.unknown,size_bucket.is.null")
      .order("updated_at", { ascending: false })
      .limit(100),
  ]);

  if (!all) return empty;

  const by_status: Record<string, number> = {};
  const by_size: Record<string, number> = {};
  const by_confidence: Record<string, number> = {};
  let recruiters = 0;
  let withEmpCount = 0;
  for (const row of all) {
    const st = (row.enrichment_status as string) ?? "unknown";
    by_status[st] = (by_status[st] ?? 0) + 1;
    const sb = (row.size_bucket as string) ?? "unknown";
    by_size[sb] = (by_size[sb] ?? 0) + 1;
    const sc = (row.size_confidence as string) ?? "unknown";
    by_confidence[sc] = (by_confidence[sc] ?? 0) + 1;
    if (row.is_likely_recruiter) recruiters++;
    if (row.ch_employee_count !== null && row.ch_employee_count !== undefined) withEmpCount++;
  }

  return {
    total: all.length,
    by_status,
    by_size,
    by_confidence,
    recruiters_flagged: recruiters,
    with_employee_count: withEmpCount,
    postings_total: postingsTotal ?? 0,
    postings_enriched: (postingsTotal ?? 0) - (postingsMissing ?? 0),
    postings_missing: postingsMissing ?? 0,
    recent: all.slice(0, 30).map((r) => ({
      normalised_name: r.normalised_name as string,
      ch_company_name: (r.ch_company_name as string | null) ?? null,
      enrichment_status: (r.enrichment_status as string) ?? "",
      size_bucket: (r.size_bucket as string | null) ?? null,
      size_confidence: (r.size_confidence as string | null) ?? null,
      is_likely_recruiter: !!r.is_likely_recruiter,
      ch_sic_codes: (r.ch_sic_codes as string[] | null) ?? [],
      ch_accounts_type: (r.ch_accounts_type as string | null) ?? null,
      ch_officers_active_count: (r.ch_officers_active_count as number | null) ?? null,
      ch_officers_total_count: (r.ch_officers_total_count as number | null) ?? null,
      ch_employee_count: (r.ch_employee_count as number | null) ?? null,
      ch_employee_count_period_end: (r.ch_employee_count_period_end as string | null) ?? null,
      ch_employee_count_status: (r.ch_employee_count_status as string | null) ?? null,
      last_refreshed_at: (r.last_refreshed_at as string | null) ?? null,
      enrichment_error: (r.enrichment_error as string | null) ?? null,
    })),
    attention: (attentionRaw ?? []).map((r) => {
      const raw = (r.candidates as unknown) ?? [];
      const cands = (Array.isArray(raw) ? raw : []).slice(0, 3).map((c) => {
        const rec = (c ?? {}) as Record<string, unknown>;
        return {
          company_number: (rec.company_number as string) ?? "",
          title: (rec.title as string) ?? "",
          company_status: (rec.company_status as string) ?? undefined,
          company_type: (rec.company_type as string) ?? undefined,
        };
      });
      return {
        normalised_name: r.normalised_name as string,
        ch_company_name: (r.ch_company_name as string | null) ?? null,
        enrichment_status: (r.enrichment_status as string) ?? "",
        size_bucket: (r.size_bucket as string | null) ?? null,
        ch_accounts_type: (r.ch_accounts_type as string | null) ?? null,
        ch_company_status: (r.ch_company_status as string | null) ?? null,
        candidates: cands,
        enrichment_error: (r.enrichment_error as string | null) ?? null,
        raw_names: (r.raw_names as string[] | null) ?? [],
      };
    }),
  };
}
