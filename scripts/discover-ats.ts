// Populate the company → ATS board registry.
//
//   npx tsx scripts/discover-ats.ts --seed              # the curated UK seed list
//   npx tsx scripts/discover-ats.ts --from-enrichment   # every company we've already enriched
//   npx tsx scripts/discover-ats.ts --from-postings     # every employer seen in any search
//   npx tsx scripts/discover-ats.ts --company "Monzo"   # one company
//   ... --probe-only     token probe only (fast, free — no crawl, no LLM)
//   ... --llm            allow the LLM domain-resolution rung (~$0.001/company)
//   ... --limit N        cap how many companies to attempt
//   ... --recheck        ignore the negative-result cache
//
// --from-postings is the compounding one: every employer name that has EVER
// appeared in a Reed/Adzuna pull gets queued, so the registry grows to cover
// exactly the companies our users' searches actually surface. Recruiters are
// skipped — an agency has no first-party board, and probing them is pure waste.

import { config } from "dotenv";
config({ path: ".env.local" });

import { createServerSupabaseClient } from "../lib/supabase-server";
import { discoverForCompany } from "../lib/ats/discover";
import { upsertBoard, loadDiscoveryBlocklist, recordDiscoveryAttempt } from "../lib/ats/registry";
import { SEED_COMPANIES } from "../lib/ats/seed-companies";
import { normaliseCompanyName, isUnmatchableName } from "../lib/enrichment/normalise-company";

const argv = process.argv.slice(2);
const has = (f: string) => argv.includes(f);
const val = (f: string) => {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] : undefined;
};

const PROBE_ONLY = has("--probe-only");
const USE_LLM = has("--llm");
const RECHECK = has("--recheck");
// Probe and report, touch no tables. Lets us measure ATS COVERAGE — the number
// that decides whether this moat is real — without the schema being applied yet.
const DRY_RUN = has("--dry-run");
const LIMIT = parseInt(val("--limit") ?? "0", 10) || 0;
const CONCURRENCY = 6;

async function companiesFromEnrichment(): Promise<string[]> {
  const supabase = createServerSupabaseClient();
  const { data } = await supabase
    .from("company_enrichment")
    .select("raw_names, normalised_name, is_likely_recruiter")
    .eq("is_likely_recruiter", false); // agencies have no first-party board
  return (data ?? [])
    .map((r) => ((r.raw_names as string[]) ?? [])[0] ?? (r.normalised_name as string))
    .filter(Boolean);
}

/**
 * Every employer ever seen in a pull — MINUS the recruitment agencies.
 *
 * 🔴 THE AGENCY TRAP. This function used to return every company name in
 * job_postings, agencies included, even though the header of this file has always
 * claimed recruiters were skipped. They were not. A recruitment agency has NO
 * first-party board, so discovery cannot find "Reed's board" — it finds SOMEONE
 * ELSE'S and attaches it to the agency's name. Live results from one run:
 *
 *     Reed     → workday/howdenjoinerylimited   (Howden Joinery's 155 real jobs)
 *     Cedar    → ashby/cedar                    (a US healthcare fintech)
 *     Pareto   → ashby/pareto-ai                (an unrelated AI startup)
 *     Huntress → greenhouse/huntress            (a US security company)
 *
 * The next ingest would have filed Howdens' entire req list under the employer name
 * "Reed" — recruiter-branded FIRST-PARTY jobs, which is the precise inversion of
 * what ATS-direct supply exists to achieve. `job_postings` is also exactly where
 * recruiter-posted rows live, so this is the one source of company names where
 * agencies are GUARANTEED to be over-represented.
 *
 * Also: `.limit(10_000)` was a no-op. PostgREST caps a response at 1000 rows
 * server-side, so this read 1,000 of 1,627 postings and the tail of the employer
 * list was never discovered at all.
 */
async function companiesFromPostings(): Promise<string[]> {
  const supabase = createServerSupabaseClient();

  const companies: string[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from("job_postings")
      .select("company")
      .range(from, from + 999);
    if (error) throw new Error(`read job_postings: ${error.message}`);
    const batch = data ?? [];
    companies.push(...batch.map((r) => r.company as string).filter(Boolean));
    if (batch.length < 1000) break;
  }

  // Agencies, by normalised name. An unenriched company is NOT assumed innocent
  // here — but it isn't assumed guilty either; enrichment is the only evidence we
  // have, and it flags the agencies we've actually met.
  const recruiters = new Set<string>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from("company_enrichment")
      .select("normalised_name")
      .eq("is_likely_recruiter", true)
      .range(from, from + 999);
    if (error) throw new Error(`read company_enrichment: ${error.message}`);
    const batch = data ?? [];
    for (const r of batch) recruiters.add(r.normalised_name as string);
    if (batch.length < 1000) break;
  }

  const unique = [...new Set(companies)];
  const kept = unique.filter((c) => !recruiters.has(normaliseCompanyName(c)));
  console.log(
    `From postings: ${unique.length} distinct employers, ` +
      `${unique.length - kept.length} dropped as recruitment agencies (they have no first-party board).`
  );
  return kept;
}

