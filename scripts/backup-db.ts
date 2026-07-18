// Full logical backup of the HuntHQ Supabase database → OneDrive.
//
// Supabase's free tier has NO automatic backups, so without this the ONE thing
// that isn't reproducible from the git repo — your saved searches, shortlists and
// decisions, plus the enriched corpus — lives in a single place. This closes that.
//
//   npx tsx scripts/backup-db.ts            # writes a timestamped snapshot
//   npx tsx scripts/backup-db.ts --out DIR  # override the destination
//
// HOW IT RESTORES: the SCHEMA is in git (supabase-*.sql) — re-run those in a fresh
// Supabase project, then load these JSON files table-by-table. See the restore
// steps in RECOVERY_RUNBOOK below / docs.
//
// What it deliberately OMITS (both cheaply reproducible, and huge):
//   • job_postings.jd_embedding       — rebuild with backfill-embeddings.ts (~£1)
//   • job_searches.description_embedding — re-embedded on next save/run
// Everything NOT reproducible (your own data + the crawled corpus text) is kept.

import { config } from "dotenv";
config({ path: ".env.local" });

import { createServerSupabaseClient } from "../lib/supabase-server";
import { mkdirSync, writeFileSync, readdirSync, rmSync, existsSync } from "fs";
import { gzipSync } from "zlib";
import { join } from "path";
import { homedir } from "os";

// Every table declared across supabase-*.sql. A table that doesn't exist yet is
// skipped with a note rather than failing the whole backup.
const TABLES = [
  "job_postings", "job_searches", "job_shortlist", "job_search_runs",
  "job_search_sources", "company_enrichment", "company_ats",
  "company_ats_discovery", "ats_ingest_runs", "geo_cache", "curated_companies",
  "applications", "cover_letters", "cv_parsed_cache", "cv_versions",
  "user_api_keys", "user_cvs", "user_employers", "user_profile",
  "user_ranking_weights", "user_skill_employers", "user_skills",
  "user_task_preferences", "user_writing_examples",
];

// Reproducible + enormous → excluded from the snapshot (see header).
const EXCLUDE_COLUMNS: Record<string, string[]> = {
  job_postings: ["jd_embedding"],
  job_searches: ["description_embedding"],
};

const KEEP_SNAPSHOTS = 14; // ~2 weeks of daily backups

function outRoot(): string {
  const i = process.argv.indexOf("--out");
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return join(homedir(), "OneDrive", "Desktop", "Money", "Claude Brain", "hunthq-db-backup");
}

// PostgREST can't say "all columns except X". Probe one row to learn the columns,
// then select all-but-excluded so the embedding never crosses the wire.
async function columnSelect(
  supabase: ReturnType<typeof createServerSupabaseClient>,
  table: string
): Promise<string> {
  const exclude = EXCLUDE_COLUMNS[table];
  if (!exclude?.length) return "*";
  const { data } = await supabase.from(table).select("*").limit(1);
  if (!data || data.length === 0) return "*";
  return Object.keys(data[0]).filter((c) => !exclude.includes(c)).join(",");
}

async function dumpTable(
  supabase: ReturnType<typeof createServerSupabaseClient>,
  table: string
): Promise<{ rows: unknown[] | null; error?: string }> {
  const select = await columnSelect(supabase, table);
  const rows: unknown[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from(table).select(select).range(from, from + 999);
    if (error) {
      // Missing table → skip; anything else → report.
      if (/does not exist|relation|Could not find the table/i.test(error.message)) {
        return { rows: null, error: "table not present (skipped)" };
      }
      return { rows: null, error: error.message };
    }
    if (!data || data.length === 0) break;
    rows.push(...data);
    if (data.length < 1000) break;
  }
  return { rows };
}

async function main() {
  const supabase = createServerSupabaseClient();
  const root = outRoot();
  // ISO timestamp, filesystem-safe. (Plain node script — Date is fine here.)
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const dir = join(root, stamp);
  mkdirSync(dir, { recursive: true });

  console.log(`\nHuntHQ DB backup → ${dir}\n`);

  const rowCounts: Record<string, number> = {};
  const skipped: Record<string, string> = {};
  let totalRows = 0;

  for (const table of TABLES) {
    const { rows, error } = await dumpTable(supabase, table);
    if (rows === null) {
      skipped[table] = error ?? "unknown";
      console.log(`  - ${table.padEnd(24)} skipped (${error})`);
      continue;
    }
    // Gzip: the corpus text dominates and compresses ~6x, keeping OneDrive usage
    // and sync time small enough that KEEP_SNAPSHOTS daily copies stay cheap.
    writeFileSync(join(dir, `${table}.json.gz`), gzipSync(Buffer.from(JSON.stringify(rows))));
    rowCounts[table] = rows.length;
    totalRows += rows.length;
    console.log(`  ✓ ${table.padEnd(24)} ${rows.length} rows`);
  }

  const manifest = {
    created_at: new Date().toISOString(),
    supabase_url: process.env.NEXT_PUBLIC_SUPABASE_URL,
    total_rows: totalRows,
    row_counts: rowCounts,
    skipped,
    omitted_columns: EXCLUDE_COLUMNS,
    restore_note:
      "Files are gzipped JSON (<table>.json.gz — gunzip to read). Schema DDL lives " +
      "in the repo (supabase-*.sql). To restore: create a fresh Supabase project, run " +
      "those SQL files, then load each table's rows. Rebuild embeddings with " +
      "scripts/backfill-embeddings.ts --commit.",
    contains_secrets:
      "user_api_keys.json may contain BYOK API keys — this snapshot lives in your " +
      "private OneDrive only.",
  };
  writeFileSync(join(dir, "_manifest.json"), JSON.stringify(manifest, null, 2));

  // Rotate: keep the newest KEEP_SNAPSHOTS snapshot folders.
  if (existsSync(root)) {
    const snaps = readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
    const stale = snaps.slice(0, Math.max(0, snaps.length - KEEP_SNAPSHOTS));
    for (const s of stale) {
      rmSync(join(root, s), { recursive: true, force: true });
      console.log(`  · rotated out old snapshot ${s}`);
    }
  }

  console.log(`\n✅ Backup complete: ${totalRows} rows across ${Object.keys(rowCounts).length} tables.`);
  console.log(`   ${dir}`);
}

main().catch((e) => {
  console.error("\n❌ Backup FAILED:", e);
  process.exit(1);
});
