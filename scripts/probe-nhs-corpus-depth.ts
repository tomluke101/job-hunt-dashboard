// Corpus-depth proof for the NHS Jobs portal (SEARCH_QUALITY_BASELINE #6 — care /
// nursing / health). Read-only. Reports first-party care/health supply that DID
// NOT EXIST before this.
//
//   npx tsx scripts/probe-nhs-corpus-depth.ts

import { config } from "dotenv";
config({ path: ".env.local" });

import { createServerSupabaseClient } from "../lib/supabase-server";

async function count(where: (q: any) => any): Promise<number> {
  const supabase = createServerSupabaseClient();
  const base = supabase.from("job_postings").select("id", { count: "exact", head: true });
  const { count: c } = await where(base);
  return c ?? 0;
}

async function main() {
  const total = await count((q: any) => q.eq("source", "nhs_jobs"));
  const resolved = await count((q: any) => q.eq("source", "nhs_jobs").not("lat", "is", null));
  const nurses = await count((q: any) => q.eq("source", "nhs_jobs").ilike("title", "%nurse%"));
  const care = await count((q: any) => q.eq("source", "nhs_jobs").ilike("title", "%care%"));
  const fresh = await count((q: any) =>
    q.eq("source", "nhs_jobs").gte("last_seen_at", new Date(Date.now() - 14 * 86400000).toISOString())
  );

  console.log("NHS JOBS — corpus depth (was 0 across ALL of these before today)");
  console.log(`  total rows:              ${total}`);
  console.log(`  geo-resolved (lat/lng):  ${resolved}`);
  console.log(`  title ~ "nurse":         ${nurses}`);
  console.log(`  title ~ "care":          ${care}`);
  console.log(`  fresh (<14d):            ${fresh}`);

  // Depth near the audit's care/nursing searches: #7 Nurse/Glasgow, #9 Care/Cardiff.
  const supabase = createServerSupabaseClient();
  const CITIES = ["Glasgow", "Cardiff", "Sheffield", "Leeds", "Bristol", "Birmingham", "London", "Manchester", "Liverpool", "Newcastle upon Tyne", "Carlisle", "Nottingham"];
  console.log("\n  first-party NHS/care jobs by town (place_name):");
  for (const city of CITIES) {
    const c = await count((q: any) => q.eq("source", "nhs_jobs").eq("place_name", city));
    if (c > 0) console.log(`    ${city.padEnd(20)} ${c}`);
  }

  // The two audit coverage cells, EXACTLY as audit-search-quality.ts computes them:
  //   #7 title ~ "Registered" @ Glasgow ; #9 title ~ "Care" @ Cardiff.
  const nurseGlasgow = await count((q: any) => q.eq("source", "nhs_jobs").ilike("title", "%Registered%").eq("place_name", "Glasgow"));
  const careCardiff = await count((q: any) => q.eq("source", "nhs_jobs").ilike("title", "%Care%").eq("place_name", "Cardiff"));
  console.log(`\n  audit coverage cells (nhs_jobs only):`);
  console.log(`    #7  title~"Registered" @ Glasgow: ${nurseGlasgow}`);
  console.log(`    #9  title~"Care" @ Cardiff:       ${careCardiff}`);

  // Distinct employers (trusts / practices / care providers) — the moat is real
  // employers, not agencies.
  const { data: emps } = await supabase
    .from("job_postings")
    .select("company")
    .eq("source", "nhs_jobs")
    .limit(8000);
  const distinct = new Set((emps ?? []).map((r: any) => (r.company ?? "").toLowerCase().trim()).filter(Boolean));
  console.log(`\n  distinct hiring employers (trusts/practices/care providers): ${distinct.size}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
