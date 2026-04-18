-- Run this in Supabase SQL Editor
-- Dashboard → SQL Editor → New query → paste → Run

-- Work location on applications
ALTER TABLE applications ADD COLUMN IF NOT EXISTS work_location text;

-- User profile (constants: name, contact, sign-off, tone)
CREATE TABLE IF NOT EXISTS user_profile (
  id           uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id      text        UNIQUE NOT NULL,
  full_name    text,
  email        text,
  phone        text,
  linkedin_url text,
  location     text,
  headline     text,
  sign_off     text        DEFAULT 'Kind regards',
  tone         text        DEFAULT 'balanced',
  updated_at   timestamptz DEFAULT now()
);
ALTER TABLE user_profile ENABLE ROW LEVEL SECURITY;

-- User CVs (multiple supported, one marked as default)
CREATE TABLE IF NOT EXISTS user_cvs (
  id         uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id    text        NOT NULL,
  name       text        NOT NULL DEFAULT 'My CV',
  content    text        NOT NULL,
  is_default boolean     DEFAULT false,
  created_at timestamptz DEFAULT now()
);
ALTER TABLE user_cvs ENABLE ROW LEVEL SECURITY;

-- Skills and experience (raw + AI-polished versions)
CREATE TABLE IF NOT EXISTS user_skills (
  id           uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id      text        NOT NULL,
  raw_text     text        NOT NULL,
  polished_text text,
  created_at   timestamptz DEFAULT now()
);
ALTER TABLE user_skills ENABLE ROW LEVEL SECURITY;

-- Writing style examples (past cover letters to copy voice from)
CREATE TABLE IF NOT EXISTS user_writing_examples (
  id         uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id    text        NOT NULL,
  label      text,
  content    text        NOT NULL,
  created_at timestamptz DEFAULT now()
);
ALTER TABLE user_writing_examples ENABLE ROW LEVEL SECURITY;
