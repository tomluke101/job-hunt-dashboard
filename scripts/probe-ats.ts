/**
 * Hit every ATS provider against a REAL board and prove it returns real jobs.
 *
 *   npx tsx scripts/probe-ats.ts
 *
 * This is not a nicety. The entire failure mode this subsystem exists to prevent
 * is a source that returns 0 and looks healthy (see Adzuna + `where=postcode`,
 * and Workable, which returns `jobs: []` for every account that exists). So:
 *
 *   • ANY verified provider returning 0 jobs        → non-zero exit
 *   • ANY greenhouse jd_text containing <div or <p> → non-zero exit
 *     (the entity-escaped-HTML trap — the JD looks fine and is quietly corrupt)
 *
 * Exit non-zero means DO NOT SHIP.
 */

import type { AtsBoard, AtsProviderId } from "@/lib/ats/types";
import { PROVIDER_STATUS } from "@/lib/ats/types";
import { pullBoard } from "@/lib/ats/providers";

interface Case {
  provider: AtsProviderId;
  board: AtsBoard;
}

const CASES: Case[] = [
  { provider: "greenhouse", board: { provider: "greenhouse", token: "monzo", companyName: "Monzo" } },
  { provider: "greenhouse", board: { provider: "greenhouse", token: "gocardless", companyName: "GoCardless" } },
  { provider: "lever", board: { provider: "lever", token: "palantir", companyName: "Palantir" } },
  { provider: "ashby", board: { provider: "ashby", token: "synthesia", companyName: "Synthesia" } },
  { provider: "ashby", board: { provider: "ashby", token: "multiverse", companyName: "Multiverse" } },
  // Visa's board is real but its 2 postings have EMPTY jobAd sections upstream —
  // jd_text of ~75 chars is the employer's doing, not a bug in buildJd(). Don't
  // chase it. BoschGroup is the board that actually exercises the JD + N+1 path.
  { provider: "smartrecruiters", board: { provider: "smartrecruiters", token: "Visa", companyName: "Visa" } },
  { provider: "smartrecruiters", board: { provider: "smartrecruiters", token: "BoschGroup", companyName: "Bosch" } },
  { provider: "recruitee", board: { provider: "recruitee", token: "sendcloud", companyName: "Sendcloud" } },
  {
    provider: "workday",
    board: {
      provider: "workday",
      token: "astrazeneca",
      workday: { tenant: "astrazeneca", host: "wd3.myworkdayjobs.com", site: "Careers" },
      companyName: "AstraZeneca",
    },
  },
];

function preview(s: string, n = 100): string {
  return s.replace(/\s+/g, " ").slice(0, n);
}

