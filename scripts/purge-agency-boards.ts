// Remove ATS boards that got attached to a RECRUITMENT AGENCY's name.
//
//   npx tsx scripts/purge-agency-boards.ts            # report
//   npx tsx scripts/purge-agency-boards.ts --commit   # delete
//
// An agency has no first-party board, so when discovery "finds" one for Reed or
// Cedar it has actually found a DIFFERENT company's board and filed it under the
// agency's name (Reed → Howden Joinery's Workday, 155 real jobs). Ingesting that
// would brand Howdens' jobs as "Reed" — recruiter-labelled first-party supply,
// which is the exact inversion of the moat.
//
// The hole that created them is closed in discover-ats.ts (companiesFromPostings
// now excludes recruiters), but the rows it already wrote have to go.

import { config } from "dotenv";
config({ path: ".env.local" });

import { createServerSupabaseClient } from "../lib/supabase-server";
import { normaliseCompanyName } from "../lib/enrichment/normalise-company";
import { namesMatch } from "../lib/ats/discover";

const COMMIT = process.argv.includes("--commit");

async function main() {
  const supabase = createServerSupabaseClient();

  const { data: recruiterRows, error: rErr } = await supabase
    .from("company_enrichment")
    .select("normalised_name, raw_names")
    .eq("is_likely_recruiter", true);
  if (rErr) throw new Error(`company_enrichment: ${rErr.message}`);
  const recruiters = new Set((recruiterRows ?? []).map((r) => r.normalised_name as string));
  console.log(`${recruiters.size} known recruitment agencies.\n`);

  const { data: boards, error: bErr } = await supabase
    .from("company_ats")
    .select("id, company_name, normalised_name, provider, board_token, workday_site, status, last_job_count, board_company_name, discovered_via");
  if (bErr) throw new Error(`company_ats: ${bErr.message}`);

  /**
   * The recruiter FLAG alone is not enough. Reed, Cedar and Pareto are all UK
   * recruitment agencies and NONE of them is flagged `is_likely_recruiter` in
   * enrichment — so a flag-only purge catches Huntress and leaves the three worst
   * ones in place.
   *
   * The second, independent test is STRUCTURAL and needs no enrichment at all: does
   * the board token bear any relation to the company we filed it under?
   *
   *     "Reed"    → workday/howdenjoinerylimited    no relation  🔴
   *     "Cedar"   → ashby/cedar                     relates      ✓ (but still an agency)
   *     "Monzo"   → greenhouse/monzo                relates      ✓
   *     "Haleon"  → workday/gsknch                  no relation  ⚠️ (a real rebrand)
   *
   * A no-relation board is not automatically WRONG — Haleon really is on GSK's
   * tenant — so this reports them for review rather than deleting blind. Only the
   * ones that are BOTH unrelated AND agency-shaped get proposed for deletion.
   */
  function tokenRelatesToCompany(company: string, token: string, boardName: string | null): boolean {
    const c = normaliseCompanyName(company).replace(/[^a-z0-9]/g, "");
    const t = (token ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
    if (!c || !t) return false;
    if (c.length >= 4 && t.includes(c)) return true;
    if (t.length >= 4 && c.includes(t)) return true;

    // ⚠️ board_company_name IS OFTEN AN ECHO, NOT EVIDENCE.
    //
    // Workday's probe() returns `boardCompanyName: board.companyName ?? null` — the
    // name WE passed in. So namesMatch(company, boardName) compares "Reed" against
    // "Reed", agrees, and pronounces Howden Joinery's board a perfect match for Reed.
    // This is the same self-verification bug already known for Lever and Ashby (which
    // have no company-name field at all); Workday's was undocumented.
    //
    // A value that merely reflects the question cannot answer it. Only consult the
    // board's name when it actually DIFFERS from what we asked.
    const echo =
      boardName != null && normaliseCompanyName(boardName) === normaliseCompanyName(company);
    if (!echo && namesMatch(company, boardName)) return true;

    return false;
  }

  const flagged = (boards ?? []).filter((b) =>
    recruiters.has((b.normalised_name as string) ?? normaliseCompanyName(b.company_name as string))
  );
  const mismatched = (boards ?? []).filter(
    (b) =>
      !flagged.includes(b) &&
      !tokenRelatesToCompany(
        b.company_name as string,
        b.board_token as string,
        (b.board_company_name as string) ?? null
      )
  );

  const bogus = flagged;

  if (mismatched.length) {
    console.log(`⚠️  ${mismatched.length} board(s) whose TOKEN does not relate to the company name.`);
    console.log(`    Some are legitimate rebrands (Haleon really is on GSK's Workday tenant).`);
    console.log(`    Review these by hand — they are NOT auto-deleted:\n`);
    for (const b of mismatched) {
      console.log(
        `    "${b.company_name}"  →  ${b.provider}/${b.board_token}` +
          `${b.workday_site ? "/" + b.workday_site : ""}  (${b.last_job_count ?? 0} jobs, ${b.status}, via ${b.discovered_via})`
      );
    }
    console.log("");
  }

  if (bogus.length === 0) {
    console.log("✅ No agency-flagged boards in the registry.");
    return;
  }

  console.log(`🔴 ${bogus.length} board(s) attached to a KNOWN recruitment agency:\n`);
  for (const b of bogus) {
    console.log(
      `  "${b.company_name}"  →  ${b.provider}/${b.board_token}` +
        `${b.workday_site ? "/" + b.workday_site : ""}  (${b.last_job_count ?? 0} jobs, ${b.status})`
    );
  }

  if (!COMMIT) {
    console.log("\nDRY RUN — nothing deleted. Re-run with --commit.");
    return;
  }

  const ids = bogus.map((b) => b.id as string);
  const { error: dErr } = await supabase.from("company_ats").delete().in("id", ids);
  if (dErr) throw new Error(`delete: ${dErr.message}`);

  // Any jobs already ingested under the agency's name must go too, or the corpus
  // keeps serving Howdens' jobs branded "Reed" long after the board is gone.
  let jobsDeleted = 0;
  for (const b of bogus) {
    const { error, count } = await supabase
      .from("job_postings")
      .delete({ count: "exact" })
      .eq("ats_board_id", b.id as string);
    if (error) throw new Error(`delete postings for ${b.company_name}: ${error.message}`);
    jobsDeleted += count ?? 0;
  }

  console.log(`\n✅ Deleted ${ids.length} agency-attached board(s) and ${jobsDeleted} posting(s) they had ingested.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
