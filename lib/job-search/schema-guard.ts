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

/** Test seam — reset the memoised probe. */
export function __resetSchemaGuard(): void {
  cached = null;
}
