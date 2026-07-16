// Audit every registered jsonld board against the CURRENT trust rules.
//
//   npx tsx scripts/audit-jsonld-boards.ts            # report
//   npx tsx scripts/audit-jsonld-boards.ts --commit   # delete refused boards
//
// WHY THIS EXISTS: the first gap sweep (2026-07-16) registered nine recruitment
// agencies as "verified" jsonld boards. An agency stamps its own name into
// hiringOrganization on every client ad, so the multi-org check passed and
// namesMatch agreed — the moat's core property (zero recruiters by construction)
// silently inverted. The provider now refuses agency boilerplate in the ad text
// (looksLikeAgencyAds) and discovery filters agency names at the source, but the
// boards those holes already wrote have to be re-judged by the new rules — and
// any future rule tightening should re-run this audit rather than trusting old
// verdicts.
//
// A refused board's postings are deleted with it (there is nothing true to keep:
// they are recruiter ads wearing a first-party badge), and a discovery-cache
// note is written so the company is not immediately re-registered.

import { config } from "dotenv";
config({ path: ".env.local" });

import { createServerSupabaseClient } from "../lib/supabase-server";
import { probeJsonLdSite } from "../lib/ats/providers/jsonld";
import { agencyGate } from "../lib/ats/discover";
import { detectRecruiter } from "../lib/enrichment/recruiter-detect";
import { normaliseCompanyName } from "../lib/enrichment/normalise-company";

const COMMIT = process.argv.includes("--commit");

/**
 * Boards filed under the WRONG company by a cross-company name collision.
 * "Freightliner" (UK rail freight, freightliner.co.uk) resolved to
 * freightliner.com — Daimler Truck North America's brand site — and registered
 * Daimler's Workday tenant under the UK company's name. Geo drops the US jobs,
 * but a mislabelled board is a lie in the registry either way.
 */
const MISFILED: Array<{ provider: string; token: string; why: string }> = [
  { provider: "workday", token: "dtna", why: "Daimler Truck NA's tenant filed under UK rail company 'Freightliner'" },
];

async function main() {
  const supabase = createServerSupabaseClient();

  const { data: enriched } = await supabase
    .from("company_enrichment")
    .select("normalised_name")
    .eq("is_likely_recruiter", true);
  const knownRecruiters = new Set((enriched ?? []).map((r) => r.normalised_name as string));

  const { data: boards, error } = await supabase
    .from("company_ats")
    .select("id, company_name, provider, board_token, render_mode, status, last_job_count");
  if (error) throw new Error(error.message);

  const refusals: Array<{ id: string; company: string; token: string; why: string }> = [];

  for (const b of boards ?? []) {
    const company = b.company_name as string;
    const provider = b.provider as string;
    const token = b.board_token as string;

    const misfiled = MISFILED.find((m) => m.provider === provider && m.token === token);
    if (misfiled) {
      refusals.push({ id: b.id as string, company, token: `${provider}/${token}`, why: misfiled.why });
      continue;
    }

    if (provider !== "jsonld") continue;

    // Cheap first: the company NAME is an agency name, or enrichment says so.
    const name = detectRecruiter(null, company);
    if (name.is_recruiter || knownRecruiters.has(normaliseCompanyName(company))) {
      refusals.push({ id: b.id as string, company, token, why: `agency by name (${name.reason ?? "enrichment flag"})` });
      continue;
    }

    // Structural: re-probe the site under the current rules. The provider-level
    // refusals (multi-org, boilerplate) come back as an error string; the
    // sampled ads then go through the full agency gate (SIC → LLM read).
    const probe = await probeJsonLdSite(token, b.render_mode === "playwright", company).catch(() => null);
    if (probe && "error" in probe && /agency|jobs board/i.test(probe.error)) {
      refusals.push({ id: b.id as string, company, token, why: probe.error.slice(0, 140) });
      continue;
    }
    if (probe && !("error" in probe)) {
      const gate = await agencyGate(company, probe.sampleJds);
      if (gate.verdict === "refuse") {
        refusals.push({ id: b.id as string, company, token, why: gate.why });
      } else if (gate.verdict === "hold" && b.status !== "unverified") {
        console.log(`  ⚠ ${company} (${token}) — LLM unsure; leaving registered but worth an eye.`);
      }
    }
  }

  console.log(`${(boards ?? []).length} boards audited — ${refusals.length} REFUSED:\n`);
  for (const r of refusals) console.log(`  ✗ ${r.company}  (${r.token})\n      ${r.why}`);

  if (!COMMIT) {
    console.log(`\nReport only. Re-run with --commit to delete these boards and their postings.`);
    return;
  }

  for (const r of refusals) {
    // Postings first (FK), then the board, then poison the discovery cache so
    // the next sweep doesn't immediately re-register the same site.
    const { error: pErr } = await supabase.from("job_postings").delete().eq("ats_board_id", r.id);
    if (pErr) throw new Error(`delete postings for ${r.company}: ${pErr.message}`);
    const { error: bErr } = await supabase.from("company_ats").delete().eq("id", r.id);
    if (bErr) throw new Error(`delete board for ${r.company}: ${bErr.message}`);
    await supabase.from("company_ats_discovery").upsert(
      {
        normalised_name: normaliseCompanyName(r.company),
        company_name: r.company,
        found: false,
        providers_tried: [],
        attempts: 1,
        last_attempt_at: new Date().toISOString(),
        // A long retry horizon: this is a REFUSAL, not a transient miss.
        retry_after: new Date(Date.now() + 365 * 86_400_000).toISOString(),
        notes: `REFUSED by audit-jsonld-boards: ${r.why.slice(0, 200)}`,
      },
      { onConflict: "normalised_name" }
    );
    console.log(`  deleted ${r.company}`);
  }
  console.log(`\n${refusals.length} boards purged.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
