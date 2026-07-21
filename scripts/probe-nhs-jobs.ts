// Probe the NHS Jobs adapter against the LIVE candidate site — read-only, writes
// nothing. Confirms pagination + card field mapping before we populate the corpus.
//
//   npx tsx scripts/probe-nhs-jobs.ts             # default 60s budget
//   npx tsx scripts/probe-nhs-jobs.ts --budget 20  # cap seconds

import { nhsJobsProvider, NHS_JOBS_SEARCH } from "../lib/ats/providers/nhs-jobs";

const val = (f: string) => {
  const i = process.argv.indexOf(f);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

async function main() {
  const budgetMs = (parseInt(val("--budget") ?? "0", 10) || 60) * 1000;
  const t0 = Date.now();
  const res = await nhsJobsProvider.listJobs(
    { provider: "nhs_jobs", token: NHS_JOBS_SEARCH },
    { budgetMs }
  );
  const secs = ((Date.now() - t0) / 1000).toFixed(1);

  if (res.error) console.log(`error: ${res.error}`);
  console.log(`pulled ${res.jobs.length} jobs in ${secs}s  (truncated=${!!res.truncated})\n`);

  const byId = new Map<string, number>();
  for (const j of res.jobs) byId.set(j.source_id, (byId.get(j.source_id) ?? 0) + 1);
  const dupIds = [...byId.entries()].filter(([, n]) => n > 1);
  console.log(`distinct source_id: ${byId.size}/${res.jobs.length}  (dup ids: ${dupIds.length})`);

  const withPostcode = res.jobs.filter((j) => /[A-Z]{1,2}\d/i.test(j.location_raw ?? "")).length;
  const withEmployer = res.jobs.filter((j) => j.company.trim()).length;
  const withSalary = res.jobs.filter((j) => /salary:/i.test(j.jd_text)).length;
  const withExpiry = res.jobs.filter((j) => j.expires_at).length;
  const withPosted = res.jobs.filter((j) => j.posted_at).length;
  const withEmpType = res.jobs.filter((j) => j.employment_type).length;
  const nurseish = res.jobs.filter((j) => /nurse|nursing/i.test(j.title)).length;
  const careish = res.jobs.filter((j) => /care|support worker|healthcare assistant/i.test(j.title)).length;
  console.log(`with postcode in location_raw: ${withPostcode}/${res.jobs.length}`);
  console.log(`with employer:                 ${withEmployer}/${res.jobs.length}`);
  console.log(`with salary text in JD:        ${withSalary}/${res.jobs.length}`);
  console.log(`with posted date:              ${withPosted}/${res.jobs.length}`);
  console.log(`with closing date:             ${withExpiry}/${res.jobs.length}`);
  console.log(`with employment_type:          ${withEmpType}/${res.jobs.length}`);
  console.log(`title ~ nurse/nursing:         ${nurseish}/${res.jobs.length}`);
  console.log(`title ~ care/support/HCA:      ${careish}/${res.jobs.length}\n`);

  console.log("SAMPLE (first 6):");
  for (const j of res.jobs.slice(0, 6)) {
    console.log(`  • "${j.title}" @ ${j.company}`);
    console.log(`    loc_raw=${JSON.stringify(j.location_raw)}  candidates=${JSON.stringify(j.location_candidates)}`);
    console.log(`    id=${j.source_id}  emp=${j.employment_type}  posted=${j.posted_at?.slice(0, 10)}  expires=${j.expires_at?.slice(0, 10)}  country=${j.country_hint}`);
    console.log(`    jd=${JSON.stringify(j.jd_text.slice(0, 120))}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
