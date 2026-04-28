-- Cache the AI-parsed structured output per base CV.
-- The CV parse is the most expensive step in CV tailoring (Anthropic call over
-- the full CV text). Once the CV is parsed, the result is reused across every
-- subsequent tailoring run until the CV content changes.

CREATE TABLE IF NOT EXISTS cv_parsed_cache (
  cv_id        uuid        PRIMARY KEY REFERENCES user_cvs(id) ON DELETE CASCADE,
  user_id      text        NOT NULL,
  content_hash text        NOT NULL,
  parsed       jsonb       NOT NULL,
  updated_at   timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cv_parsed_cache_user_id_idx ON cv_parsed_cache(user_id);
ALTER TABLE cv_parsed_cache ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users access own parse cache"
  ON cv_parsed_cache FOR ALL
  USING (user_id = (auth.jwt() ->> 'sub'));
