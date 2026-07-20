// Corpus-depth proof for the Teaching Vacancies portal (SEARCH_QUALITY_BASELINE #6).
// Read-only. Reports first-party education supply that DID NOT EXIST before this.
//
//   npx tsx scripts/probe-tv-corpus-depth.ts

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
  const total = await count((q: any) => q.eq("source", "teaching_vacancies"));
  const resolved = await count((q: any) =>
    q.eq("source", "teaching_vacancies").not("lat", "is", null)
  );
  const teachers = await count((q: any) =>
    q.eq("source", "teaching_vacancies").ilike("title", "%teach%")
  );
  const fresh = await count((q: any) =>
    q.eq("source", "teaching_vacancies").gte("last_seen_at", new Date(Date.now() - 14 * 86400000).toISOString())
  );

  console.log("TEACHING VACANCIES — corpus depth (was 0 across ALL of these before today)");
  console.log(`  total rows:            ${total}`);
  console.log(`  geo-resolved (lat/lng):${resolved}`);
  console.log(`  title ~ "teach":       ${teachers}`);
  console.log(`  fresh (<14d):          ${fresh}`);

  // Depth near the baseline's worst case: Sheffield (search #10 was 0 first-party).
  const supabase = createServerSupabaseClient();
  const CITIES = ["Sheffield", "Rotherham", "Barnsley", "Doncaster", "Chesterfield", "Glasgow", "Cardiff", "Leeds", "Bristol", "Birmingham", "London", "Manchester"];
  console.log("\n  first-party school jobs by town (place_name):");
  for (const city of CITIES) {
    const c = await count((q: any) => q.eq("source", "teaching_vacancies").eq("place_name", city));
    if (c > 0) console.log(`    ${city.padEnd(14)} ${c}`);
  }

  // Distinct schools (employers) — the moat is real employers, not agencies.
  const { data: schools } = await supabase
    .from("job_postings")
    .select("company")
    .eq("source", "teaching_vacancies")
    .limit(4000);
  const distinct = new Set((schools ?? []).map((r: any) => (r.company ?? "").toLowerCase().trim()).filter(Boolean));
  console.log(`\n  distinct hiring schools/trusts: ${distinct.size}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
