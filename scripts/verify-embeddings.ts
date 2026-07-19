// Verify the semantic ranking axis end-to-end, against the REAL corpus.
//
//   npx tsx scripts/verify-embeddings.ts     # exit 0 = verified, exit 2 = NOT verified
//
// The trap this codebase keeps falling into is a check that cannot fail — a
// verifier that reports a constant, or asserts a column "present" against its own
// echo. So this does not merely confirm the vectors exist: it runs a real query
// through the real match_job_embeddings RPC and PROVES THE AXIS DISCRIMINATES —
// a posting whose title IS the query must out-score the field, and the similarity
// distribution must have spread (a constant would mean the RPC isn't comparing
// anything). If embeddings returned garbage, or the RPC compared a vector to
// itself, these checks fail.

import { config } from "dotenv";
config({ path: ".env.local" });

import { createServerSupabaseClient } from "../lib/supabase-server";
import { embeddingColumnsAvailable } from "../lib/job-search/schema-guard";
import { ensureSearchEmbedding } from "../lib/job-search/search-embedding";
import { embeddingsConfigured, SIM_FLOOR, SIM_CEIL, semanticScoreFromSimilarity } from "../lib/embeddings";
import { DEFAULT_CRITERIA, ATS_SOURCES } from "../lib/job-search/types";