async function main() {
  const failures: string[] = [];

  for (const c of CASES) {
    const label = `${c.provider}:${c.board.token}`;
    const started = Date.now();
    // Keep the budget tight so a hanging board shows up as a FAILURE here rather
    // than as a mysteriously slow ingest in production.
    const res = await pullBoard(c.board, { budgetMs: 45_000, maxJobs: 40 });
    const ms = Date.now() - started;

    const first = res.jobs[0];
    console.log(`\n=== ${label} (${ms}ms) ===`);
    console.log(`  jobs            : ${res.jobs.length}${res.truncated ? " (truncated)" : ""}`);
    console.log(`  boardCompany    : ${res.boardCompanyName ?? "-"}`);
    if (res.error) console.log(`  error           : ${res.error}`);
    if (first) {
      console.log(`  first title     : ${first.title}`);
      console.log(`  location_raw    : ${first.location_raw ?? "-"}`);
      console.log(`  candidates      : ${JSON.stringify(first.location_candidates ?? [])}`);
      console.log(`  source_id       : ${first.source_id}`);
      console.log(`  posted_at       : ${first.posted_at ?? "-"}`);
      console.log(`  employment_type : ${first.employment_type ?? "-"}`);
      console.log(`  seniority_hint  : ${first.seniority_hint ?? "-"}`);
      console.log(`  department      : ${first.department ?? "-"}`);
      console.log(`  job_function    : ${first.job_function ?? "-"}`);
      console.log(`  country/lat/lng : ${first.country_hint ?? "-"} / ${first.lat ?? "-"} / ${first.lng ?? "-"}`);
      console.log(`  salary          : ${first.salary_min ?? "-"}–${first.salary_max ?? "-"} ${first.salary_currency ?? ""}`);
      console.log(`  jd_text len     : ${first.jd_text.length}`);
      console.log(`  jd_text[0..100] : ${preview(first.jd_text)}`);
    }

    // ---- assertions -------------------------------------------------------

    if (PROVIDER_STATUS[c.provider] === "verified" && res.jobs.length === 0) {
      // Still a hard failure — a verified provider returning 0 is the one thing
      // this script exists to catch. But name the transient case, because it has a
      // completely different fix from "the adapter is broken":
      //
      // Lever's Palantir board is a 5.05MB / 273-posting payload that either serves
      // in ~2s or hangs past 60s (measured: 3 consecutive 60s timeouts, then two
      // 2.1s successes). Lever throttles repeated large pulls from one IP, so
      // re-running this script back-to-back triggers it. Raising the timeout does
      // NOT help. In production each board is polled once per cycle and the next
      // cycle picks it up; the adapter returns {jobs: [], error} rather than throwing.
      const transient = /timeout|abort|network|429/i.test(res.error ?? "");
      failures.push(
        `${label}: 0 jobs from a VERIFIED provider (${res.error ?? "no error reported"})` +
          (transient ? " [TRANSIENT upstream — re-run before you debug the adapter]" : "")
      );
    }

    // THE GREENHOUSE ESCAPING TRAP. If this fires, decodeThenHtmlToText() has been
    // "simplified" back to a plain htmlToText() call and every Greenhouse JD in the
    // corpus is now literal markup.
    if (c.provider === "greenhouse") {
      const dirty = res.jobs.filter((j) => /<div|<p[\s>]|<strong|&lt;/i.test(j.jd_text));
      if (dirty.length > 0) {
        failures.push(
          `${label}: ${dirty.length}/${res.jobs.length} jobs have RAW MARKUP in jd_text — ` +
            `escaped-HTML decode is broken. e.g. "${preview(dirty[0].jd_text, 80)}"`
        );
      }
    }

    // A job with no id would collide with every other id-less job on UNIQUE(source, source_id).
    const badIds = res.jobs.filter((j) => !j.source_id || j.source_id.endsWith(":"));
    if (badIds.length > 0) failures.push(`${label}: ${badIds.length} jobs with an empty source_id`);

    // Unprefixed ids silently overwrite another employer's jobs. Non-negotiable.
    const unprefixed = res.jobs.filter((j) => !j.source_id.includes(":"));
    if (unprefixed.length > 0) failures.push(`${label}: ${unprefixed.length} source_ids missing the board-token prefix`);

    // country_hint must be a real ISO-2. Ashby's Multiverse board says "UK", which
    // is NOT ISO-2 (GB is) — if that leaks through, every job on the board fails
    // its country check downstream. GB is the code; UK is a trap.
    const badCountry = res.jobs.filter((j) => j.country_hint && !/^[A-Z]{2}$/.test(j.country_hint));
    if (badCountry.length > 0) {
      failures.push(`${label}: bad country_hint "${badCountry[0].country_hint}" (must be ISO-2)`);
    }
    const ukNotGb = res.jobs.filter((j) => j.country_hint === "UK");
    if (ukNotGb.length > 0) {
      failures.push(`${label}: country_hint "UK" is not ISO-2 — must normalise to "GB"`);
    }

    // Workday writes UK locations as "UK - Cambridge". Show a real UK job's
    // candidates: if they ever collapse back to the raw string, geocoding fails and
    // every UK enterprise job silently disappears from the corpus.
    if (c.provider === "workday") {
      const uk = res.jobs.find((j) => j.country_hint === "GB");
      if (uk) {
        console.log(`  [UK sample]     : ${uk.location_raw} → ${JSON.stringify(uk.location_candidates)}`);
        // The raw "UK - Cambridge" is KEPT as a last-resort candidate on purpose.
        // What must never happen is it being the ONLY one — that form doesn't
        // geocode, so the job would be dropped as unresolvable.
        const cands = uk.location_candidates ?? [];
        const geocodable = cands.filter((x) => !/^[A-Za-z]{2,3}\s*[-–—]\s/.test(x));
        if (geocodable.length === 0) {
          failures.push(
            `${label}: UK location "${uk.location_raw}" produced no geocodable candidate ` +
              `(got ${JSON.stringify(cands)}) — every UK Workday job would be dropped at ingest`
          );
        }
      }
    }

    // The N+1 detail fetch is where SmartRecruiters and Workday get their JD from.
    // If it silently stops working, every job arrives title-only and the corpus
    // quietly becomes unsearchable. BoschGroup/AstraZeneca have real JDs — assert it.
    if (c.board.token === "BoschGroup" || c.provider === "workday") {
      const withJd = res.jobs.filter((j) => j.jd_text.length > 200).length;
      if (withJd === 0) {
        failures.push(`${label}: NO job has a JD — the N+1 detail fetch is broken`);
      }
    }
  }

  console.log("\n" + "=".repeat(64));
  if (failures.length > 0) {
    console.error(`FAILED (${failures.length}):`);
    for (const f of failures) console.error(`  ✗ ${f}`);
    process.exit(1);
  }
  console.log("All ATS providers returned real jobs and clean JD text.");
}

main().catch((e) => {
  console.error("probe-ats crashed:", e);
  process.exit(1);
});
