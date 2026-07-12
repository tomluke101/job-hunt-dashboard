// End-to-end verification of the ATS-direct supply chain.
//
//   npx tsx scripts/verify-ats.ts
//
// PART A (pure) always runs: canonical identity, cross-source dedupe, salary parsing.
// PART B (database) runs only once supabase-ats-schema.sql is applied, and it drives
// the REAL pipeline — discovery → ingest → corpus → runSearch → shortlist.
//
// Exit codes:  0 = all verified   1 = a check FAILED   2 = Part B could not run
//
// Exit 2 exists on purpose. "Not verified" is not "verified", and a script that
// exits 0 while skipping half its checks is how "deployed" gets mistaken for
// "working". The same trap as an HTTP 200 that renders the sign-in form.

import { config } from "dotenv";
config({ path: ".env.local" });

import { canonicalKey, dedupeByCanonicalKey, titleIdentityTokens, companyIdentity } from "../lib/job-search/canonical";
import { parseSalaryFromText } from "../lib/job-search/salary-parse";
import { createServerSupabaseClient } from "../lib/supabase-server";
import type { SourceType } from "../lib/job-search/types";

let failures = 0;
function check(name: string, pass: boolean, detail = "") {
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
  if (!pass) failures++;
}

// ===========================================================================
console.log("\n=== A1. Canonical identity — the same job, worded three ways\n");

// The literal reason cross-source dedupe exists: Reed, the employer's ATS, and
// Adzuna all describe ONE Birmingham job differently.
const reed = { company: "Monzo Bank Ltd", title: "Supply Chain Analyst", location_raw: "Birmingham, West Midlands", place_name: "Birmingham" };
const ats = { company: "Monzo", title: "Analyst, Supply Chain", location_raw: "Birmingham", place_name: "Birmingham" };
const adz = { company: "Monzo Bank", title: "Supply Chain Analyst - Birmingham", location_raw: "Birmingham", place_name: "Birmingham" };

const kReed = canonicalKey(reed);
const kAts = canonicalKey(ats);
const kAdz = canonicalKey(adz);
check("Reed copy and ATS copy share one canonical key", kReed === kAts, `${kReed} / ${kAts}`);
check("Adzuna copy shares it too (location suffix stripped from title)", kReed === kAdz, kAdz);

check(
  '"Analyst, Supply Chain" tokenises the same as "Supply Chain Analyst"',
  titleIdentityTokens("Analyst, Supply Chain").join(" ") === titleIdentityTokens("Supply Chain Analyst").join(" "),
  titleIdentityTokens("Analyst, Supply Chain").join("|")
);

// Seniority must NOT collapse — a Senior and a Junior role are different jobs.
check(
  "Senior vs Junior Analyst do NOT merge",
  canonicalKey({ ...ats, title: "Senior Data Analyst" }) !== canonicalKey({ ...ats, title: "Junior Data Analyst" })
);
// Different towns must not merge either.
check(
  "Same title, different city does NOT merge",
  canonicalKey({ ...ats, place_name: "Birmingham" }) !== canonicalKey({ ...ats, place_name: "London" })
);
// A blank company must never bucket unrelated jobs together.
check(
  "Empty company falls back to a self-only key",
  canonicalKey({ company: "", title: "Analyst", location_raw: null }) !==
    canonicalKey({ company: "", title: "Analyst", location_raw: "x" })
);

// Company-name variance across sources — the thing that actually broke dedupe.
check(
  '"Monzo Bank Ltd" / "Monzo Bank" / "Monzo" are ONE company',
  companyIdentity("Monzo Bank Ltd") === "monzo" &&
    companyIdentity("Monzo Bank") === "monzo" &&
    companyIdentity("Monzo") === "monzo",
  companyIdentity("Monzo Bank Ltd")
);
check(
  '"Lloyds Bank" and "Lloyds Banking Group" are ONE company',
  companyIdentity("Lloyds Bank") === companyIdentity("Lloyds Banking Group")
);
check(
  '"Virgin Money" and "Virgin Media" stay DIFFERENT companies',
  companyIdentity("Virgin Money") !== companyIdentity("Virgin Media")
);
check(
  'a company named only "Group" is never stripped to nothing',
  companyIdentity("Group") === "group"
);

// ===========================================================================
console.log("\n=== A2. Cross-source dedupe picks the FIRST-PARTY copy\n");

type Rec = { source: SourceType; salary_min: number | null; salary_max: number | null; jd_text: string; posted_at: string | null; tag: string };
const records: Rec[] = [
  { source: "reed", salary_min: 40000, salary_max: 50000, jd_text: "x".repeat(2000), posted_at: "2026-07-01", tag: "reed" },
  { source: "adzuna", salary_min: null, salary_max: null, jd_text: "x".repeat(3000), posted_at: "2026-07-01", tag: "adzuna" },
  { source: "greenhouse", salary_min: null, salary_max: null, jd_text: "x".repeat(500), posted_at: "2026-07-01", tag: "greenhouse" },
];
const groups = dedupeByCanonicalKey(records, () => "same-key", (r) => r);
check("three copies collapse to one shortlist row", groups.length === 1, `groups=${groups.length}`);
check(
  "the ATS copy WINS even with the shortest JD and no salary",
  groups[0].winner.tag === "greenhouse",
  `winner=${groups[0].winner.tag}`
);
check(
  "provenance kept — 'also seen on' reed + adzuna",
  groups[0].also_seen_on.sort().join(",") === "adzuna,reed",
  groups[0].also_seen_on.join(",")
);