let checks = 0;
let failures = 0;
function check(cond: boolean, label: string, detail = ""): void {
  checks++;
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function fail(msg: string): never {
  console.error(`\n❌ NOT VERIFIED — ${msg}`);
  process.exit(2);
}

async function main() {
  console.log("\nVerifying semantic ranking axis (embeddings)\n");
  const supabase = createServerSupabaseClient();

  check(embeddingsConfigured(), "OPENAI_API_KEY is set");
  if (!embeddingsConfigured()) fail("no OPENAI_API_KEY — cannot verify.");

  const migrated = await embeddingColumnsAvailable(supabase);
  check(migrated, "embeddings migration applied (job_postings.jd_embedding exists)");
  if (!migrated) fail("supabase-embeddings-schema.sql has not been applied.");

  // ---- Coverage ----
  const { count: total } = await supabase
    .from("job_postings")
    .select("*", { count: "exact", head: true })
    .in("source", ATS_SOURCES as unknown as string[]);
  const { count: embedded } = await supabase
    .from("job_postings")
    .select("*", { count: "exact", head: true })
    .in("source", ATS_SOURCES as unknown as string[])
    .not("jd_embedding", "is", null);

  const cov = total ? Math.round(((embedded ?? 0) / total) * 100) : 0;
  console.log(`\n  corpus coverage: ${embedded ?? 0}/${total ?? 0} ATS postings embedded (${cov}%)`);
  check((embedded ?? 0) >= 50, "at least 50 corpus JDs embedded", `only ${embedded ?? 0} — run scripts/backfill-embeddings.ts --commit`);
  if ((embedded ?? 0) < 50) fail("not enough embedded JDs to test the axis.");
  if (cov < 90) console.log(`  ⚠️  coverage below 90% — run the backfill again to finish (${100 - cov}% remaining).`);

  // ---- Sample embedded postings ----
  const { data: sample, error: sErr } = await supabase
    .from("job_postings")
    .select("id, title")
    .in("source", ATS_SOURCES as unknown as string[])
    .not("jd_embedding", "is", null)
    .limit(300);
  if (sErr || !sample?.length) fail(`could not sample embedded postings: ${sErr?.message ?? "empty"}`);
  const rows = sample as Array<{ id: string; title: string }>;
  const sampleIds = rows.map((r) => r.id);

  // Target = the row with the most distinctive (longest, multi-word) title. Its own
  // title, used as the query, should match its own JD more strongly than the field.
  const target = [...rows].sort((a, b) => (b.title?.split(/\s+/).length ?? 0) - (a.title?.split(/\s+/).length ?? 0))[0];
  console.log(`  probe query = a real posting title: "${target.title}"`);

  // ---- Insert a throwaway search, embed its query, run the RPC, then clean up ----
  const probeUser = "verify-embeddings-probe";
  const { data: ins, error: insErr } = await supabase
    .from("job_searches")
    .insert({
      user_id: probeUser,
      name: "verify-embeddings (throwaway)",
      description: target.title,
      criteria: DEFAULT_CRITERIA,
    })
    .select("id")
    .single();
  if (insErr || !ins) fail(`could not create probe search: ${insErr?.message}`);
  const searchId = ins.id as string;

  try {
    const ensured = await ensureSearchEmbedding(supabase, {
      searchId,
      criteria: DEFAULT_CRITERIA,
      description: target.title,
    });
    check(ensured.present, "query embedding written to the probe search", ensured.error ?? "");
    if (!ensured.present) fail("could not embed the probe query.");

    const { data: sims, error: rpcErr } = await supabase.rpc("match_job_embeddings", {
      p_search_id: searchId,
      p_posting_ids: sampleIds,
    });
    check(!rpcErr, "match_job_embeddings RPC ran", rpcErr?.message ?? "");
    const scored = (sims ?? []) as Array<{ posting_id: string; similarity: number }>;
    check(scored.length >= sampleIds.length * 0.9, "RPC scored ~all sampled postings", `${scored.length}/${sampleIds.length}`);

    const byId = new Map(scored.map((s) => [s.posting_id, s.similarity]));
    const values = scored.map((s) => s.similarity).sort((a, b) => a - b);
    const min = values[0];
    const max = values[values.length - 1];
    const median = values[Math.floor(values.length / 2)];
    console.log(`\n  similarity distribution: min ${min.toFixed(4)}  median ${median.toFixed(4)}  max ${max.toFixed(4)}`);
    console.log(`  score-map bounds: SIM_FLOOR ${SIM_FLOOR} → 0,  SIM_CEIL ${SIM_CEIL} → 100`);
    console.log(`  → best match scores ${semanticScoreFromSimilarity(max)}/100, median ${semanticScoreFromSimilarity(median)}/100`);

    // (1) Spread — a constant would mean the RPC compared nothing (or every vector
    //     to itself). This is the "a verifier that reports a constant isn't
    //     verifying anything" guard.
    check(max - min > 0.05, "similarity has real spread (axis is comparing, not echoing)", `spread ${(max - min).toFixed(4)}`);

    // (2) Discrimination — the posting whose title IS the query must rank in the top
    //     decile. If embeddings were random, it would sit around the median.
    const targetSim = byId.get(target.id);
    const rankFromTop = targetSim != null ? values.filter((v) => v > targetSim).length : Infinity;
    const pct = targetSim != null ? Math.round((rankFromTop / values.length) * 100) : 100;
    check(targetSim != null && pct <= 10, "query's own posting ranks in the top 10%", `it ranked in the top ${pct}% (sim ${targetSim?.toFixed(4)})`);

    // (3) And strictly above the median — a weaker restatement of the same, kept
    //     because it fails even if the top decile happened to be crowded.
    check(targetSim != null && targetSim > median, "query's own posting beats the median match", `sim ${targetSim?.toFixed(4)} vs median ${median.toFixed(4)}`);

    // Advisory calibration hints (never failures — the axis works regardless).
    if (max < SIM_CEIL) console.log(`  ℹ️  max similarity ${max.toFixed(4)} < SIM_CEIL ${SIM_CEIL}: nothing hits 100/100. Consider lowering SIM_CEIL.`);
    if (min > SIM_FLOOR) console.log(`  ℹ️  min similarity ${min.toFixed(4)} > SIM_FLOOR ${SIM_FLOOR}: nothing hits 0/100. Consider raising SIM_FLOOR.`);
  } finally {
    await supabase.from("job_searches").delete().eq("id", searchId);
  }

  console.log("\n" + "=".repeat(70));
  if (failures) {
    console.error(`❌ NOT VERIFIED — ${failures} of ${checks} checks failed.`);
    process.exit(2);
  }
  console.log(`✅ Semantic ranking verified — ${checks} checks passed, against real corpus embeddings.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
