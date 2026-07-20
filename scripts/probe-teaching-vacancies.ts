// Probe the Teaching Vacancies adapter against the LIVE portal — read-only, writes
// nothing. Confirms pagination + field mapping before we populate the corpus.
//
//   npx tsx scripts/probe-teaching-vacancies.ts            # full pull (all pages)
//   npx tsx scripts/probe-teaching-vacancies.ts --budget 20  # cap seconds

import { teachingVacanciesProvider, TEACHING_VACANCIES_API } from "../lib/ats/providers/teaching-vacancies";

const val = (f: string) => {
  const i = process.argv.indexOf(f);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

async function main() {
  const budgetMs = (parseInt(val("--budget") ?? "0", 10) || 300) * 1000;
  const t0 = Date.now();
  const res = await teachingVacanciesProvider.listJobs(
    { provider: "teaching_vacancies", token: TEACHING_VACANCIES_API },
    { budgetMs }
  );
  const secs = ((Date.now() - t0) / 1000).toFixed(1);

  if (res.error) console.log(`error: ${res.error}`);
  console.log(`pulled ${res.jobs.length} jobs in ${secs}s  (truncated=${!!res.truncated})\n`);

  // Duplicate diagnostics (the ingest hit "ON CONFLICT ... cannot affect row twice").
  const byId = new Map<string, number>();
  const byUrl = new Map<string, number>();
  for (const j of res.jobs) {
    byId.set(j.source_id, (byId.get(j.source_id) ?? 0) + 1);
    byUrl.set(j.source_url ?? "", (byUrl.get(j.source_url ?? "") ?? 0) + 1);
  }
  const dupIds = [...byId.entries()].filter(([, n]) => n > 1);
  const dupUrls = [...byUrl.entries()].filter(([, n]) => n > 1);
  console.log(`distinct source_id:  ${byId.size}/${res.jobs.length}  (dup ids: ${dupIds.length})`);
  console.log(`distinct source_url: ${byUrl.size}/${res.jobs.length}  (dup urls: ${dupUrls.length})`);
  for (const [id, n] of dupIds.slice(0, 5)) {
    const hits = res.jobs.filter((j) => j.source_id === id);
    console.log(`   DUP id x${n}: ${id}`);
    for (const h of hits) console.log(`       url=${h.source_url}  title="${h.title}"`);
  }
  console.log("");

  const withPostcode = res.jobs.filter((j) => /[A-Z]{1,2}\d/i.test(j.location_raw ?? "")).length;
  const withCompany = res.jobs.filter((j) => j.company.trim()).length;
  const withSalary = res.jobs.filter((j) => /salary:/i.test(j.jd_text)).length;
  const withExpiry = res.jobs.filter((j) => j.expires_at).length;
  const teacherish = res.jobs.filter((j) => /teacher|teaching/i.test(j.title)).length;
  console.log(`with postcode in location_raw: ${withPostcode}/${res.jobs.length}`);
  console.log(`with company (school):         ${withCompany}/${res.jobs.length}`);
  console.log(`with salary text in JD:        ${withSalary}/${res.jobs.length}`);
  console.log(`with expiry (validThrough):    ${withExpiry}/${res.jobs.length}`);
  console.log(`title contains teacher/teaching: ${teacherish}/${res.jobs.length}\n`);

  console.log("SAMPLE (first 5):");
  for (const j of res.jobs.slice(0, 5)) {
    console.log(`  • "${j.title}" @ ${j.company}`);
    console.log(`    loc_raw=${JSON.stringify(j.location_raw)}  candidates=${JSON.stringify(j.location_candidates)}`);
    console.log(`    id=${j.source_id}  emp=${j.employment_type}  posted=${j.posted_at?.slice(0, 10)}  expires=${j.expires_at?.slice(0, 10)}  country=${j.country_hint}`);
    console.log(`    jd[0..90]=${JSON.stringify(j.jd_text.slice(0, 90))}`);
  }

  // A few teaching titles, to sanity-check what a "Primary Teacher" search must match.
  const teachers = res.jobs.filter((j) => /teacher|teaching/i.test(j.title)).slice(0, 12);
  console.log("\nSAMPLE TEACHING TITLES:");
  for (const j of teachers) console.log(`  - "${j.title}"  (${j.location_raw})`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
