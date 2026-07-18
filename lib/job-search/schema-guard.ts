// Is the ATS/corpus migration live on THIS database?
//
// The pipeline writes canonical_key, lat/lng, employment_type and friends. Those
// columns arrive via supabase-ats-schema.sql, which is applied by hand in the
// Supabase SQL editor (project convention). So there is an unavoidable window —
// and an unavoidable ORDERING RISK — between deploying the code and running the SQL.
//
// Without this guard, deploying first means PostgREST rejects every job_postings
// upsert with "Could not find the 'canonical_key' column", the pipeline logs it and
// continues, and EVERY SEARCH SILENTLY RETURNS ZERO JOBS. A broken search that
// looks like an empty job market is the single failure mode this codebase keeps
// getting bitten by — Adzuna returned nothing for ten days on exactly that shape.
//
// So: probe once per process, cache, and degrade honestly. Code and schema can then
// be deployed in either order and nothing breaks.

import type { SupabaseClient } from "@supabase/supabase-js";

let cached: boolean | null = null;

export async function atsColumnsAvailable(supabase: SupabaseClient): Promise<boolean> {
  if (cached !== null) return cached;
  const { error } = await supabase.from("job_postings").select("canonical_key").limit(1);
  cached = !error;
  if (!cached) {
    console.warn(
      "[schema-guard] job_postings.canonical_key is missing — the ATS migration has " +
        "not been applied to this database. Running in LEGACY mode: ATS supply is OFF, " +
        "cross-source dedupe is OFF, distance filtering is OFF. Apply supabase-ats-schema.sql."
    );
  }
  return cached;
}

let embeddingsCached: boolean | null = null;

/**
 * Is the embeddings migration (supabase-embeddings-schema.sql) live on THIS
 * database? Same reasoning and same hand-applied-SQL ordering risk as
 * atsColumnsAvailable: the pipeline may deploy before the SQL is run. Selecting
 * jd_embedding when the column doesn't exist errors the WHOLE query — so we probe
 * once, cache, and let the caller drop the semantic axis (ranking still works on
 * the heuristic axes) instead of failing the search.
 */
export async function embeddingColumnsAvailable(supabase: SupabaseClient): Promise<boolean> {
  if (embeddingsCached !== null) return embeddingsCached;
  const { error } = await supabase.from("job_postings").select("jd_embedding").limit(1);
  embeddingsCached = !error;
  if (!embeddingsCached) {
    console.warn(
      "[schema-guard] job_postings.jd_embedding is missing — the embeddings migration " +
        "has not been applied. Semantic ranking is OFF; ranking falls back to the " +
        "heuristic axes. Apply supabase-embeddings-schema.sql."
    );
  }
  return embeddingsCached;
}

/** Test seam — reset the memoised probes. */
export function __resetSchemaGuard(): void {
  cached = null;
  embeddingsCached = null;
}
