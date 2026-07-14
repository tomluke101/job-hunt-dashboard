// WHICH ATS ARE THE EMPLOYERS WE CAN'T READ ACTUALLY ON?
//
//   npx tsx scripts/diagnose-ats-gap.ts [--limit N]
//
// Discovery reports two very different kinds of miss, and the distinction is the
// whole point of this script:
//
//   "could not resolve a website"   -> we never found the employer. Our problem.
//   "no ATS embed found on X"       -> WE REACHED THEIR CAREERS PAGE AND DID NOT
//                                      RECOGNISE WHAT WE SAW.
//
// The second kind is not an absent board. It is a board written in a language we
// do not speak. Every one of those is a real employer, with real vacancies, on a
// real applicant tracking system — and it is invisible to HuntHQ purely because
// that ATS has no adapter in lib/ats/providers.
//
// We support the six ATSs a London tech scaleup uses (Greenhouse, Lever, Ashby,
// SmartRecruiters, Recruitee, Workday). A Midlands food manufacturer or an NHS
// trust does not use any of them. So "expand the seed list" can only ever reach
// the employers who happen to be on OUR six — and if the UK's regional employers
// are systematically on a DIFFERENT six, no amount of seeding fixes coverage, and
// we would keep adding names and keep wondering why Birmingham stays empty.
//
// This script settles that with evidence rather than a hunch: crawl the careers
// pages we already failed on, and count which ATS vendors' fingerprints appear.
// The output is a ranked build order for the next adapter.
//
// Costs nothing: public pages, no keys, no LLM.

import { config } from "dotenv";
config({ path: ".env.local" });

import { createServerSupabaseClient } from "../lib/supabase-server";

const argv = process.argv.slice(2);
const LIMIT = parseInt(argv[argv.indexOf("--limit") + 1] ?? "0", 10) || 0;
const CONCURRENCY = 12;

/**
 * Fingerprints for the ATSs we do NOT support. Matched against raw page HTML, so
 * each is a host or URL fragment the vendor's own embed/apply-link must contain —
 * not a brand name, which would match a "we use X" blog post.
 */
const ATS_SIGNATURES: Array<{ vendor: string; re: RegExp }> = [
  // Already supported — counted so the report can prove the crawl works at all.
  { vendor: "greenhouse (SUPPORTED)", re: /(?:job-)?boards\.greenhouse\.io|greenhouse\.io\/embed/i },
  { vendor: "lever (SUPPORTED)", re: /jobs\.lever\.co/i },
  { vendor: "ashby (SUPPORTED)", re: /jobs\.ashbyhq\.com/i },
  { vendor: "smartrecruiters (SUPPORTED)", re: /(?:careers|jobs)\.smartrecruiters\.com/i },
  { vendor: "workday (SUPPORTED)", re: /myworkdayjobs\.com/i },
  { vendor: "recruitee (SUPPORTED)", re: /[a-z0-9-]+\.recruitee\.com/i },

  // The UK enterprise / mid-market set — none of these have an adapter.
  { vendor: "SAP SuccessFactors", re: /successfactors\.(?:com|eu)|career\d?\.successfactors|jobs\.sap\.com/i },
  { vendor: "Oracle Taleo", re: /taleo\.net/i },
  { vendor: "Oracle Recruiting Cloud", re: /oraclecloud\.com\/hcmUI\/CandidateExperience|\/hcmUI\/CandidateExperience/i },
  { vendor: "iCIMS", re: /[a-z0-9-]+\.icims\.com/i },
  { vendor: "Cornerstone OnDemand", re: /\.csod\.com/i },
  { vendor: "Avature", re: /\.avature\.net/i },
  { vendor: "Phenom People", re: /phenompeople\.com|\.phenom\.com/i },
  { vendor: "Radancy", re: /radancy\.(?:com|net)|talentbrew/i },
  { vendor: "Workable", re: /apply\.workable\.com/i },
  { vendor: "Teamtailor", re: /[a-z0-9-]+\.teamtailor\.com/i },
  { vendor: "Personio", re: /jobs\.personio\.(?:de|com)|[a-z0-9-]+\.jobs\.personio/i },
  { vendor: "Pinpoint", re: /pinpointhq\.com/i },
  { vendor: "BambooHR", re: /[a-z0-9-]+\.bamboohr\.(?:com|co\.uk)/i },
  { vendor: "JazzHR", re: /applytojob\.com/i },
  { vendor: "UKG / UltiPro", re: /ultipro\.com|\.ukg\.(?:com|net)/i },
  { vendor: "ADP Workforce Now", re: /workforcenow\.adp\.com|recruiting\.adp\.com/i },

  // The UK-specific ATSs. These are the ones a London-shaped provider list is most
  // likely to have missed entirely — they barely exist outside Britain.
  { vendor: "Eploy (UK)", re: /\.eploy\.net|eploy\.co\.uk/i },
  { vendor: "Tribepad (UK)", re: /tribepad\.com|\.tribepad\b/i },
  { vendor: "Jobtrain (UK)", re: /jobtrain\.co\.uk/i },
  { vendor: "Hireserve (UK)", re: /hireserve\.com|\.hireserve\b/i },
  { vendor: "networx (UK)", re: /networxrecruitment\.com|\.networx\b/i },
  { vendor: "Hireful (UK)", re: /hireful\.co\.uk/i },
  { vendor: "Vacancy Filler (UK)", re: /vacancy-filler\.co\.uk|vacancyfiller/i },
  { vendor: "Applied (UK)", re: /beapplied\.com/i },
  { vendor: "NHS Jobs / TRAC (UK public)", re: /jobs\.nhs\.uk|trac\.jobs|healthjobsuk\.com/i },
  { vendor: "Civil Service Jobs (UK public)", re: /civilservicejobs\.service\.gov\.uk/i },
];

