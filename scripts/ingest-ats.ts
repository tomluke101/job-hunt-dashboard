// Pull every registered ATS board into the job_postings corpus.
//
//   npx tsx scripts/ingest-ats.ts                 # everything, 10 min budget
//   npx tsx scripts/ingest-ats.ts --limit 20      # first 20 boards (oldest-polled first)
//   npx tsx scripts/ingest-ats.ts --dry-run       # pull + geocode, write nothing
//   npx tsx scripts/ingest-ats.ts --budget 120    # seconds
//
// EXITS NON-ZERO if a verified provider returned zero jobs across 3+ boards.
// A source returning 0 looks exactly like "no jobs matched" — that's how Adzuna
// managed to return nothing for ten days without anyone noticing. This script is
// the thing that refuses to let it happen again.

import { config } from "dotenv";
config({ path: ".env.local" });

import { listPollableBoards } from "../lib/ats/registry";
import {
  ingestBoards,
  assertProviderHealth,
  assertNoSilentTruncation,
  recordIngestRun,
} from "../lib/ats/ingest";

const argv = process.argv.slice(2);
const has = (f: string) => argv.includes(f);
const val = (f: string) => {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] : undefined;
};

async function main() {
  const dryRun = has("--dry-run");
  const limit = parseInt(val("--limit") ?? "0", 10) || 5000;
  const budgetMs = (parseInt(val("--budget") ?? "0", 10) || 600) * 1000;

  const boards = await listPollableBoards(limit);
  if (!boards.length) {
    console.error(
      "No pollable boards in the registry.\n" +
        "Run:  npx tsx scripts/discover-ats.ts --seed --probe-only\n" +
        "(If you just applied the schema, that's expected — the registry starts empty.)"
    );
    process.exit(1);
  }

  console.log(`Ingesting ${boards.length} boards (dryRun=${dryRun}, budget=${budgetMs / 1000}s)\n`);

  const stats = await ingestBoards(boards, {
    budgetMs,
    // Match the cron (app/api/ats/ingest/route.ts). If the script polls at a
    // different concurrency than production does, its timing tells us nothing about
    // whether the nightly run can actually finish.
    //
    // ⚠️ 4 IS A SUPPLY DECISION, NOT A POLITENESS ONE — DO NOT RAISE IT TO GO FASTER.
    // Measured on the 94-board registry (2026-07-14):
    //     concurrency 4 -> 296s, workday 3854 jobs, no truncation
    //     concurrency 6 -> 152s, workday 2653 jobs, Barclays TRUNCATED
    //     concurrency 8 -> 151s, workday 2353 jobs, Barclays + AstraZeneca TRUNCATED
    // Polling more boards at once gets us THROTTLED by Workday, and the throttling
    // shows up as a HALVED JOB COUNT, not as an error. Raising it looks like a free
    // 2x speed-up and is really a 40% cut to our largest first-party employers.
    concurrency: 4,
    dryRun,
    onProgress: (m) => process.stdout.write(`\r${m.padEnd(90)}`),
  });
  process.stdout.write("\n\n");

  console.log("=".repeat(66));
  console.log(`boards polled     ${stats.boards_polled}  (failed ${stats.boards_failed})`);
  console.log(`jobs seen         ${stats.jobs_seen}`);
  console.log(`jobs upserted     ${stats.jobs_upserted}`);
  console.log(`dropped: foreign  ${stats.jobs_dropped_foreign}   (not a UK job — correct to drop)`);
  console.log(`dropped: no geo   ${stats.jobs_dropped_unresolved}   (kept, but can't match a radius search)`);
  console.log(`elapsed           ${(stats.elapsed_ms / 1000).toFixed(1)}s${stats.budget_exhausted ? "  ⏳ BUDGET EXHAUSTED — rerun to continue" : ""}`);
  console.log("\nPER PROVIDER (jobs / boards):");
  for (const p of Object.keys(stats.provider_boards).sort()) {
    const jobs = stats.provider_counts[p] ?? 0;
    const boardsN = stats.provider_boards[p];
    console.log(`  ${p.padEnd(16)} ${String(jobs).padStart(6)} jobs / ${boardsN} boards`);
  }

  const errs = Object.entries(stats.provider_errors);
  if (errs.length) {
    console.log("\nERRORS:");
    for (const [p, list] of errs) {
      for (const e of list.slice(0, 5)) console.log(`  ${p}: ${e}`);
      if (list.length > 5) console.log(`  ${p}: ...and ${list.length - 5} more`);
    }
  }

  if (stats.truncated_boards.length) {
    console.log("\n⚠️  PARTIAL BOARDS — we served only part of these employers' boards:");
    for (const b of stats.truncated_boards) console.log(`   ${b}`);
  }

  // Truncation is a supply loss, exactly like a dead provider — assert on it too.
  const problems = [...assertProviderHealth(stats), ...assertNoSilentTruncation(stats)];
  if (!dryRun) await recordIngestRun(stats, "manual", problems);

  if (problems.length) {
    console.error("\n❌ INGEST INTEGRITY:");
    for (const p of problems) console.error(`   ${p}`);
    process.exit(1);
  }

  if (stats.jobs_seen === 0) {
    console.error("\n❌ ZERO jobs across every board. That is a fault, not an empty job market.");
    process.exit(1);
  }

  console.log("\n✅ Ingest healthy.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
