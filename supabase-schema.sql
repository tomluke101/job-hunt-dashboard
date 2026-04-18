-- Applications
create table if not exists applications (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  role text not null,
  company text not null,
  location text,
  status text not null default 'applied',
  stage text,
  applied_date date,
  salary text,
  url text,
  notes text,
  category text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table applications enable row level security;

create policy "Users see own applications"
  on applications for all
  using (user_id = (auth.jwt() ->> 'sub'));

-- API Keys
create table if not exists user_api_keys (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  provider text not null,
  api_key text not null,
  key_preview text not null,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique(user_id, provider)
);

alter table user_api_keys enable row level security;

create policy "Users manage own API keys"
  on user_api_keys for all
  using (user_id = (auth.jwt() ->> 'sub'));

-- User profile (CV, writing samples)
create table if not exists user_profile (
  id uuid primary key default gen_random_uuid(),
  user_id text not null unique,
  full_name text,
  base_cv text,
  writing_samples text[],
  target_roles text[],
  target_locations text[],
  salary_min integer,
  salary_max integer,
  remote_preference text default 'any',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table user_profile enable row level security;

create policy "Users manage own profile"
  on user_profile for all
  using (user_id = (auth.jwt() ->> 'sub'));

-- Cover letters
create table if not exists cover_letters (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  application_id uuid references applications(id) on delete cascade,
  content text not null,
  created_at timestamptz default now()
);

alter table cover_letters enable row level security;

create policy "Users see own cover letters"
  on cover_letters for all
  using (user_id = (auth.jwt() ->> 'sub'));

-- CV versions
create table if not exists cv_versions (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  application_id uuid references applications(id) on delete cascade,
  content text not null,
  created_at timestamptz default now()
);

alter table cv_versions enable row level security;

create policy "Users see own CV versions"
  on cv_versions for all
  using (user_id = (auth.jwt() ->> 'sub'));
