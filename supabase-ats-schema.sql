-- HuntHQ — ATS-direct job supply. Applied 2026-07-12.
--
-- Reed + Adzuna are commodity aggregators every competitor also uses: recruiter-
-- saturated, and Reed keyword-matches the JD BODY (it returns Class 2 HGV Driver
-- ads for "supply chain analyst"). Ingesting straight from employers' own
-- applicant-tracking systems gives us zero recruiters BY CONSTRUCTION, fresher
-- postings, cleaner structure, and it's free — and it's the "curated companies"
-- feature from the master plan, arriving as infrastructure.
--
-- Idempotent. Safe to re-run.

-- ---------------------------------------------------------------------------
-- 1. The registry: which company is on which ATS, and where.
-- ---------------------------------------------------------------------------
create table if not exists company_ats (
  id uuid primary key default gen_random_uuid(),

  -- Joins to company_enrichment.normalised_name (same normaliser, deliberately).
  normalised_name text not null,
  company_name text not null,

  provider text not null,          -- greenhouse | lever | ashby | smartrecruiters | recruitee | workday | workable
  board_token text not null,       -- the board id. For Workday this is the tenant.

  -- Workday alone needs three coordinates: one tenant can host several career
  -- sites, and the datacenter (wd3 / wd5 / ...) differs per tenant.
  --   {tenant}.{host}/wday/cxs/{tenant}/{site}/jobs
  workday_tenant text,
  workday_host text,               -- e.g. 'wd3.myworkdayjobs.com'
  workday_site text,               -- e.g. 'Careers'

  careers_url text,

  -- active   : polling, has returned jobs
  -- empty    : board resolves but has 0 open roles (a REAL state — the employer
  --            simply isn't hiring. Keep polling; do not delete.)
  -- dead     : repeatedly failing; stop polling
  -- unverified: discovered but not yet confirmed to belong to this company
  status text not null default 'active',

  -- How we found it, so a bad discovery method can be audited and rolled back.
  discovered_via text,             -- token-probe | careers-crawl | seed | manual

  -- What the BOARD says its company is. Compared against company_name to catch
  -- token collisions — without this, guessing the token 'monzo' could silently
  -- attach some other Monzo's jobs to the bank.
  board_company_name text,
  verified_at timestamptz,

  last_polled_at timestamptz,
  last_job_count integer,
  total_jobs_ingested integer not null default 0,
  consecutive_failures integer not null default 0,
  last_error text,

  enrichment_id uuid references company_enrichment(id) on delete set null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One row per board.
--
-- workday_site is nullable and Postgres treats NULLs as DISTINCT, so a plain
-- unique(provider, board_token, workday_site) would allow duplicate (provider,
-- token) rows for every non-Workday provider. NULLS NOT DISTINCT (PG15+) closes
-- that hole.
--
-- It must NOT be an expression index like coalesce(workday_site,''): PostgREST's
-- upsert issues ON CONFLICT (provider, board_token, workday_site), which cannot
-- match an expression index. That version rejected every write with "no unique or
-- exclusion constraint matching the ON CONFLICT specification" — while discovery
-- reported all 38 boards found. Registry stayed empty; the failure only surfaced
-- later as "no pollable boards".
drop index if exists company_ats_board_uniq;
create unique index if not exists company_ats_board_uniq
  on company_ats(provider, board_token, workday_site) nulls not distinct;
create index if not exists company_ats_normalised_name_idx on company_ats(normalised_name);
create index if not exists company_ats_status_idx on company_ats(status);
create index if not exists company_ats_last_polled_idx on company_ats(last_polled_at nulls first);

alter table company_ats enable row level security;
create policy "ats registry readable by authenticated"
  on company_ats for select
  using ((auth.jwt() ->> 'sub') is not null);

-- ---------------------------------------------------------------------------
-- 2. Negative-result cache for discovery.
--
-- Discovery probes ~7 providers per company. With thousands of employers that is
-- tens of thousands of HTTP requests — and MOST companies are not on a public
-- ATS at all. Without remembering the misses, every ingest re-probes every
-- hopeless company forever. This table is what makes discovery affordable at scale.
-- ---------------------------------------------------------------------------
create table if not exists company_ats_discovery (
  normalised_name text primary key,
  company_name text,
  found boolean not null default false,
  providers_tried text[] not null default '{}',
  attempts integer not null default 1,
  last_attempt_at timestamptz not null default now(),
  -- Re-probe misses occasionally: a company that wasn't on Greenhouse last month
  -- may have migrated onto it. Never re-probe before this.
  retry_after timestamptz,
  notes text
);

create index if not exists company_ats_discovery_retry_idx on company_ats_discovery(retry_after);

alter table company_ats_discovery enable row level security;
create policy "ats discovery readable by authenticated"
  on company_ats_discovery for select
  using ((auth.jwt() ->> 'sub') is not null);

-- ---------------------------------------------------------------------------
-- 3. job_postings becomes a CORPUS, not just a per-run scratchpad.
--
-- ATS boards can't be queried per-search (they have no keyword or radius
-- parameter — you get the company's entire global board or nothing). So a
-- background worker ingests every board into job_postings, and SEARCH TIME
-- queries this table locally. That is what makes ATS-direct the DEFAULT supply
-- rather than a bolt-on, and it's why these columns have to be indexed for
-- querying rather than merely stored.
-- ---------------------------------------------------------------------------
alter table job_postings
  -- Cross-source identity. The same role arrives via Reed AND Adzuna AND the
  -- employer's own board; dedupe_hash can't see that (it hashes the JD text, and
  -- every source rewrites the JD). See lib/job-search/canonical.ts.
  add column if not exists canonical_key text,
  add column if not exists also_seen_on text[] default '{}',

  -- Structured fields the aggregators simply do not give us. Captured at ingest
  -- so the job-type / seniority / job-function filters can ship WITHOUT a full
  -- re-ingest of the corpus later.
  add column if not exists department text,
  add column if not exists employment_type text,
  add column if not exists seniority_hint text,
  add column if not exists job_function text,

  -- Resolved geography. Before ATS the pipeline had NO post-pull distance filter
  -- — it trusted each source's server-side radius search. ATS boards vouch for
  -- nothing: they return Palo Alto and Seoul alongside London. See lib/geo.
  add column if not exists is_remote boolean,
  add column if not exists country_code text,
  add column if not exists place_name text,
  add column if not exists lat double precision,
  add column if not exists lng double precision,
  add column if not exists geo_resolved boolean default false,

  add column if not exists ats_board_id uuid references company_ats(id) on delete set null;

create index if not exists job_postings_canonical_key_idx on job_postings(canonical_key);
-- Bounding-box prefilter for the radius search. Cheap, no PostGIS needed: narrow
-- to a lat/lng box in SQL, then compute exact haversine on the survivors in JS.
create index if not exists job_postings_latlng_idx on job_postings(lat, lng);
create index if not exists job_postings_source_idx on job_postings(source);
create index if not exists job_postings_remote_idx on job_postings(is_remote) where is_remote = true;
create index if not exists job_postings_last_seen_idx on job_postings(last_seen_at desc);

-- Title prefilter for the corpus query. Trigram, so `title ilike '%analyst%'`
-- uses an index instead of sequential-scanning a corpus of hundreds of thousands
-- of postings.
create extension if not exists pg_trgm;
create index if not exists job_postings_title_trgm_idx on job_postings using gin (title gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- 4. Ingest run audit. Same reasoning as job_search_runs: a source that returns
--    ZERO looks exactly like "no jobs matched" unless the counts are recorded and
--    asserted. Adzuna returned zero for TEN DAYS and nothing surfaced it.
-- ---------------------------------------------------------------------------
create table if not exists ats_ingest_runs (
  id uuid primary key default gen_random_uuid(),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  trigger text not null default 'manual',    -- manual | cron
  boards_polled integer not null default 0,
  boards_failed integer not null default 0,
  jobs_seen integer not null default 0,
  jobs_upserted integer not null default 0,
  jobs_dropped_foreign integer not null default 0,
  jobs_dropped_unresolved integer not null default 0,
  -- Per-provider counts. A provider sitting at 0 across every one of its boards
  -- is a DEAD PROVIDER, not an empty job market — assertProviderHealth() reads this.
  provider_counts jsonb,
  provider_errors jsonb,
  error text
);

alter table ats_ingest_runs enable row level security;
create policy "ingest runs readable by authenticated"
  on ats_ingest_runs for select
  using ((auth.jwt() ->> 'sub') is not null);

-- updated_at trigger for the registry
create or replace function set_company_ats_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists company_ats_updated_at on company_ats;
create trigger company_ats_updated_at
  before update on company_ats
  for each row execute function set_company_ats_updated_at();
