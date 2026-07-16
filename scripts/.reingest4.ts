// Re-ingest the four boards that flagged PARTIAL on the first full run, under
// the raised cap (1500) + UK-aware truncation. Records the run so verify-ats
// judges the corpus by what is actually true now.
import { config } from "dotenv";
config({ path: ".env.local" });

import { createServerSupabaseClient } from "../lib/supabase-server";
import {
  ingestBoards,
  assertProviderHealth,
  assertNoSilentTruncation,
  recordIngestRun,
} from "../lib/ats/ingest";

async function main() {
  const supabase = createServerSupabaseClient();
  const { data, error } = await supabase
    .from("company_ats")
    .select("*")
    .in("board_token", [
      "https://www.pepsicojobs.com/main/",
      "https://www.careuk.com/careers",
      "https://careers.aramark.com/",
      "https://www.boots.jobs/",
      "https://careers.fedex.com/",
    ]);
  if (error) throw new Error(error.message);
  const boards = (data ?? []).map((r) => ({
    id: r.id as string,
    provider: r.provider,
    token: r.board_token as string,
    companyName: r.company_name as string,
    normalisedName: r.normalised_name as string,
    status: r.status,
    lastJobCount: r.last_job_count,
    consecutiveFailures: r.consecutive_failures ?? 0,
    renderMode: r.render_mode ?? undefined,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  })) as any;
  console.log(`${boards.length} boards to re-ingest`);
  const stats = await ingestBoards(boards, { budgetMs: 45 * 60_000, concurrency: 3 });
  const problems = [...assertProviderHealth(stats), ...assertNoSilentTruncation(stats)];
  await recordIngestRun(stats, "manual", problems);
  console.log(JSON.stringify({
    seen: stats.jobs_seen, upserted: stats.jobs_upserted, foreign: stats.jobs_dropped_foreign,
    truncated: stats.truncated_boards, errors: stats.provider_errors, problems,
  }, null, 2));
  process.exitCode = problems.length ? 1 : 0;
}
main().catch((e) => { console.error(e); process.exit(1); });
