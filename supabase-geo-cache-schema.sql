-- geo_cache — persistent cache for lib/geo's postcodes.io lookups.
--
-- WHY
-- ATS boards return the employer's ENTIRE GLOBAL board, so every ingest run has
-- to resolve thousands of free-text location strings itself. The set of DISTINCT
-- strings is small and very repetitive ("London", "Remote (UK)", "Manchester"),
-- so a cache turns thousands of HTTP round-trips into a handful.
--
-- NEGATIVE RESULTS ARE CACHED TOO (resolved = false). Without that, every run
-- re-queries postcodes.io for the same few hundred permanently-unresolvable
-- strings ("Gaithersburg", "Global", "TBD", "Europe") forever.
--
-- `query` is the NORMALISED lookup key (lowercase, accents and punctuation
-- stripped, whitespace collapsed) — see normalise() in lib/geo/gazetteer.ts.
-- Idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS geo_cache (
  query      text PRIMARY KEY,
  lat        double precision,
  lng        double precision,
  country    text,                      -- ISO-2, uppercase. NULL when unresolved.
  name       text,                      -- canonical place name as resolved
  resolved   boolean     NOT NULL,      -- false = a cached MISS. Do not re-query.
  source     text,                      -- 'postcodes.io' | 'postcodes.io:miss'
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS geo_cache_resolved_idx ON geo_cache(resolved);

-- Not user data: this is a shared, public-facts lookup table (place -> lat/lng),
-- written only by the server-side ingest worker via the service-role key. RLS is
-- enabled with no policy, so the anon key can neither read nor write it, while
-- the service role bypasses RLS as usual.
ALTER TABLE geo_cache ENABLE ROW LEVEL SECURITY;
