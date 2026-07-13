// Re-classify every posting already in the corpus.
//
//   npx tsx scripts/backfill-classify.ts            # report only
//   npx tsx scripts/backfill-classify.ts --commit   # write
//
// Run this after ANY change to lib/job-search/classify.ts. The corpus was written
// before the classifier existed, so `job_function` on those rows still holds the
// employer's raw department string ("SMB Hub", "Echo", "Somnia") and seniority is
// mostly null — and a FILTER READING A STALE COLUMN IS A FILTER THAT LIES: the user
// ticks "Engineering", the pipeline compares against "Echo", and the job vanishes
// with no explanation.
//
// verify-classify.ts asserts the stored column agrees with a fresh classification,
// so it FAILS until this has run. That is the intended relationship between them.

import { config } from "dotenv";
config({ path: ".env.local" });

import { createServerSupabaseClient } from "../lib/supabase-server";
import { classifyJob } from "../lib/job-search/classify";

const COMMIT = process.argv.includes("--commit");

interface Row {
  id: string;
  title: string;
  jd_text: string | null;
  department: string | null;
  employment_type: string | null;
  seniority_hint: string | null;
  job_function: string | null;
}

async function main() {
  const supabase = createServerSupabaseClient();

  // Paginate: PostgREST caps at 1000 rows and silently truncates. A backfill that
  // covers 1000 of 1627 rows leaves 627 lying to every filter.
  const rows: Row[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from("job_postings")
      .select("id, title, jd_text, department, employment_type, seniority_hint, job_function")
      .range(from, from + 999);
    if (error) throw new Error(`read job_postings: ${error.message}`);
    const batch = (data ?? []) as Row[];
    rows.push(...batch);
    if (batch.length < 1000) break;
  }
  console.log(`Read ${rows.length} postings.\n`);
  if (rows.length === 0) {
    console.error("❌ Corpus is empty — nothing to backfill. That is itself suspicious.");
    process.exit(1);
  }

  const updates: Array<{ id: string; employment_type: string | null; seniority_hint: string | null; job_function: string | null }> = [];
  let unchanged = 0;

  for (const r of rows) {
    // The raw employer department is the INPUT. On rows written before the
    // classifier, that raw string is also sitting in job_function — so fall back to
    // it, or we would re-derive from nothing and wipe the signal we still have.
    const c = classifyJob({
      title: r.title,
      jd_text: r.jd_text,
      employment_type: r.employment_type,
      seniority_hint: r.seniority_hint,
      department: r.department ?? r.job_function,
      job_function: r.job_function,
    });

    if (
      c.employment_type === r.employment_type &&
      c.seniority === r.seniority_hint &&
      c.job_function === r.job_function
    ) {
      unchanged++;
      continue;
    }
    updates.push({
      id: r.id,
      employment_type: c.employment_type,
      seniority_hint: c.seniority,
      job_function: c.job_function,
    });
  }

  const cov = (get: (u: (typeof updates)[number]) => string | null) =>
    Math.round((100 * updates.filter((u) => get(u) != null).length) / (updates.length || 1));

  console.log(`unchanged      ${unchanged}`);
  console.log(`to update      ${updates.length}`);
  console.log(`  of those — job type ${cov((u) => u.employment_type)}% · seniority ${cov((u) => u.seniority_hint)}% · function ${cov((u) => u.job_function)}%\n`);

  if (!COMMIT) {
    console.log("DRY RUN — nothing written. Re-run with --commit to apply.");
    for (const u of updates.slice(0, 8)) {
      const r = rows.find((x) => x.id === u.id)!;
      console.log(
        `  "${r.title.slice(0, 46)}"\n` +
          `      function  ${JSON.stringify(r.job_function)} → ${JSON.stringify(u.job_function)}\n` +
          `      seniority ${JSON.stringify(r.seniority_hint)} → ${JSON.stringify(u.seniority_hint)}`
      );
    }
    return;
  }

  let written = 0;
  let failed = 0;
  for (const u of updates) {
    const { error } = await supabase
      .from("job_postings")
      .update({
        employment_type: u.employment_type,
        seniority_hint: u.seniority_hint,
        job_function: u.job_function,
      })
      .eq("id", u.id);
    if (error) {
      failed++;
      if (failed <= 3) console.error(`  write failed for ${u.id}: ${error.message}`);
    } else {
      written++;
    }
    if (written % 250 === 0 && written) process.stdout.write(`\r  written ${written}/${updates.length}`);
  }
  process.stdout.write("\n");

  // A write that silently reports success is the same bug as a source that silently
  // returns zero. Fail loudly rather than printing a confident ✅ over nothing.
  if (failed) {
    console.error(`\n❌ ${failed} of ${updates.length} writes FAILED. The corpus is half-classified.`);
    process.exit(1);
  }
  console.log(`\n✅ Backfilled ${written} postings. Now run: npx tsx scripts/verify-classify.ts`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
