/**
 * End-to-end proof of the size filter, the recruiter filter, and the
 * stale-shortlist pruning — by driving the REAL runSearch() pipeline.
 *
 * Runs three passes over ONE search, tightening the filters each time:
 *
 *   A  baseline          no size filter, recruiters shown
 *   B  hide recruiters   -> agencies must disappear AND previously-shortlisted
 *                           agency rows must be PRUNED, not left behind
 *   C  + size Large/Ent  -> only big employers survive
 *
 * B is the regression test for today's recruiter bug (agencies came back
 * `ambiguous` from Companies House and silently kept is_likely_recruiter=false,
 * so this toggle let Hays and four Michael Page divisions straight through).
 * Re-using ONE search across the three passes is deliberate: it's the only way
 * to prove the pruning, since a fresh search has nothing stale to prune.
 *
 *   npx tsx scripts/verify-search-filters.ts
 *
 * Runs against the Clerk TEST user, so it never touches Tom's own account.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function loadEnvLocal() {
  const raw = readFileSync(resolve(process.cwd(), ".env.local"), "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!process.env[k]) process.env[k] = v;
  }
}
loadEnvLocal();

// The Clerk test user created by scripts/verify-ui.ts.
const TEST_USER_ID = process.env.VERIFY_CLERK_USER_ID ?? "user_3GOvhiCIGhdEIkKSJqxkw2AUyXg";

async function main() {
  const { createServerSupabaseClient } = await import("@/lib/supabase-server");
  const { runSearch } = await import("@/lib/job-search/pipeline");
  const { DEFAULT_CRITERIA } = await import("@/lib/job-search/types");

  const supabase = createServerSupabaseClient();

  // Generic criteria — deliberately NOT Tom-specific. Supply chain is chosen
  // because it's one of the most recruiter-saturated markets in the UK, which
  // is exactly what stresses the recruiter filter.
  const baseCriteria = {
    ...DEFAULT_CRITERIA,
    keywords: "supply chain analyst",
    target_titles: ["Supply Chain Analyst", "Procurement Analyst", "Buyer", "Demand Planner", "Materials Analyst", "Sourcing Analyst"],
    location: { ...DEFAULT_CRITERIA.location, postcode: "B3 2JR", max_distance_miles: 25 },
  };

  // One search, reused across all three passes.
  const { data: search, error: insErr } = await supabase
    .from("job_searches")
    .insert({
      user_id: TEST_USER_ID,
      name: "Filter verification",
      description: null,
      criteria: baseCriteria,
      active: true,
    })
    .select("id")
    .single();
  if (insErr) throw new Error(`create search: ${insErr.message}`);
  const searchId = search.id as string;
  console.log(`search ${searchId}\n`);

  let baselineSize = 0;
  let baselineRecruiters = 0;

  const passes = [
    { label: "A  baseline (recruiters shown, no size filter)", hide_recruiters: false, sizes: [] as string[], includeUnknown: true },
    { label: "B  hide recruiters", hide_recruiters: true, sizes: [] as string[], includeUnknown: true },
    { label: "C  hide recruiters + size Large/Enterprise", hide_recruiters: true, sizes: ["large", "enterprise"], includeUnknown: false },
  ];

  for (const p of passes) {
    const criteria = {
      ...baseCriteria,
      hide_recruiters: p.hide_recruiters,
      company_size: { accepted: p.sizes, include_unknown: p.includeUnknown },
    };
    await supabase.from("job_searches").update({ criteria }).eq("id", searchId);

    const res = await runSearch({
      userId: TEST_USER_ID,
      searchId,
      name: "Filter verification",
      description: null,
      criteria: criteria as never,
      jobsPerRun: 40,
      trigger: "manual",
    });

    // What actually ended up on the shortlist?
    const { data: rows } = await supabase
      .from("job_shortlist")
      .select("posting_id, state, job_postings(company, title, enrichment_id)")
      .eq("search_id", searchId);

    const companies = (rows ?? []).map((r) => {
      const jp = r.job_postings as unknown as { company: string } | null;
      return jp?.company ?? "?";
    });

    // Cross-reference each shortlisted company against the enrichment table.
    const { data: enr } = await supabase
      .from("company_enrichment")
      .select("normalised_name, size_bucket, is_likely_recruiter");
    const { normaliseCompanyName } = await import("@/lib/enrichment/normalise-company");
    const byNorm = new Map(
      (enr ?? []).map((e) => [
        e.normalised_name as string,
        { size: e.size_bucket as string, rec: e.is_likely_recruiter as boolean },
      ])
    );

    const recruitersOnList: string[] = [];
    const sizeCounts: Record<string, number> = {};
    for (const c of companies) {
      const e = byNorm.get(normaliseCompanyName(c));
      if (e?.rec) recruitersOnList.push(c);
      const s = e?.size ?? "unenriched";
      sizeCounts[s] = (sizeCounts[s] ?? 0) + 1;
    }

    // The drop counters live on the RUN ROW, not on the return value — reading
    // them off `res` silently yields undefined and every assertion below then
    // "passes" against zeros.
    const { data: run } = await supabase
      .from("job_search_runs")
      .select("filter_drops, shortlist_count")
      .eq("id", res.runId)
      .single();
    const drops = (run?.filter_drops ?? {}) as Record<string, number>;

    const isBaseline = p.label.startsWith("A");
    if (isBaseline) {
      baselineSize = rows?.length ?? 0;
      baselineRecruiters = recruitersOnList.length;
    }

    console.log(`=== ${p.label}`);
    console.log(`    pulled=${res.pulled} deduped=${res.deduped} filtered=${res.filtered} -> shortlisted=${rows?.length ?? 0}`);
    console.log(`    drops: ${JSON.stringify(drops)}`);
    console.log(`    sizes on shortlist: ${JSON.stringify(sizeCounts)}`);
    console.log(`    recruiters on shortlist: ${recruitersOnList.length}${recruitersOnList.length ? " -> " + JSON.stringify(recruitersOnList.slice(0, 6)) : ""}`);

    // A filter that "passes" because the shortlist is EMPTY has proven nothing.
    // Guard every assertion behind a non-empty baseline.
    if (baselineSize < 5) {
      console.log(`    ⚠️  VOID — baseline shortlist was ${baselineSize} job(s). Too thin to prove anything.`);
      console.log();
      continue;
    }

    if (p.hide_recruiters) {
      if (recruitersOnList.length > 0) console.log(`    ❌ FAIL — hide_recruiters on, agencies remain.`);
      else if (baselineRecruiters === 0) console.log(`    ⚠️  VOID — baseline had no recruiters to remove.`);
      else console.log(`    ✅ ${baselineRecruiters} recruiter(s) in baseline, 0 now.`);
    }
    if (p.sizes.length) {
      const bad = Object.keys(sizeCounts).filter((s) => !p.sizes.includes(s) && s !== "unenriched");
      if (bad.length) console.log(`    ❌ FAIL — sizes outside ${JSON.stringify(p.sizes)}: ${JSON.stringify(bad)}`);
      else console.log(`    ✅ only ${p.sizes.join("/")} remain.`);
    }
    console.log();

  }

  console.log(`Cleaning up test search ${searchId} ...`);
  await supabase.from("job_shortlist").delete().eq("search_id", searchId);
  await supabase.from("job_searches").delete().eq("id", searchId);
  console.log("done.\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
