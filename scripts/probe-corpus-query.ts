// Why does the ATS corpus return ZERO jobs to a real search?
//
// The corpus holds 1,854 UK first-party jobs. A live "Supply Chain Analyst" search
// near Birmingham returned Reed + Adzuna only — including an ALDI job via Adzuna,
// while smartrecruiters/AldiStores sits in our own registry with 152 jobs.
//
// So we peel the corpus query apart one filter at a time and watch where the rows die.
import { config } from "dotenv";
config({ path: ".env.local" });

import { createServerSupabaseClient } from "../lib/supabase-server";
import { ATS_SOURCES } from "../lib/job-search/types";
import { buildTargets, roleNouns, titleRelevantAny } from "../lib/job-search/title-match";
import { resolveOrigin } from "../lib/geo";
import { pullFromCorpus } from "../lib/job-search/sources/ats-corpus";

const MAX_STALE_DAYS = 14;
const MILES_PER_DEG_LAT = 69.0;

async function main() {
  const supabase = createServerSupabaseClient();
  const origin = await resolveOrigin("B1 1AA");
  const radiusMiles = 25;
  const targetTitles = ["Supply Chain Analyst"];

  console.log(`origin: ${JSON.stringify(origin)}  radius=${radiusMiles}mi  titles=${JSON.stringify(targetTitles)}\n`);

  const stale = new Date(Date.now() - MAX_STALE_DAYS * 86_400_000).toISOString();

  const count = async (label: string, build: (q: any) => any) => {
    const base = supabase.from("job_postings").select("id", { count: "exact", head: true });
    const { count: n, error } = await build(base);
    console.log(`  ${String(n ?? "ERR").padStart(6)}  ${label}${error ? `   ⚠️ ${error.message}` : ""}`);
    return n ?? 0;
  };

  console.log("Rows surviving each filter, added one at a time:");
  await count("all job_postings", (q: any) => q);
  await count("+ source in ATS_SOURCES", (q: any) => q.in("source", ATS_SOURCES as unknown as string[]));
  await count("+ last_seen_at >= 14d ago", (q: any) =>
    q.in("source", ATS_SOURCES as unknown as string[]).gte("last_seen_at", stale)
  );

  const targets = buildTargets(targetTitles);
  const nouns = roleNouns(targets);
  console.log(`\n  role nouns from "${targetTitles[0]}": ${JSON.stringify(nouns)}`);

  await count("+ title ilike any noun", (q: any) =>
    q
      .in("source", ATS_SOURCES as unknown as string[])
      .gte("last_seen_at", stale)
      .or(nouns.map((n) => `title.ilike.%${n}%`).join(","))
  );

  const dLat = radiusMiles / MILES_PER_DEG_LAT;
  const cos = Math.max(0.1, Math.cos(((origin?.lat ?? 52.48) * Math.PI) / 180));
  const dLng = radiusMiles / (MILES_PER_DEG_LAT * cos);
  const latLo = (origin?.lat ?? 0) - dLat;
  const latHi = (origin?.lat ?? 0) + dLat;
  const lngLo = (origin?.lng ?? 0) - dLng;
  const lngHi = (origin?.lng ?? 0) + dLng;
  const box = `and(lat.gte.${latLo},lat.lte.${latHi},lng.gte.${lngLo},lng.lte.${lngHi})`;

  await count("+ geo bounding box (no title filter)", (q: any) =>
    q.in("source", ATS_SOURCES as unknown as string[]).gte("last_seen_at", stale).or(`${box},is_remote.is.true`)
  );

  await count("+ title AND geo (both .or() calls — the live query)", (q: any) =>
    q
      .in("source", ATS_SOURCES as unknown as string[])
      .gte("last_seen_at", stale)
      .or(nouns.map((n) => `title.ilike.%${n}%`).join(","))
      .or(`${box},is_remote.is.true`)
  );

  // What ATS titles actually exist near Birmingham at all?
  console.log("\nATS jobs inside the Birmingham box (any title):");
  const { data: near } = await supabase
    .from("job_postings")
    .select("source, company, title, place_name, lat, lng")
    .in("source", ATS_SOURCES as unknown as string[])
    .gte("last_seen_at", stale)
    .gte("lat", latLo)
    .lte("lat", latHi)
    .gte("lng", lngLo)
    .lte("lng", lngHi)
    .limit(30);
  for (const r of near ?? []) {
    const rel = targets.length ? (titleRelevantAny(r.title as string, targets) ? "✓title" : "  -   ") : "";
    console.log(`  ${rel}  [${r.source}] ${r.company} — ${r.title}  (${r.place_name})`);
  }
  console.log(`  total in box: ${(near ?? []).length}`);

  // Does Aldi's ATS board have supply-chain roles at all?
  console.log("\nEvery Aldi job in the corpus (Adzuna gave us one; do WE have it?):");
  const { data: aldi } = await supabase
    .from("job_postings")
    .select("source, company, title, place_name, lat, lng, last_seen_at")
    .ilike("company", "%aldi%")
    .limit(20);
  for (const r of aldi ?? []) {
    console.log(`  [${r.source}] ${r.title} — ${r.place_name ?? "NO PLACE"} lat=${r.lat ?? "NULL"}`);
  }
  console.log(`  total: ${(aldi ?? []).length}`);

  // Finally: the real function, exactly as the pipeline calls it.
  console.log("\n=== pullFromCorpus(), as the pipeline actually calls it ===");
  const res = await pullFromCorpus({
    keywords: "Supply Chain Analyst",
    location: "B1 1AA",
    radiusMiles,
    minSalary: null,
    workingModels: [],
    limit: 100,
    origin,
    targetTitles,
    acceptRemote: true,
  } as never);
  console.log(`  jobs: ${res.jobs.length}`);
  console.log(`  bySource: ${JSON.stringify(res.bySource)}`);
  if (res.error) console.log(`  ⚠️ error: ${res.error}`);
  for (const j of res.jobs.slice(0, 10)) console.log(`    [${j.source}] ${j.company} — ${j.title}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
