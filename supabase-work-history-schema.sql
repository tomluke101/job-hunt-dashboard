-- Run this in Supabase SQL Editor
-- Dashboard → SQL Editor → New query → paste → Run

-- Work history (employers, roles, dates) — used by the cover letter system
-- to deterministically attribute skills and achievements to the right role.
CREATE TABLE IF NOT EXISTS user_employers (
  id              uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id         text        NOT NULL,
  company_name    text        NOT NULL,
  role_title      text        NOT NULL,
  start_date      date        NOT NULL,
  end_date        date,
  is_current      boolean     DEFAULT false,
  location        text,
  employment_type text,
  summary         text,
  salary          text,
  display_order   integer     DEFAULT 0,
  created_at      timestamptz DEFAULT now(),
  updated_at      timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS user_employers_user_id_idx ON user_employers(user_id);
ALTER TABLE user_employers ENABLE ROW LEVEL SECURITY;

-- Many-to-many link between skills and employers.
-- A skill can be tagged to zero (general/innate), one, or many employers.
CREATE TABLE IF NOT EXISTS user_skill_employers (
  skill_id    uuid NOT NULL REFERENCES user_skills(id) ON DELETE CASCADE,
  employer_id uuid NOT NULL REFERENCES user_employers(id) ON DELETE CASCADE,
  PRIMARY KEY (skill_id, employer_id)
);
ALTER TABLE user_skill_employers ENABLE ROW LEVEL SECURITY;