async function main() {
  let companies: string[] = [];
  const one = val("--company");

  if (one) companies = [one];
  else if (has("--from-enrichment")) companies = await companiesFromEnrichment();
  else if (has("--from-postings")) companies = await companiesFromPostings();
  else if (has("--seed")) companies = SEED_COMPANIES;
  else companies = [...SEED_COMPANIES];

  // De-dupe on the normalised key and drop placeholders ("Confidential", "N/A").
  const seen = new Set<string>();
  companies = companies.filter((c) => {
    const n = normaliseCompanyName(c);
    if (!n || isUnmatchableName(n) || seen.has(n)) return false;
    seen.add(n);
    return true;
  });

  if (!RECHECK && !DRY_RUN) {
    const blocked = await loadDiscoveryBlocklist();
    const before = companies.length;
    companies = companies.filter((c) => !blocked.has(normaliseCompanyName(c)));
    if (before !== companies.length) {
      console.log(`Skipping ${before - companies.length} already-attempted (use --recheck to force).`);
    }
  }

  if (LIMIT) companies = companies.slice(0, LIMIT);

  console.log(
    `Discovering ATS boards for ${companies.length} companies ` +
      `(probeOnly=${PROBE_ONLY} llm=${USE_LLM}, concurrency=${CONCURRENCY})\n`
  );

  let found = 0;
  let missed = 0;
  let unverified = 0;
  let writeErrors = 0;
  const byProvider: Record<string, number> = {};

  let cursor = 0;
  async function worker() {
    for (;;) {
      const i = cursor++;
      if (i >= companies.length) return;
      const name = companies[i];

      try {
        const { board, providersTried, notes } = await discoverForCompany(name, {
          probeOnly: PROBE_ONLY,
          useLlm: USE_LLM,
        });

        if (board) {
          if (!DRY_RUN) {
            await upsertBoard(board);
            await recordDiscoveryAttempt(name, true, providersTried, notes);
          }
          found++;
          if (!board.verified) unverified++;
          byProvider[board.provider] = (byProvider[board.provider] ?? 0) + 1;
          console.log(
            `✅ ${name} → ${board.provider}/${board.token}` +
              `${board.workday ? `/${board.workday.site}` : ""} ` +
              `(${board.job_count} jobs${board.verified ? "" : ", UNVERIFIED"}) — ${board.discovered_via}`
          );
        } else {
          if (!DRY_RUN) await recordDiscoveryAttempt(name, false, providersTried, notes);
          missed++;
          console.log(`—  ${name}: ${notes}`);
        }
      } catch (e) {
        // A REGISTRY WRITE failure is not a "miss" — the board was found, we just
        // failed to persist it. Counting it as a miss (or printing a ✅) is how 38
        // boards got reported as discovered while the table stayed empty.
        writeErrors++;
        console.log(`💥 ${name}: ${String(e)}`);
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  console.log(`\n${"=".repeat(60)}`);
  console.log(`FOUND    ${found}  (${unverified} unverified — held back from ingest)`);
  console.log(`MISSED   ${missed}`);
  console.log(`BY PROVIDER: ${JSON.stringify(byProvider)}`);
  console.log(
    `\nA miss is normal: most employers are not on a public ATS. The misses are cached\n` +
      `(company_ats_discovery) and won't be re-probed for 30 days.`
  );

  if (writeErrors) {
    console.error(`\n❌ ${writeErrors} board(s) were DISCOVERED but FAILED TO PERSIST.`);
    console.error(`   The registry is incomplete. Fix the write error above and re-run.`);
    process.exitCode = 1;
    return;
  }

  // Discovery that finds boards but writes none is a broken run, not an empty market.
  if (!DRY_RUN && found > 0) {
    const supabase = createServerSupabaseClient();
    const { count } = await supabase.from("company_ats").select("id", { count: "exact", head: true });
    if (!count) {
      console.error(`\n❌ Found ${found} boards but company_ats is EMPTY. The writes did not land.`);
      process.exitCode = 1;
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
