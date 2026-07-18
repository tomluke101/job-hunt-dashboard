# HuntHQ — Recovery Runbook

**Purpose:** stand the entire job-hunt system back up from nothing — lost laptop,
lost Claude account, or a lost Supabase database — without losing a single thing.

Last verified: 2026-07-18. Keep this in sync when infrastructure changes.

---

## 0. Where everything lives (the map)

| Layer | Lives in | Independent of the laptop? | Reproducible? |
|---|---|---|---|
| **Code + schema + history** | GitHub `tomluke101/job-hunt-dashboard` (source of truth) + OneDrive `…/Job hunt SaaS/job-hunt-dashboard` | ✅ two clouds | — |
| **Deployment** | Vercel project `job-hunt-dashboard` → `job-hunt-dashboard-two.vercel.app` | ✅ | ✅ redeploy from GitHub |
| **Database** | Supabase project `woqomkuhczaprrwaedep` | ✅ (Supabase cloud) | ⚠️ only from the **DB backup** below |
| **DB backups** | OneDrive `…/Claude Brain/hunthq-db-backup/<timestamp>/` (daily, gzipped) | ✅ | — |
| **The plan / how it works** | Claude memory `~/.claude/projects/…/memory/` → mirrored hourly to OneDrive `…/Claude Brain/projects-backup/` | ✅ | — |
| **Secrets** | `.env.local` (repo, gitignored, OneDrive-synced) + `reference_api_keys_hunthq.md` (in Claude memory backup) + Vercel env vars | ✅ | — |

**Key point:** the Claude memory is on disk + OneDrive, **not** in your Claude
account — losing the Claude account loses nothing; a new Claude on the same
OneDrive reads it and continues.

---

## 1. Services & where their keys are

All secret *values* live in `.env.local` (repo root, gitignored) and, mirrored, in
the Claude memory file `reference_api_keys_hunthq.md`. Never commit values.

| Service | What it's for | Env var(s) |
|---|---|---|
| Supabase | database | `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` |
| OpenAI | embeddings (AI ranking) | `OPENAI_API_KEY` |
| Anthropic | AI parse / (future) explain | `ANTHROPIC_API_KEY` |
| Clerk | auth | `CLERK_SECRET_KEY`, `NEXT_PUBLIC_CLERK_*` |
| Reed / Adzuna | aggregator supply | `REED_API_KEY`, `ADZUNA_APP_ID`, `ADZUNA_APP_KEY` |
| Companies House | company enrichment | `COMPANIES_HOUSE_API_KEY` |
| Vercel cron | protects `/api/ats/ingest` | `CRON_SECRET` |

Deploy token (Vercel CLI) and the GitHub push method are in the Claude memory
(`hunthq_job_search_resume_2026_07_01.md` / `reference_api_keys_hunthq.md`).

---

## 2. Scenario: lost laptop (accounts intact) — the common case

The database is untouched (it's in Supabase's cloud). You only need the code + keys.

```bash
git clone https://github.com/tomluke101/job-hunt-dashboard.git
cd job-hunt-dashboard
npm install
# recreate .env.local from reference_api_keys_hunthq.md (or Vercel env pull)
npm run dev            # or just rely on the live Vercel deploy — nothing to redeploy
```
Everything (searches, shortlists, corpus) is already live. Done.

---

## 3. Scenario: lost Claude account / new machine, need context

1. Make sure OneDrive is synced (the `Money` folder).
2. Point a fresh Claude session at the machine. It reads
   `~/.claude/…/memory/` — if that's empty, restore it from
   `…/Claude Brain/projects-backup/…/memory/`.
3. Start from `MEMORY.md` → `hunthq_job_search_resume_2026_07_01.md`.

No project data is lost — this layer is only *context*, and it's backed up hourly.

---

## 4. Scenario: lost Supabase database (the one that needs a backup)

The corpus text + your searches/shortlists/decisions live only in Supabase. Restore:

1. **Create a new Supabase project.** Note its URL + service-role key.
2. **Recreate the schema** — run every `supabase-*.sql` from the repo root in the
   Supabase SQL editor (order doesn't matter; they're idempotent). Include
   `supabase-embeddings-schema.sql`.
