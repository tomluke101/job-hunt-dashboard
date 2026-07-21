// Seed the ONE NHS Jobs portal board into the registry.
//
// NHS Jobs is not discovered by probing company slugs (candidateTokens() returns
// []) — it is a fixed national portal, registered once here. After this runs, the
// normal ingest path (scripts/ingest-ats.ts and the nightly cron) polls it like
// any other board and fills job_postings with source="nhs_jobs".
//
//   npx tsx scripts/seed-nhs-jobs.ts
//
// Idempotent: re-running upserts the same (provider, board_token) row.

import { config } from "dotenv";
config({ path: ".env.local" });

import { upsertBoard } from "../lib/ats/registry";
import { nhsJobsProvider, NHS_JOBS_SEARCH } from "../lib/ats/providers/nhs-jobs";
import type { DiscoveredBoard } from "../lib/ats/discover";

async function main() {
  console.log("Probing NHS Jobs candidate site (live)...");
  const probe = await nhsJobsProvider.probe({ provider: "nhs_jobs", token: NHS_JOBS_SEARCH });

  if (!probe.exists) {
    console.error(`❌ Portal did not respond: ${probe.error ?? "unknown"}. Not seeding a dead source.`);
    process.exit(1);
  }
  console.log(`✅ Portal live — "${probe.jobCount} jobs found" on the board.`);

  const board: DiscoveredBoard = {
    provider: "nhs_jobs",
    token: NHS_JOBS_SEARCH,
    companyName: "NHS Jobs (NHSBSA)",
    discovered_via: "seed",
    board_company_name: null,
    job_count: probe.jobCount,
    verified: true,
  };

  const id = await upsertBoard(board);
  console.log(`✅ Registered board ${id} (status=active).`);
  console.log("\nNext: populate the corpus —");
  console.log("   npx tsx scripts/ingest-ats.ts --provider nhs_jobs --budget 120");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
