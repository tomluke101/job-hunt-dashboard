-- Store the structured HTML rendering of the original .docx so the Profile
-- preview shows the user's real CV layout, not just the stripped plain text.
-- AI tailoring still uses the plain text `content` column.

ALTER TABLE user_cvs ADD COLUMN IF NOT EXISTS content_html text;
