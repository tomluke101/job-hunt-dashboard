// Verify the job-type / seniority / job-function classifier.
//
//   npx tsx scripts/verify-classify.ts
//
// EXIT 2 = NOT VERIFIED (deliberately not 1, and deliberately not 0).
//
// TWO HALVES, and the second is the one that matters.
//
//   PART A — unit assertions. Cheap, and they encode every trap we know about.
//   PART B — the REAL corpus. Every bug that ever mattered in this codebase
//            survived a fully-green unit suite and was only found by running
//            against real rows: the US jobs in a UK corpus, the ON CONFLICT that
//            wrote nothing, the source that returned zero for ten days. So this
//            half asserts on live data and, crucially, REFUSES TO PASS ON AN EMPTY
//            RESULT SET — a suite that passes over zero rows proves nothing.

import { config } from "dotenv";
config({ path: ".env.local" });

import { createServerSupabaseClient } from "../lib/supabase-server";
import {
  classifyJobType,
  classifySeniority,
  classifyFunction,
  JOB_TYPES,
  SENIORITIES,
  JOB_FUNCTIONS,
  type JobType,
  type Seniority,
  type JobFunction,
} from "../lib/job-search/classify";

let failures = 0;
let checks = 0;

function check(name: string, ok: boolean, detail = "") {
  checks++;
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
}

function eqType(title: string, expected: JobType | null, jd = "", provider?: string | null) {
  const got = classifyJobType(title, jd, provider);
  check(`type  "${title}"${provider ? ` [${provider}]` : ""} → ${expected ?? "null"}`, got === expected, got === expected ? "" : `got ${got}`);
}

function eqSen(title: string, expected: Seniority | null, jd = "", provider?: string | null) {
  const got = classifySeniority(title, jd, provider);
  check(`seniority  "${title}" → ${expected ?? "null"}`, got === expected, got === expected ? "" : `got ${got}`);
}

function eqFn(title: string, expected: JobFunction | null, dept?: string | null) {
  const got = classifyFunction(title, "", dept);
  check(`function  "${title}"${dept ? ` [dept:${dept}]` : ""} → ${expected ?? "null"}`, got === expected, got === expected ? "" : `got ${got}`);
}