const CAREERS_PATHS = [
  "/careers", "/jobs", "/careers/jobs", "/about/careers", "/company/careers",
  "/en/careers", "/work-with-us", "/join-us", "/vacancies", "/careers/open-roles",
];

async function fetchHtml(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(12_000),
      redirect: "follow",
      headers: {
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36",
        accept: "text/html,application/xhtml+xml",
      },
    });
    if (!res.ok) return null;
    if (!(res.headers.get("content-type") ?? "").includes("html")) return null;
    return await res.text();
  } catch {
    return null;
  }
}

async function main() {
  const supabase = createServerSupabaseClient();

  // The companies where we REACHED a careers page and failed to read it. The notes
  // column records the domains discovery actually crawled, so we re-use them rather
  // than re-deriving (and re-mis-deriving) the domain.
  const rows: Array<{ company_name: string; notes: string }> = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from("company_ats_discovery")
      .select("company_name, notes, found")
      .eq("found", false)
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    const batch = data ?? [];
    for (const r of batch) {
      const notes = (r.notes as string) ?? "";
      if (notes.startsWith("no ATS embed found on")) {
        rows.push({ company_name: r.company_name as string, notes });
      }
    }
    if (batch.length < 1000) break;
  }

  const targets = LIMIT ? rows.slice(0, LIMIT) : rows;
  console.log(
    `${rows.length} employers whose careers page we REACHED but could not parse.\n` +
      `Crawling ${targets.length} of them to see which ATS they are actually on.\n`
  );

  const hits = new Map<string, string[]>(); // vendor -> companies
  let pagesRead = 0;
  let noPage = 0;
  const unknown: string[] = [];

  let cursor = 0;
  async function worker() {
    for (;;) {
      const i = cursor++;
      if (i >= targets.length) return;
      const { company_name, notes } = targets[i];

      const domains = (notes.replace("no ATS embed found on", "").trim().split(/,\s*/) ?? [])
        .map((d) => d.trim())
        .filter(Boolean);

      const found = new Set<string>();
      let readAny = false;

      outer: for (const domain of domains) {
        const base = domain.startsWith("http") ? domain : `https://${domain}`;
        for (const p of CAREERS_PATHS) {
          const html = await fetchHtml(base + p);
          if (!html) continue;
          readAny = true;
          for (const { vendor, re } of ATS_SIGNATURES) {
            if (re.test(html)) found.add(vendor);
          }
          if (found.size) break outer; // one page naming a vendor is enough
        }
      }

      if (!readAny) {
        noPage++;
      } else {
        pagesRead++;
        if (found.size === 0) unknown.push(company_name);
        for (const v of found) {
          if (!hits.has(v)) hits.set(v, []);
          hits.get(v)!.push(company_name);
        }
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  console.log(`${"=".repeat(70)}`);
  console.log(`careers pages read: ${pagesRead}   unreachable now: ${noPage}\n`);
  console.log(`ATS VENDORS FOUND — ranked. This IS the adapter build order.\n`);

  const ranked = [...hits.entries()].sort((a, b) => b[1].length - a[1].length);
  for (const [vendor, companies] of ranked) {
    console.log(`  ${String(companies.length).padStart(3)}  ${vendor}`);
    console.log(`       ${companies.slice(0, 8).join(", ")}${companies.length > 8 ? ", ..." : ""}`);
  }

  console.log(
    `\n  ${String(unknown.length).padStart(3)}  (no recognised ATS fingerprint at all)\n` +
      `       ${unknown.slice(0, 12).join(", ")}${unknown.length > 12 ? ", ..." : ""}`
  );

  const unsupported = ranked
    .filter(([v]) => !v.includes("SUPPORTED"))
    .reduce((n, [, c]) => n + c.length, 0);
  console.log(
    `\n${"=".repeat(70)}\n` +
      `${unsupported} employers sit on an ATS WE DO NOT SUPPORT.\n` +
      `Each one is real vacancies, invisible to HuntHQ for want of an adapter — not\n` +
      `for want of a seed name. If this number is large, the coverage bottleneck is\n` +
      `the PROVIDER LIST, and seeding more companies cannot fix it.`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
