-- Run this in Supabase SQL Editor
-- Dashboard → SQL Editor → New query → paste → Run

CREATE TABLE IF NOT EXISTS user_task_preferences (
  id         uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id    text        NOT NULL,
  task       text        NOT NULL,
  provider   text        NOT NULL,
  updated_at timestamptz DEFAULT now(),
  UNIQUE (user_id, task)
);

ALTER TABLE user_task_preferences ENABLE ROW LEVEL SECURITY;
