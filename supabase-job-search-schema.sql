-- HuntHQ Job Search (Phase 5) — SaaS-multi-tenant schema.
-- Applied 2026-07-01. See project_hunthq_job_search_plan_2026_07_01.md for design.

-- Saved job searches (per-user, N per user)
create table if not exists job_searches (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  name text not null,
  description text,
  criteria jsonb not null default '{}'::jsonb,
  weights jsonb not null default '{}'::jsonb,
  ranking_weights jsonb not null default '{"match_to_search":0.4,"match_to_user":0.3,"quality":0.2,"career_fit":0.1}'::jsonb,
  schedule_cron text,
  jobs_per_run integer not null default 10,
  active boolean not null default true,
  auto_gen_summary boolean not null default true,
  auto_gen_cv boolean not null default false,
  auto_gen_cl boolean not null default false,
  last_run_at timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table job_searches enable row level security;
create policy "Users manage own searches"
  on job_searches for all
  using (user_id = (auth.jwt() ->> 'sub'));

-- Sources enabled per search
create table if not exists job_search_sources (
  id uuid primary key default gen_random_uuid(),
  search_id uuid not null references job_searches(id) on delete cascade,
  source_type text not null,
  config jsonb not null default '{}'::jsonb,
  enabled boolean not null default true,
  created_at timestamptz default now()
);

alter table job_search_sources enable row level security;
create policy "Users manage sources for own searches"
  on job_search_sources for all
  using (search_id in (select id from job_searches where user_id = (auth.jwt() ->> 'sub')));

-- Curated ATS-companies the user follows
create table if not exists curated_companies (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  company_name text not null,
  ats_type text,
  ats_id text,
  careers_url text,
  active boolean not null default true,
  last_polled_at timestamptz,
  added_at timestamptz default now(),
  unique(user_id, ats_type, ats_id)
);

alter table curated_companies enable row level security;
create policy "Users manage own curated companies"
  on curated_companies for all
  using (user_id = (auth.jwt() ->> 'sub'));

-- Canonical normalised job postings (SHARED across users — dedupe target)
-- Access is controlled via job_shortlist which IS per-user + RLS.
create table if not exists job_postings (
  id uuid primary key default gen_random_uuid(),
  source text not null,
  source_id text not null,
  source_url text,
  company text not null,
  title text not null,
  location_raw text,
  location_town text,
  location_postcode text,
  location_lat double precision,
  location_lng double precision,
  working_model text,
  hybrid_days_office integer,
  salary_min integer,
  salary_max integer,
  salary_currency text default 'GBP',
  salary_listed boolean not null default false,
  seniority text,
  industry text,
  jd_text text not null,
  jd_html text,
  posted_at timestamptz,
  expires_at timestamptz,
  dedupe_hash text not null,
  quality_score integer,
  employer_intel jsonb,
  first_seen_at timestamptz default now(),
  last_seen_at timestamptz default now(),
  unique(source, source_id)
);

create index if not exists job_postings_dedupe_hash_idx on job_postings(dedupe_hash);
create index if not exists job_postings_posted_at_idx on job_postings(posted_at desc);

-- Per-user shortlist
create table if not exists job_shortlist (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  search_id uuid not null references job_searches(id) on delete cascade,
  posting_id uuid not null references job_postings(id) on delete cascade,
  state text not null default 'new',
  reject_reason text,
  match_to_search_score integer,
  match_to_user_score integer,
  quality_score integer,
  career_fit_score integer,
  composite_rank integer,
  ranking_explanation jsonb,
  jd_fit_summary text,
  application_id uuid references applications(id) on delete set null,
  seen_at timestamptz default now(),
  decided_at timestamptz,
  deleted_at timestamptz,
  unique(user_id, search_id, posting_id)
);

create index if not exists job_shortlist_user_state_idx on job_shortlist(user_id, state, composite_rank desc);

alter table job_shortlist enable row level security;
create policy "Users see own shortlist"
  on job_shortlist for all
  using (user_id = (auth.jwt() ->> 'sub'));

-- Audit log per run
create table if not exists job_search_runs (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  search_id uuid not null references job_searches(id) on delete cascade,
  trigger text not null,
  started_at timestamptz default now(),
  finished_at timestamptz,
  source_counts jsonb,
  dedupe_stats jsonb,
  filter_drops jsonb,
  shortlist_count integer,
  cost_tokens integer,
  error text
);

alter table job_search_runs enable row level security;
create policy "Users see own runs"
  on job_search_runs for all
  using (user_id = (auth.jwt() ->> 'sub'));

-- Per-user learned ranking weights (feedback loop, Phase 5+)
create table if not exists user_ranking_weights (
  user_id text primary key,
  weights jsonb not null default '{"match_to_search":0.4,"match_to_user":0.3,"quality":0.2,"career_fit":0.1}'::jsonb,
  reject_reason_downweights jsonb not null default '{}'::jsonb,
  updated_at timestamptz default now()
);

alter table user_ranking_weights enable row level security;
create policy "Users manage own ranking weights"
  on user_ranking_weights for all
  using (user_id = (auth.jwt() ->> 'sub'));
