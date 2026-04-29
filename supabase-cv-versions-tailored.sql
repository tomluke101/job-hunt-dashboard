-- Extend cv_versions to store the structured TailoredCV (so we can re-render
-- it later) plus the application context that produced it.

ALTER TABLE cv_versions ADD COLUMN IF NOT EXISTS tailored_data jsonb;
ALTER TABLE cv_versions ADD COLUMN IF NOT EXISTS company text;
ALTER TABLE cv_versions ADD COLUMN IF NOT EXISTS role text;
ALTER TABLE cv_versions ADD COLUMN IF NOT EXISTS jd_text text;

CREATE INDEX IF NOT EXISTS cv_versions_user_id_idx ON cv_versions(user_id);
CREATE INDEX IF NOT EXISTS cv_versions_application_id_idx ON cv_versions(application_id);