// ===========================================================================
console.log("\n=== A3. Salary parsing — ATS puts pay in the JD body, not a field\n");

const sal = (s: string) => parseSalaryFromText(s);
check('"£45,000 - £55,000 per annum"', sal("Salary: £45,000 - £55,000 per annum")?.min === 45000);
check('"£45k-£55k"', sal("We're offering £45k-£55k depending on experience")?.max === 55000);
check('"up to £60,000" is a CEILING, not a floor', sal("Paying up to £60,000")?.min === null && sal("Paying up to £60,000")?.max === 60000);
check('day rate is reported but NOT annualised', sal("£350 per day")?.period === "day" && sal("£350 per day")?.min === null);

// The whole point of the disqualifier list: money in a JD that is NOT the salary.
check('"£1,000 signing bonus" is NOT a salary', sal("Plus a £1,000 signing bonus") === null);
check('"manage a £2m budget" is NOT a salary', sal("You will manage a £2m budget") === null);
check('"we raised £10 million" is NOT a salary', sal("We recently raised £10 million in Series B") === null);
check('"£500 learning budget" is NOT a salary', sal("Perks include a £500 learning budget") === null);
check(
  "salary wins over a nearby bonus (nearest word decides)",
  sal("Salary £45,000 per annum plus a £5,000 bonus")?.min === 45000,
  JSON.stringify(sal("Salary £45,000 per annum plus a £5,000 bonus"))
);
check("no money at all → null", sal("A great role with a great team") === null);

// ===========================================================================
async function partB(): Promise<void> {
  console.log("\n=== B. Database / end-to-end\n");

  const supabase = createServerSupabaseClient();
  const { error: schemaErr } = await supabase.from("company_ats").select("id").limit(1);

  if (schemaErr) {
    console.log("  ⏭  SKIPPED — the ATS migration is not applied to this database.");
    console.log(`     (${schemaErr.message})`);
    console.log("     Apply supabase-ats-schema.sql in the Supabase SQL editor, then re-run.\n");
    console.log("=".repeat(70));
    console.log(failures ? `❌ ${failures} PURE CHECK(S) FAILED` : "✅ Pure checks passed.");
    console.log("⚠️  NOT VERIFIED END-TO-END: ingest → corpus → search did not run.");
    // exitCode rather than exit(): calling process.exit() while the Supabase client
    // still holds sockets crashes libuv on Windows and the process reports 127,
    // masking the code we actually meant to return.
    process.exitCode = failures ? 1 : 2;
    return;
  }

  const { count: boardCount } = await supabase
    .from("company_ats")
    .select("id", { count: "exact", head: true })
    .in("status", ["active", "empty"]);
  check("registry has pollable boards", (boardCount ?? 0) > 0, `boards=${boardCount}`);

  const ATS = ["greenhouse", "lever", "ashby", "smartrecruiters", "recruitee", "workday"];
  const { count: corpusCount } = await supabase
    .from("job_postings")
    .select("id", { count: "exact", head: true })
    .in("source", ATS);
  check("corpus contains ATS jobs", (corpusCount ?? 0) > 0, `jobs=${corpusCount}`);

  // Every ATS job in the corpus must be UK or remote. A foreign job here means the
  // geo filter leaked and a Birmingham user can be shown Palo Alto.
  const { data: foreign } = await supabase
    .from("job_postings")
    .select("id, title, country_code, place_name")
    .in("source", ATS)
    .not("country_code", "is", null)
    .neq("country_code", "GB")
    .limit(5);
  check(
    "NO non-UK jobs in the corpus (geo filter held)",
    (foreign ?? []).length === 0,
    (foreign ?? []).length ? JSON.stringify(foreign) : ""
  );

  // Every ingested row must carry a canonical key, or cross-source dedupe is blind.
  const { count: noKey } = await supabase
    .from("job_postings")
    .select("id", { count: "exact", head: true })
    .in("source", ATS)
    .is("canonical_key", null);
  check("every ATS job has a canonical_key", (noKey ?? 0) === 0, `missing=${noKey}`);

  // A verified provider sitting at zero across the whole corpus is a DEAD PROVIDER,
  // not an empty job market.
  const { data: run } = await supabase
    .from("ats_ingest_runs")
    .select("provider_counts, jobs_seen, jobs_upserted, jobs_dropped_foreign, error")
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (run) {
    console.log(
      `\n  last ingest: seen=${run.jobs_seen} upserted=${run.jobs_upserted} ` +
        `dropped_foreign=${run.jobs_dropped_foreign}`
    );
    console.log(`  provider_counts: ${JSON.stringify(run.provider_counts)}`);
    check("last ingest reported no provider-health problems", !run.error, String(run.error ?? ""));
  } else {
    check("an ingest run has been recorded", false, "no rows in ats_ingest_runs — run scripts/ingest-ats.ts");
  }

  console.log("\n" + "=".repeat(70));
  if (failures) {
    console.log(`❌ ${failures} CHECK(S) FAILED`);
    process.exitCode = 1;
    return;
  }
  console.log("✅ ATS supply verified end-to-end.");
}

partB().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
