// Throwaway probe: what does the corpus + registry actually look like right now?
//
// Two traps this script itself fell into on the first draft, both of which are the
// house special (a silent zero that looks like a real answer):
//   1. Selecting a column that does not exist → PostgREST returns an ERROR and an
//      EMPTY array. Unchecked, that reads as "the registry is empty".
//   2. `.limit(50000)` is silently clamped to PostgREST's server-side 1000-row cap.
//      You must PAGINATE. This is exactly how the original verify-ats covered
//      1000 of 1440 rows while printing a confident PASS.
import { config } from "dotenv";
config({ path: ".env.local" });
import { createServerSupabaseClient } from "../lib/supabase-server";

const supabase = createServerSupabaseClient();

/** Never let a query error read as an empty result. */
function must<T>(res: { data: T[] | null; error: { message: string } | null }, what: string): T[] {
  if (res.error) throw new Error(`${what}: ${res.error.message}`);
  return res.data ?? [];
}

/** Page past PostgREST's 1000-row cap. A partial read is a lie, not a sample. */
async function selectAll<T>(table: string, cols: string): Promise<T[]> {
  const out: T[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const res = await supabase.from(table).select(cols).range(from, from + PAGE - 1);
    const rows = must(res as never, `${table}.select(${cols})`) as T[];
    out.push(...rows);
    if (rows.length < PAGE) return out;
  }
}

async function main() {
  const runs = must(
    await supabase.from("ats_ingest_runs").select("*").order("finished_at", { ascending: false }).limit(3),
    "ats_ingest_runs"
  ) as Record<string, unknown>[];
  console.log("=== LAST 3 INGEST RUNS ===");
  for (const r of runs) {
    console.log(
      `${r.finished_at} trigger=${r.trigger} polled=${r.boards_polled} failed=${r.boards_failed} ` +
        `seen=${r.jobs_seen} upserted=${r.jobs_upserted} foreign=${r.jobs_dropped_foreign} unresolved=${r.jobs_dropped_unresolved}`
    );
    console.log(`   provider_counts: ${JSON.stringify(r.provider_counts)}`);
    if (r.error) console.log(`   ERROR: ${r.error}`);
  }

  console.log("\n=== REGISTRY ===");
  type B = {
    provider: string;
    board_token: string;
    company_name: string;
    status: string;
    last_job_count: number | null;
    last_error: string | null;
    workday_site: string | null;
    discovered_via: string | null;
  };
  const boards = await selectAll<B>(
    "company_ats",
    "provider, board_token, company_name, status, last_job_count, last_error, workday_site, discovered_via"
  );
  const byStatus: Record<string, number> = {};
  const byVia: Record<string, number> = {};
  for (const b of boards) {
    byStatus[b.status] = (byStatus[b.status] ?? 0) + 1;
    byVia[b.discovered_via ?? "?"] = (byVia[b.discovered_via ?? "?"] ?? 0) + 1;
  }
  console.log(`total=${boards.length}  status=${JSON.stringify(byStatus)}  discovered_via=${JSON.stringify(byVia)}`);

  boards.sort((a, b) => (b.last_job_count ?? 0) - (a.last_job_count ?? 0));
  console.log("\ntop boards by last_job_count  (⚠️ >=1000 means it HIT MAX_JOBS_PER_BOARD and the tail was dropped):");
  for (const b of boards.slice(0, 12)) {
    const flag = (b.last_job_count ?? 0) >= 1000 ? "   ⚠️ TRUNCATED" : "";
    console.log(
      `  ${String(b.last_job_count ?? 0).padStart(5)}  ${b.provider}/${b.board_token}` +
        `${b.workday_site ? "/" + b.workday_site : ""} — ${b.company_name} [${b.status}]${flag}`
    );
  }
  const failing = boards.filter((b) => b.last_error);
  console.log(`\nboards with a last_error: ${failing.length}`);
  for (const b of failing) console.log(`  ${b.provider}/${b.board_token}: ${b.last_error}`);

  console.log("\n=== CORPUS ===");
  const jobs = await selectAll<{
    source: string;
    employment_type: string | null;
    seniority_hint: string | null;
    job_function: string | null;
    title: string;
  }>("job_postings", "source, employment_type, seniority_hint, job_function, title");
  console.log(`total rows: ${jobs.length}   (paginated — NOT the 1000-row cap)`);

  const bySource: Record<string, number> = {};
  for (const j of jobs) bySource[j.source] = (bySource[j.source] ?? 0) + 1;
  console.log(`by source: ${JSON.stringify(bySource)}`);

  const ATS = new Set(["greenhouse", "lever", "ashby", "smartrecruiters", "recruitee", "workday"]);
  const ats = jobs.filter((j) => ATS.has(j.source));
  const agg = jobs.filter((j) => !ATS.has(j.source));
  console.log(`ATS rows: ${ats.length}   aggregator rows: ${agg.length}`);

  console.log("\n=== THE 3 MISSING FILTERS — is the data actually there? ===");
  for (const col of ["employment_type", "seniority_hint", "job_function"] as const) {
    const atsHave = ats.filter((j) => j[col] != null).length;
    const aggHave = agg.filter((j) => j[col] != null).length;
    console.log(
      `  ${col.padEnd(16)} ATS ${atsHave}/${ats.length} (${Math.round((100 * atsHave) / (ats.length || 1))}%)` +
        `   aggregator ${aggHave}/${agg.length} (${Math.round((100 * aggHave) / (agg.length || 1))}%)`
    );
  }

  const fns: Record<string, number> = {};
  for (const j of ats) if (j.job_function) fns[j.job_function] = (fns[j.job_function] ?? 0) + 1;
  const distinct = Object.keys(fns).length;
  const top = Object.entries(fns).sort((a, b) => b[1] - a[1]).slice(0, 12);
  console.log(`\n  job_function: ${distinct} DISTINCT values across ${ats.filter((j) => j.job_function).length} jobs.`);
  console.log(`  top 12: ${JSON.stringify(Object.fromEntries(top))}`);
  console.log(`  ⚠️ these are the EMPLOYER'S internal department names, not a taxonomy.`);

  const sen: Record<string, number> = {};
  for (const j of ats) if (j.seniority_hint) sen[j.seniority_hint] = (sen[j.seniority_hint] ?? 0) + 1;
  console.log(`\n  seniority_hint values: ${JSON.stringify(sen)}`);

  const emp: Record<string, number> = {};
  for (const j of ats) if (j.employment_type) emp[j.employment_type] = (emp[j.employment_type] ?? 0) + 1;
  console.log(`  employment_type values: ${JSON.stringify(emp)}`);
}

main().catch((e) => {
  console.error(String(e));
  process.exit(1);
});
