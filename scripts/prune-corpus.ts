// Remove ATS postings the employer's board no longer vouches for.
//
//   npx tsx scripts/prune-corpus.ts            # report
//   npx tsx scripts/prune-corpus.ts --commit   # delete
//
// WHY THIS IS NEEDED AT ALL
// -------------------------
// Ingest only ever UPSERTS. A job it stops accepting — because the employer pulled
// the ad, or because we FIXED A BUG and now correctly reject it — is never deleted;
// it just stops being refreshed. So the corpus quietly accumulates rows nothing
// stands behind any more.
//
// That went from theoretical to real: Barclays' Wilmington, DELAWARE jobs were
// filed as country_code=GB (an explicit "United States of America" from the provider
// lost a fight with the UK gazetteer, which knows a Wilmington in Kent). The geo fix
// stops NEW ones arriving. It cannot remove the ones already sitting there, because
// job_postings stores the country RESULT and not the provider's country hint, so
// there is nothing left to re-derive the verdict from.
//
// The honest signal is `last_seen_at`: the ingest worker refreshes it on every job
// still on the board. A job the latest SUCCESSFUL poll of its board did not touch is
// a job that board is no longer serving us.
//
// SAFETY
//  • Only boards that polled successfully in the last run are considered. If a board
//    errored, its jobs are stale for a reason that is OUR fault, not the employer's,
//    and deleting them would silently destroy real supply.
//  • Postings a user has already shortlisted are NEVER deleted — the FK aside, a job
//    vanishing from someone's shortlist because a board hiccuped is unacceptable.

import { config } from "dotenv";
config({ path: ".env.local" });

import { createServerSupabaseClient } from "../lib/supabase-server";
import { ATS_SOURCES } from "../lib/job-search/types";

const COMMIT = process.argv.includes("--commit");

/**
 * A job refreshed within this window of its board's last poll is current.
 *
 * ⚠️ THIS MUST BE SHORTER THAN THE GAP BETWEEN INGEST RUNS, or it catches nothing.
 * At 90 minutes it silently found zero Barclays rows: `last_polled_at` is stamped at
 * the END of a board's poll, so a row refreshed by the PREVIOUS run still sat inside
 * the window and read as current. A stale-detector whose window is wider than the
 * refresh interval declares everything fresh — the same shape of useless-but-green
 * as a verifier that passes on an empty set.
 *
 * A single board takes minutes, not hours. Ten is ample.
 */
const GRACE_MINUTES = 10;

async function main() {
  const supabase = createServerSupabaseClient();

  const { data: boards, error: bErr } = await supabase
    .from("company_ats")
    .select("id, company_name, provider, board_token, last_polled_at, last_error, last_job_count");
  if (bErr) throw new Error(`company_ats: ${bErr.message}`);

  const healthy = (boards ?? []).filter((b) => b.last_polled_at && !b.last_error);
  console.log(`${healthy.length} of ${(boards ?? []).length} boards polled cleanly in the last run.\n`);
  if (healthy.length === 0) {
    console.error("❌ No healthy boards. Refusing to prune — this would delete the whole corpus.");
    process.exit(1);
  }

  // Shortlisted postings are untouchable.
  const shortlisted = new Set<string>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from("job_shortlist").select("posting_id").range(from, from + 999);
    if (error) throw new Error(`job_shortlist: ${error.message}`);
    const batch = data ?? [];
    for (const r of batch) shortlisted.add(r.posting_id as string);
    if (batch.length < 1000) break;
  }
  console.log(`${shortlisted.size} postings are shortlisted and will never be pruned.\n`);

  let totalStale = 0;
  const plan: Array<{ id: string; company: string; title: string; place: string | null }> = [];

  for (const b of healthy) {
    const cutoff = new Date(new Date(b.last_polled_at as string).getTime() - GRACE_MINUTES * 60_000).toISOString();
    const { data, error } = await supabase
      .from("job_postings")
      .select("id, company, title, place_name, country_code, last_seen_at")
      .eq("ats_board_id", b.id as string)
      .in("source", ATS_SOURCES as unknown as string[])
      .lt("last_seen_at", cutoff);
    if (error) throw new Error(`job_postings for ${b.board_token}: ${error.message}`);

    for (const r of data ?? []) {
      if (shortlisted.has(r.id as string)) continue;
      totalStale++;
      plan.push({
        id: r.id as string,
        company: r.company as string,
        title: r.title as string,
        place: (r.place_name as string) ?? null,
      });
    }
  }

  if (plan.length === 0) {
    console.log("✅ Nothing stale — every ATS posting was refreshed by the last poll of its board.");
    return;
  }

  console.log(`🔴 ${totalStale} ATS posting(s) their board no longer serves:\n`);
  const byCompany: Record<string, number> = {};
  for (const p of plan) byCompany[p.company] = (byCompany[p.company] ?? 0) + 1;
  for (const [c, n] of Object.entries(byCompany).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(4)}  ${c}`);
  }
  console.log("\n  sample:");
  for (const p of plan.slice(0, 8)) console.log(`    ${p.company} — ${p.title.slice(0, 50)}  (${p.place ?? "no place"})`);

  if (!COMMIT) {
    console.log("\nDRY RUN — nothing deleted. Re-run with --commit.");
    return;
  }

  let deleted = 0;
  for (let i = 0; i < plan.length; i += 100) {
    const ids = plan.slice(i, i + 100).map((p) => p.id);
    const { error } = await supabase.from("job_postings").delete().in("id", ids);
    if (error) throw new Error(`delete: ${error.message}`);
    deleted += ids.length;
  }
  console.log(`\n✅ Pruned ${deleted} stale ATS posting(s).`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