3. **Load the data** from the latest backup folder
   `…/Claude Brain/hunthq-db-backup/<newest>/`. Each `<table>.json.gz` is gzipped
   JSON of that table's rows. Load them (service-role key bypasses RLS), e.g. a
   small script that, per table: `gunzip` → `JSON.parse` → `supabase.from(table)
   .insert(rows)` in chunks. Load parents before children (job_postings and
   job_searches before job_shortlist).
4. **Rebuild embeddings** (excluded from the backup, cheap to regenerate):
   `npx tsx scripts/backfill-embeddings.ts --commit`  (~£1, ~10 min).
5. **Point the app at the new project** — update `NEXT_PUBLIC_SUPABASE_URL` +
   `SUPABASE_SERVICE_ROLE_KEY` in `.env.local` **and** Vercel env, then redeploy
   (`npx vercel deploy --prod`).
6. **Verify:** `npx tsx scripts/verify-ats.ts && … && npx tsx scripts/verify-embeddings.ts`.

If instead you only lost the *corpus* (not your own data), you can skip the backup
and rebuild it from scratch: `discover-ats.ts --seed` → `ingest-ats.ts` →
`backfill-classify.ts --commit` → `backfill-embeddings.ts --commit`.

---

## 5. The daily DB backup (how it runs)

- **Script:** `scripts/backup-db.ts` — logical export of all 24 tables to gzipped
  JSON, embeddings excluded, keeps the newest 14 snapshots.
- **Wrapper:** `…/Claude Brain/backup_hunthq_db.ps1` (adds Node to PATH, logs).
- **Schedule:** Windows Task Scheduler task **`ClaudeBrain-HuntHQDbBackup`**, daily
  03:00, `StartWhenAvailable` (runs when the laptop next wakes if it was off).
- **Log:** `…/Claude Brain/backup_hunthq_db.log`.
- **Run manually any time:** `npx tsx scripts/backup-db.ts`.
- **Check it's healthy:** newest folder in `…/Claude Brain/hunthq-db-backup/` should
  be dated today, and `_manifest.json` shows ~18k+ rows across 24 tables.

⚠️ `user_api_keys.json` inside a snapshot may contain BYOK secrets — snapshots stay
in your private OneDrive only.

---

## 6. Full rebuild from absolute zero (checklist)

1. Clone the repo (§2).
2. New Supabase project + run all `supabase-*.sql` (§4.2).
3. Recreate `.env.local` from `reference_api_keys_hunthq.md` (§1), pointed at the
   new Supabase.
4. Restore DB data from the latest snapshot (§4.3) **or** rebuild the corpus (§4).
5. Rebuild embeddings (§4.4).
6. New Vercel project → import the GitHub repo → set all env vars → deploy.
7. Re-add the Vercel cron (`/api/ats/ingest`, daily) + `CRON_SECRET`.
8. Re-register the backup task (§7).
9. Run all six verifiers; eyeball a real search on prod.

---

## 7. Recreate the backup task (copy-paste)

The live wrapper is `…/Claude Brain/backup_hunthq_db.ps1`; a versioned copy is in
the repo at `ops/backup_hunthq_db.ps1`. To recreate the wrapper, copy that file to
Claude Brain (adjust the `$repo` path if the checkout moved). Then register the
task in PowerShell:

```powershell
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"C:\Users\tomlu\OneDrive\Desktop\Money\Claude Brain\backup_hunthq_db.ps1`""
$trigger = New-ScheduledTaskTrigger -Daily -At 3:00AM
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 30)
Register-ScheduledTask -TaskName "ClaudeBrain-HuntHQDbBackup" -Action $action -Trigger $trigger -Settings $settings -Force
```

⚠️ **`-WindowStyle Hidden` is required** — without it the scheduled PowerShell hands
its Node child a spurious CTRL+C and the task dies instantly with `0xC000013A`.
Verify with: `Start-ScheduledTask -TaskName ClaudeBrain-HuntHQDbBackup`, then check
`(Get-ScheduledTaskInfo -TaskName ClaudeBrain-HuntHQDbBackup).LastTaskResult` is `0`
and a fresh folder appeared under `…/Claude Brain/hunthq-db-backup/`.
