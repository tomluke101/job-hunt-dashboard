// Seed the ONE Teaching Vacancies portal board into the registry.
//
// TV is not discovered by probing company slugs (candidateTokens() returns []) —
// it is a fixed national portal, registered once here. After this runs, the normal
// ingest path (scripts/ingest-ats.ts and the nightly cron) polls it like any other
// board and fills job_postings with source="teaching_vacancies".
//
//   npx tsx scripts/seed-teaching-vacancies.ts
//
// Idempotent: re-running upserts the same (provider, board_token) row.

import { config } from "dotenv";
config({ path: ".env.local" });

import { upsertBoard } from "../lib/ats/registry";
import { teachingVacanciesProvider, TEACHING_VACANCIES_API } from "../lib/ats/providers/teaching-vacancies";
import type { DiscoveredBoard } from "../lib/ats/discover";

async function main() {
  console.log("Probing Teaching Vacancies API (live)...");
  const probe = await teachingVacanciesProvider.probe({
    provider: "teaching_vacancies",
    token: TEACHING_VACANCIES_API,
  });

  if (!probe.exists) {
    console.error(`❌ Portal did not respond: ${probe.error ?? "unknown"}. Not seeding a dead source.`);
    process.exit(1);
  }
  console.log(`✅ Portal live — page 1 returned ${probe.jobCount} vacancies.`);

  const board: DiscoveredBoard = {
    provider: "teaching_vacancies",
    token: TEACHING_VACANCIES_API,
    companyName: "Teaching Vacancies (DfE)",
    discovered_via: "seed",
    board_company_name: null,
    job_count: probe.jobCount,
    verified: true,
  };

  const id = await upsertBoard(board);
  console.log(`✅ Registered board ${id} (status=active).`);
  console.log("\nNext: populate the corpus —");
  console.log("   npx tsx scripts/ingest-ats.ts --limit 1   # will pick the oldest-polled board");
  console.log("   (or run a full ingest; TV is one board among the registry).");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
