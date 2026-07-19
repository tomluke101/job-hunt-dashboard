// Batch enrichment with a hard time budget.
//
// The pipeline calls this after ranking on the top-K postings. Two-phase
// design so the wall-clock cost is dominated by real CH work, not DB
// round-trips:
//
//   PHASE 1 — one-shot cache lookup for every normalised name in the batch.
//     ~ single DB query, returns cached-and-fresh rows immediately.
//   PHASE 2 — serial enrichCompany for cache misses / stale rows, budget-
//     capped. Each fresh CH fetch is ~3-6 seconds; cache misses are what
//     eats the budget.
//
// Return shape: Map<normalisedName, EnrichmentRow>.

import { createServerSupabaseClient } from "@/lib/supabase-server";
import { enrichCompany } from "./service";
import { normaliseCompanyName } from "./normalise-company";
import type { EnrichmentRow } from "./types";

const STALE_AFTER_DAYS = 90;
const STALE_MS = STALE_AFTER_DAYS * 86400_000;

export interface EnrichBatchStats {
  requested: number;      // unique normalised names in input
  cache_hits: number;     // rows served from Phase 1 lookup
  fresh_enriched: number; // rows enriched from CH in Phase 2
  deferred: number;       // cache misses left for the background sweep (budget / cacheOnly)
  budget_ms: number;
  elapsed_ms: number;
  processed: number;      // cache_hits + fresh_enriched (for backwards compat)
  cache_only?: boolean;   // true when Phase 2 (fresh CH work) was skipped entirely
}

export interface EnrichBatchResult {
  byNormalisedName: Map<string, EnrichmentRow>;
  stats: EnrichBatchStats;
}

function isFreshCachedRow(row: Pick<EnrichmentRow, "last_refreshed_at" | "enrichment_status">): boolean {
  if (row.enrichment_status === "error") return false;
  if (!row.last_refreshed_at) return false;
  const age = Date.now() - new Date(row.last_refreshed_at).getTime();
  return age < STALE_MS;
}

export async function enrichBatch(
  rawNames: string[],
  budgetMs = 45_000,
  opts?: { cacheOnly?: boolean }
): Promise<EnrichBatchResult> {
  // cacheOnly: serve only what's already cached (Phase 1) and skip every fresh
  // CH lookup (Phase 2). The hot search path uses this so a run never blocks on
  // 3-6s-per-company enrichment; the post-response sweep does the fresh work.
  const cacheOnly = opts?.cacheOnly === true;
  const startedAt = Date.now();
  const byNorm = new Map<string, EnrichmentRow>();

  // Dedupe input to unique normalised names.
  const uniqueNames = new Map<string, string>();   // normalised -> raw
  for (const raw of rawNames) {
    const n = normaliseCompanyName(raw);
    if (!n || uniqueNames.has(n)) continue;
    uniqueNames.set(n, raw);
  }
  const total = uniqueNames.size;
  if (total === 0) {
    return {
      byNormalisedName: byNorm,
      stats: {
        requested: 0, cache_hits: 0, fresh_enriched: 0, deferred: 0,
        budget_ms: budgetMs, elapsed_ms: Date.now() - startedAt,
        processed: 0, cache_only: cacheOnly,
      },
    };
  }

  // PHASE 1 — one query for all cached rows.
  const supabase = createServerSupabaseClient();
  const normalisedList = Array.from(uniqueNames.keys());
  let cacheHits = 0;
  {
    const { data: cachedRows } = await supabase
      .from("company_enrichment")
      .select("*")
      .in("normalised_name", normalisedList);
    if (cachedRows) {
      for (const row of cachedRows as EnrichmentRow[]) {
        if (isFreshCachedRow(row)) {
          byNorm.set(row.normalised_name, row);
          uniqueNames.delete(row.normalised_name);
          cacheHits++;
        }
      }
    }
  }

  // PHASE 2 — serial CH-backed enrichment for the remaining names.
  // Budget-capped: cache misses are the slow work. Skipped entirely in cacheOnly
  // mode (the hot path), where these misses are left for the background sweep.
  let freshEnriched = 0;
  if (!cacheOnly) {
    for (const [, raw] of uniqueNames) {
      if (Date.now() - startedAt > budgetMs) break;
      try {
        const row = await enrichCompany(raw);
        if (row) {
          byNorm.set(row.normalised_name, row);
          freshEnriched++;
        }
      } catch (err) {
        console.error("[enrichBatch] enrichCompany threw", err);
      }
    }
  }

  const processed = cacheHits + freshEnriched;
  return {
    byNormalisedName: byNorm,
    stats: {
      requested: total,
      cache_hits: cacheHits,
      fresh_enriched: freshEnriched,
      deferred: total - processed,
      budget_ms: budgetMs,
      elapsed_ms: Date.now() - startedAt,
      processed,
      cache_only: cacheOnly,
    },
  };
}
