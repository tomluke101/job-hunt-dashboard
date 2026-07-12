-- HuntHQ Job Search — Companies House enrichment layer.
-- Applied 2026-07-06. See project_hunthq_job_search_plan_2026_07_01.md
-- for the design (Employer Intel panel + Company Size filter + ranking).
--
-- Data layer that feeds:
--   • Company Size filter (explicit UI, step 2)
--   • Ranking axes (size match, industry SIC match, filing recency, step 4)
--   • Employer Intel panel (later phase)
--   • Recruiter-exclusion toggle from Tom's punch list
--
-- Shared across all users. Reads are RLS'd to authenticated users. Writes
-- happen server-side via the service role (which bypasses RLS).

create table if not exists company_enrichment (
  id uuid primary key default gen_random_uuid(),

  -- Lookup keys
  normalised_name text not null unique,           -- 'TESCO PLC' -> 'tesco'
  raw_names text[] not null default '{}',         -- every raw variant we've observed

  -- Companies House primary data (nullable when unmatched)
  ch_company_number text,
  ch_company_name text,
  ch_company_status text,                         -- active / dissolved / liquidation / etc.
  ch_company_type text,                           -- ltd / plc / llp / etc.
  ch_date_of_creation date,
  ch_sic_codes text[] default '{}',
  ch_officers_active_count integer,
  ch_officers_total_count integer,
  ch_accounts_next_due date,
  ch_accounts_last_made_up_to date,
  ch_accounts_type text,                          -- micro-entity | small | medium | full | group | dormant
  ch_registered_address jsonb,

  -- Employee headcount. ONLY ever a real figure parsed from an iXBRL accounts
  -- filing — we never let a model invent a number here. Null for the ~78% of
  -- companies that don't disclose one (paper filers, micro-entity exemption).
  ch_employee_count integer,
  ch_employee_count_period_end date,
  ch_employee_count_source_url text,              -- the filing the number came from
  ch_employee_count_status text,                  -- ok | skip-dormant | skip-micro-entity | error:...
  ch_employee_count_source text,                  -- 'xbrl' | null
  ch_employee_count_reasoning text,               -- source filing URL

  -- Derived signals (rebuildable from raw CH data if the heuristic changes)
  size_bucket text,                               -- startup | small | mid | large | enterprise | unknown
  size_confidence text,                           -- high | medium | low
  -- How the band was decided:
  --   'xbrl'              real filed headcount (ground truth)
  --   'llm-band'          brand-level model answer; used when no filing discloses a count.
  --                       Large private UK firms file paper accounts, so this is the
  --                       majority source. High-confidence only — an unrecognised
  --                       company yields NO band rather than a guess.
  --   'llm-band-override' a filing existed but disagreed with the brand by >= 2 bands,
  --                       meaning Companies House matched the wrong entity (it matched
  --                       "Amazon Flex" to a 2-employee shell). The brand wins.
  --   null                unknown
  size_source text,
  size_reasoning text,
  is_likely_recruiter boolean not null default false,
  recruiter_reason text,                          -- 'sic_78109' | 'sic_78200' | 'name:hays' | null

  -- Enrichment lifecycle
  enrichment_status text not null default 'pending', -- pending | matched | unmatched | ambiguous | error
  enrichment_error text,
  candidates jsonb,                               -- top-3 CH candidates when ambiguous

  -- Book-keeping
  first_enriched_at timestamptz,
  last_refreshed_at timestamptz,
  refresh_count integer not null default 0,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists company_enrichment_normalised_name_idx on company_enrichment(normalised_name);
create index if not exists company_enrichment_ch_number_idx on company_enrichment(ch_company_number);
create index if not exists company_enrichment_size_bucket_idx on company_enrichment(size_bucket);
create index if not exists company_enrichment_status_idx on company_enrichment(enrichment_status);

alter table company_enrichment enable row level security;
create policy "enrichment readable by authenticated"
  on company_enrichment for select
  using ((auth.jwt() ->> 'sub') is not null);

-- Attach postings to their enrichment row. Nullable because enrichment
-- runs after upsert (best-effort, budget-capped) — a posting may live
-- without enrichment until the next pipeline run reaches its company.
alter table job_postings
  add column if not exists normalised_company_name text,
  add column if not exists enrichment_id uuid references company_enrichment(id) on delete set null;

create index if not exists job_postings_normalised_company_idx on job_postings(normalised_company_name);
create index if not exists job_postings_enrichment_id_idx on job_postings(enrichment_id);

-- updated_at trigger
create or replace function set_company_enrichment_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists company_enrichment_updated_at on company_enrichment;
create trigger company_enrichment_updated_at
  before update on company_enrichment
  for each row execute function set_company_enrichment_updated_at();

-- ---------------------------------------------------------------------------
-- MIGRATIONS (idempotent)
--
-- `create table if not exists` above will NOT add columns to a table that
-- already exists, so every column added after the original 2026-07-06 apply is
-- repeated here as an `add column if not exists`. Run this whole file against
-- an existing database and it converges to the current schema.
-- ---------------------------------------------------------------------------

-- 2026-07-07 — employee count parsed from iXBRL accounts filings.
alter table company_enrichment
  add column if not exists ch_accounts_type text,
  add column if not exists ch_employee_count integer,
  add column if not exists ch_employee_count_period_end date,
  add column if not exists ch_employee_count_source_url text,
  add column if not exists ch_employee_count_status text;

-- 2026-07-12 — provenance of the employee count.
alter table company_enrichment
  add column if not exists ch_employee_count_source text,
  add column if not exists ch_employee_count_reasoning text;

-- 2026-07-12 — provenance of the SIZE BAND, which is now decided separately
-- from the headcount (see the size_source comment in the table definition).
alter table company_enrichment
  add column if not exists size_source text,
  add column if not exists size_reasoning text;
