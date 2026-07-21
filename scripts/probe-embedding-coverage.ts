// Embedding coverage by source — the diagnostic verify-embeddings never broke out.
//
//   npx tsx scripts/probe-embedding-coverage.ts
//
// verify-embeddings.ts reports ONE aggregate ATS coverage %. That hides the failure
// mode we actually hit: a freshly-added portal (nhs_jobs, teaching_vacancies) whose
// rows were ingested but never embedded, because embedding is a SEPARATE backfill
// pass that lags ingest. This breaks it down PER SOURCE so an under-embedded portal
// is visible, not averaged away. Read-only; spends nothing.

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

function loadEnvFiles(paths: string[]) {
  for (const p of paths) {
    if (!p || !existsSync(p)) continue;
    const raw = readFileSync(p, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const eq = t.indexOf("=");
      if (eq === -1) continue;
      const k = t.slice(0, eq).trim();
      let v = t.slice(eq + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (!process.env[k]) process.env[k] = v;
    }
  }
}
loadEnvFiles([
  resolve(process.cwd(), ".env.local"),
  "C:/Users/tomlu/OneDrive/Desktop/Money/Job hunt SaaS/job-hunt-dashboard/.env.local",
]);

import { createServerSupabaseClient } from "../lib/supabase-server";
import { ATS_SOURCES } from "../lib/job-search/types";

// Every source we care about — ATS first (embedded), aggregators after (never embedded).
const ALL_SOURCES = [
  ...ATS_SOURCES,
  "reed",
  "adzuna",
] as const;

async function countWhere(source: string, embedded: boolean | null): Promise<number> {
  const supabase = createServerSupabaseClient();
  let q = supabase
    .from("job_postings")
    .select("*", { count: "exact", head: true })
    .eq("source", source);
  if (embedded === true) q = q.not("jd_embedding", "is", null);
  if (embedded === false) q = q.is("jd_embedding", null);
  const { count, error } = await q;
  if (error) throw new Error(`count ${source} (embedded=${embedded}): ${error.message}`);
  return count ?? 0;
}

async function main() {
  console.log("\nEmbedding coverage by source (job_postings)\n");
  console.log("  source".padEnd(24) + "total".padStart(8) + "embedded".padStart(10) + "missing".padStart(9) + "  cov%   ATS");
  console.log("  " + "-".repeat(66));

  let atsTotal = 0;
  let atsEmbedded = 0;

  for (const source of ALL_SOURCES) {
    const total = await countWhere(source, null);
    if (total === 0) continue;
    const embedded = await countWhere(source, true);
    const missing = total - embedded;
    const cov = total ? Math.round((embedded / total) * 100) : 0;
    const isAts = (ATS_SOURCES as readonly string[]).includes(source);
    if (isAts) {
      atsTotal += total;
      atsEmbedded += embedded;
    }
    const flag = missing > 0 && isAts ? "  ⚠️" : "";
    console.log(
      "  " +
        source.padEnd(22) +
        String(total).padStart(8) +
        String(embedded).padStart(10) +
        String(missing).padStart(9) +
        `${String(cov).padStart(6)}%` +
        `   ${isAts ? "yes" : "no "}` +
        flag
    );
  }

  const atsCov = atsTotal ? Math.round((atsEmbedded / atsTotal) * 100) : 0;
  console.log("  " + "-".repeat(66));
  console.log(
    `  ATS TOTAL (embeddable)`.padEnd(24) +
      String(atsTotal).padStart(8) +
      String(atsEmbedded).padStart(10) +
      String(atsTotal - atsEmbedded).padStart(9) +
      `${String(atsCov).padStart(6)}%`
  );
  console.log(
    `\n  → ${atsTotal - atsEmbedded} embeddable ATS rows have NO semantic vector (${100 - atsCov}% of the moat is ranking on heuristics alone).`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