async function main() {
  console.log("=== A1. Job type — provider field is the strongest signal\n");
  eqType("Analyst", "full_time", "", "permanent");     // Adzuna contract_type
  eqType("Analyst", "part_time", "", "part_time");     // Adzuna contract_time
  eqType("Analyst", "contract", "", "contract");
  eqType("Analyst", "internship", "", "Intern");       // ATS timeType
  eqType("Analyst", null, "", "");                     // no signal anywhere → null, not a guess

  console.log("\n=== A2. Job type — BASIS beats HOURS (deliberate precedence)\n");
  // A part-time fixed-term contract is a CONTRACT to the user who ticked "Contract".
  // Showing them a 6-month FTC when they asked for part-time work is the mis-sell.
  eqType("Part-Time Finance Assistant (6 Month FTC)", "contract");
  eqType("Part-Time Sales Assistant", "part_time");
  eqType("Summer Internship - Part Time", "internship");
  eqType("Apprentice Electrician (Part-Time)", "apprenticeship");

  console.log("\n=== A3. Job type — from the JD when the title is silent\n");
  eqType("Data Analyst", "contract", "This is a 12 month contract, outside IR35. Day rate negotiable.");
  eqType("Data Analyst", "part_time", "This role is 20 hours per week.");
  eqType("Data Analyst", "full_time", "A permanent role. 37 hours per week.");
  // A permanent ad that merely MENTIONS contractors must not become a contract.
  eqType("Data Analyst", null, "You will manage a team of contractors and suppliers.");

  console.log("\n=== A4. Seniority — the traps (each would misfile into a level a user ASKED for)\n");
  eqSen("Lead Generation Executive", null);   // "lead" = sales leads; "executive" = UK for IC
  eqSen("Head Chef", null);                   // "head" = the kitchen, not the org chart
  eqSen("Art Director", null);                // "director" = the craft
  eqSen("Creative Director", null);
  eqSen("Funeral Director", null);
  eqSen("Senior Living Coordinator", null);   // "senior" = the CLIENT (elderly)

  console.log("\n=== A5. Seniority — the real ladder\n");
  eqSen("Chief Technology Officer", "executive");
  eqSen("VP of Engineering", "executive");
  eqSen("Head of Supply Chain", "director");
  eqSen("Finance Director", "director");
  eqSen("Principal Engineer", "principal");
  eqSen("Team Lead, Payments", "lead");
  eqSen("Warehouse Supervisor", "lead");
  eqSen("Senior Data Analyst", "senior");
  eqSen("Junior Buyer", "junior");
  eqSen("Graduate Scheme - Procurement", "entry");
  eqSen("Summer Analyst Internship", "intern");
  eqSen("Data Analyst", null);                // genuinely unstated → say so
  eqSen("Senior Principal Scientist", "principal"); // most senior marker wins

  console.log("\n=== A6. Seniority — from the JD's experience requirement\n");
  eqSen("Buyer", "mid", "We are looking for 3-5 years experience in procurement.");
  eqSen("Buyer", "senior", "You will have 6+ years experience.");
  eqSen("Buyer", "entry", "No prior experience is necessary — full training given.");

  console.log("\n=== A7. Job function — specific must beat general\n");
  eqFn("Data Engineer", "Data & Analytics");        // NOT Engineering
  eqFn("Software Engineer", "Engineering");
  eqFn("Supply Chain Analyst", "Supply Chain & Logistics"); // NOT Data & Analytics
  eqFn("Procurement Manager", "Supply Chain & Logistics");
  eqFn("DevOps Engineer", "IT & Infrastructure");   // NOT Engineering
  eqFn("Financial Accountant", "Finance & Accounting");
  eqFn("Care Assistant", "Healthcare & Life Sciences");
  eqFn("Head Chef", "Retail & Hospitality");
  eqFn("Quantity Surveyor", "Construction & Property");
  eqFn("Teaching Assistant", "Education & Training");
  eqFn("Account Executive", "Sales");
  eqFn("Receptionist", "Admin & Business Support");

  console.log("\n=== A8. Job function — the employer's raw department is a SIGNAL, not the answer\n");
  // These are REAL job_function values from the corpus. None is a taxonomy.
  eqFn("Somnia Delivery Partner", null, "Somnia");
  eqFn("Specialist", null, "SMB Hub");   // opaque title AND opaque dept → null. Honest.
  eqFn("Specialist", null, "Echo");
  eqFn("Analyst", "Finance & Accounting", "Financial Control"); // legible dept → used
  // The TITLE leads: "Coordinator" is admin support regardless of the employer
  // filing it under "Other" (90 jobs in the corpus sit under that useless label).
  eqFn("Coordinator", "Admin & Business Support", "Other");

  console.log("\n=== A9. Every classifier output is inside its declared value set\n");
  const titles = [
    "Senior Data Engineer", "Part-Time Care Assistant", "Graduate Buyer",
    "Head of Legal", "Warehouse Operative (Temp)", "Apprentice Chef",
  ];
  let allInSet = true;
  for (const t of titles) {
    const ty = classifyJobType(t, "");
    const se = classifySeniority(t, "");
    const fn = classifyFunction(t, "");
    if (ty !== null && !(JOB_TYPES as readonly string[]).includes(ty)) allInSet = false;
    if (se !== null && !(SENIORITIES as readonly string[]).includes(se)) allInSet = false;
    if (fn !== null && !(JOB_FUNCTIONS as readonly string[]).includes(fn)) allInSet = false;
  }
  check("no classifier can emit a value outside its enum", allInSet);

  // -------------------------------------------------------------------------
  console.log("\n=== B. THE REAL CORPUS — the only half that has ever caught a real bug\n");

  const supabase = createServerSupabaseClient();
  type Row = {
    source: string;
    title: string;
    jd_text: string | null;
    department: string | null;
    employment_type: string | null;
    seniority_hint: string | null;
    job_function: string | null;
  };

  // PAGINATE. PostgREST silently caps at 1000 rows, and a verifier that inspects
  // 70% of the evidence while printing PASS is how the geo bugs survived.
  const rows: Row[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from("job_postings")
      .select("source, title, jd_text, department, employment_type, seniority_hint, job_function")
      .range(from, from + 999);
    if (error) {
      check("corpus readable", false, error.message);
      break;
    }
    rows.push(...((data ?? []) as Row[]));
    if ((data ?? []).length < 1000) break;
  }

  // A suite that passes on an empty result set proves nothing.
  check("corpus is non-empty (a pass over zero rows is not a pass)", rows.length > 0, `rows=${rows.length}`);
  if (rows.length === 0) {
    console.log("\n❌ NOT VERIFIED — no corpus to check against.");
    process.exit(2);
  }

  const ATS = new Set(["greenhouse", "lever", "ashby", "smartrecruiters", "recruitee", "workday"]);
  const ats = rows.filter((r) => ATS.has(r.source));
  const agg = rows.filter((r) => !ATS.has(r.source));

  const cov = (list: Row[], get: (r: Row) => string | null) =>
    list.length === 0 ? 0 : Math.round((100 * list.filter((r) => get(r) != null).length) / list.length);

  // Re-classify live rather than trusting the stored column — the stored value is
  // the thing under test, and reading it back to test itself proves only that the
  // column round-trips.
  const reType = (r: Row) => classifyJobType(r.title, r.jd_text ?? "", r.employment_type);
  const reSen = (r: Row) => classifySeniority(r.title, r.jd_text ?? "", r.seniority_hint);
  const reFn = (r: Row) => classifyFunction(r.title, r.jd_text ?? "", r.department ?? r.job_function);

  console.log(`  corpus: ${rows.length} rows  (ATS ${ats.length} / aggregator ${agg.length})\n`);
  console.log("  coverage AFTER classification (was: ATS 55/21/49%, aggregator 0/0/0%)");
  console.log(`    job type    ATS ${cov(ats, reType)}%   aggregator ${cov(agg, reType)}%`);
  console.log(`    seniority   ATS ${cov(ats, reSen)}%   aggregator ${cov(agg, reSen)}%`);
  console.log(`    function    ATS ${cov(ats, reFn)}%   aggregator ${cov(agg, reFn)}%\n`);

  // THE POINT OF THE WHOLE FILE. Reed and Adzuna supply nothing on these three
  // dimensions. If classification doesn't reach them, then the moment a user ticks
  // any box, every aggregator job silently disappears.
  check(
    "aggregator jobs are CLASSIFIED for job function (they arrive with none)",
    agg.length > 0 && cov(agg, reFn) >= 80,
    `${cov(agg, reFn)}% of ${agg.length}`
  );
  check(
    "aggregator jobs are CLASSIFIED for job type",
    agg.length > 0 && cov(agg, reType) >= 50,
    `${cov(agg, reType)}% of ${agg.length}`
  );
  check(
    "ATS job function is now a TAXONOMY value, not an employer department",
    ats.length > 0 && cov(ats, reFn) >= 90,
    `${cov(ats, reFn)}% of ${ats.length}`
  );

  // Every emitted function must be a taxonomy member. "SMB Hub" must never survive.
  const emitted = new Set<string>();
  for (const r of rows) {
    const f = reFn(r);
    if (f) emitted.add(f);
  }
  const strays = [...emitted].filter((f) => !(JOB_FUNCTIONS as readonly string[]).includes(f));
  check(
    "no raw employer department leaks into job_function",
    strays.length === 0,
    strays.length ? `strays: ${strays.join(", ")}` : `${emitted.size} distinct, all canonical`
  );

  // The stored column must AGREE with a fresh classification. If it doesn't, the
  // corpus was written before the classifier and needs a backfill — and a filter
  // reading a stale column is a filter that lies.
  const stale = rows.filter((r) => {
    const want = reFn(r);
    return want !== null && r.job_function !== want;
  });
  check(
    "stored job_function matches a fresh classification (else: run backfill-classify)",
    stale.length === 0,
    stale.length ? `${stale.length}/${rows.length} rows stale — e.g. "${stale[0].title}" stored="${stale[0].job_function}"` : ""
  );

  console.log("\n  top functions in the live corpus:");
  const counts: Record<string, number> = {};
  for (const r of rows) {
    const f = reFn(r) ?? "(unclassified)";
    counts[f] = (counts[f] ?? 0) + 1;
  }
  for (const [f, n] of Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 12)) {
    console.log(`    ${String(n).padStart(5)}  ${f}`);
  }

  console.log("\n" + "=".repeat(70));
  if (failures) {
    console.error(`❌ NOT VERIFIED — ${failures} of ${checks} checks failed.`);
    process.exit(2);
  }
  console.log(`✅ Classifier verified — ${checks} checks passed, against ${rows.length} REAL corpus rows.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
