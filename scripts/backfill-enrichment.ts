/**
 * One-pass re-enrichment of every company_enrichment row.
 *
 * Run after a change to the size heuristic or the employee-count sources, so
 * cached rows re-derive with the new logic instead of waiting out the 90-day
 * TTL. The /debug/enrichment "re-enrich all" button does the same job, but it
 * is capped to a 50s serverless budget per click (~7 companies now that the
 * Haiku fallback adds a call), which means ~16 clicks for a full pass. This
 * runs the whole set in one go with no time budget.
 *
 *   npx tsx scripts/backfill-enrichment.ts          # dry-run: report only
 *   npx tsx scripts/backfill-enrichment.ts --commit # actually re-enrich
 *
 * Companies House allows 600 req/5min. Each company costs roughly 4-8 CH calls,
 * so we pace serially with a delay to stay well inside the window.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// ---- env: load .env.local before importing anything that reads process.env ----
function loadEnvLocal() {
  const path = resolve(process.cwd(), ".env.local");
  const raw = readFileSync(path, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = val;
  }
}
loadEnvLocal();

const REQUIRED = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "COMPANIES_HOUSE_API_KEY",
  "ANTHROPIC_API_KEY",
];
const missing = REQUIRED.filter((k) => !process.env[k]);
if (missing.length) {
  console.error("Missing env vars in .env.local:", missing.join(", "));
  process.exit(1);
}

const COMMIT = process.argv.includes("--commit");
const PACE_MS = 400; // gap between companies, on top of their own network time

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Row = {
  id: string;
  normalised_name: string;
  raw_names: string[] | null;
  size_bucket: string | null;
  size_source: string | null;
  ch_employee_count: number | null;
  enrichment_status: string | null;
};

const SELECT_COLS =
  "id, normalised_name, raw_names, size_bucket, size_source, ch_employee_count, enrichment_status";

async function main() {
  // Dynamic import so the env is populated before these modules initialise.
  const { createServerSupabaseClient } = await import("@/lib/supabase-server");
  const { enrichCompany } = await import("@/lib/enrichment/service");

  const supabase = createServerSupabaseClient();

  const { data, error } = await supabase
    .from("company_enrichment")
    .select(SELECT_COLS);
  if (error) throw new Error(`read rows: ${error.message}`);
  const rows = (data ?? []) as Row[];

  const before = summarise(rows);
  console.log(`\n=== BEFORE (${rows.length} companies) ===`);
  console.table(before.buckets);
  console.log(
    `SIZED (usable by the filter): ${before.sized}/${rows.length} (${pct(before.sized, rows.length)})`
  );
  console.log(
    `filed employee count:         ${before.withCount}/${rows.length} (${pct(before.withCount, rows.length)})`
  );

  if (!COMMIT) {
    console.log("\nDry run. Re-run with --commit to re-enrich.\n");
    return;
  }

  // enrichCompany short-circuits on a fresh cached row, so mark everything
  // stale first — same trick reEnrichAll() uses.
  const { error: staleErr } = await supabase
    .from("company_enrichment")
    .update({ last_refreshed_at: null })
    .not("id", "is", null);
  if (staleErr) throw new Error(`mark stale: ${staleErr.message}`);
  console.log("\nMarked all rows stale. Re-enriching...\n");

  let ok = 0;
  let failed = 0;
  const startedAt = Date.now();

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rawName = row.raw_names?.[0] ?? row.normalised_name;
    const label = `[${String(i + 1).padStart(3)}/${rows.length}] ${rawName}`;
    try {
      const res = await enrichCompany(rawName);
      if (res) {
        ok++;
        const src = res.size_source ?? "-";
        const cnt = res.ch_employee_count ?? "-";
        console.log(`${label} -> ${res.size_bucket} (src=${src}, emp=${cnt})`);
      } else {
        failed++;
        console.log(`${label} -> null (unusable name)`);
      }
    } catch (e) {
      failed++;
      console.log(`${label} -> ERROR ${e instanceof Error ? e.message : String(e)}`);
    }
    await sleep(PACE_MS);
  }

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(0);
  console.log(`\nDone in ${elapsed}s. ok=${ok} failed=${failed}\n`);

  const { data: after } = await supabase
    .from("company_enrichment")
    .select(SELECT_COLS);
  const afterRows = (after ?? []) as Row[];
  const a = summarise(afterRows);
  console.log(`=== AFTER (${afterRows.length} companies) ===`);
  console.table(a.buckets);
  console.log("size decided by:");
  console.table(a.sources);
  console.log(
    `SIZED (usable by the filter): ${a.sized}/${afterRows.length} (${pct(a.sized, afterRows.length)})` +
      `   [was ${before.sized} = ${pct(before.sized, rows.length)}]`
  );
  console.log(
    `filed employee count:         ${a.withCount}/${afterRows.length} (${pct(a.withCount, afterRows.length)})`
  );
}

function summarise(rows: Row[]) {
  const buckets: Record<string, number> = {};
  const sources: Record<string, number> = {};
  let withCount = 0;
  let sized = 0;
  for (const r of rows) {
    const b = r.size_bucket ?? "null";
    buckets[b] = (buckets[b] ?? 0) + 1;
    const s = r.size_source ?? "(none)";
    sources[s] = (sources[s] ?? 0) + 1;
    if (r.ch_employee_count !== null) withCount++;
    if (b !== "unknown" && b !== "null") sized++;
  }
  return { buckets, sources, withCount, sized };
}

function pct(n: number, d: number) {
  return d === 0 ? "0%" : `${Math.round((n / d) * 100)}%`;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
