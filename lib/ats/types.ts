// ATS-direct ingest — shared contracts.
//
// WHY THIS EXISTS
// ---------------
// Reed and Adzuna are commodity aggregators: every competitor drinks from the
// same tap, they're recruiter-saturated, and Reed keyword-matches the JD BODY
// (it returns Class 2 HGV Driver ads for "supply chain analyst"). Indeed killed
// its public API and LinkedIn never had one, so the whole market is stuck there.
//
// Employers' own applicant-tracking systems expose FREE, PUBLIC, KEYLESS JSON
// endpoints. Ingesting those directly gives us, structurally:
//   • zero recruiters BY CONSTRUCTION — first-party postings only. This fixes
//     the agency problem at the root instead of playing whack-a-mole with
//     agency name patterns.
//   • fresher — live the hour the employer posts, days before aggregators.
//   • clean + structured — real title, department, employment type, seniority,
//     full JD. Several providers hand us the job-type/seniority/function fields
//     that the aggregators simply do not have.
//   • free + unmetered.
//
// THE STRUCTURAL CATCH (drives the whole design)
// ----------------------------------------------
// An ATS board endpoint returns that company's ENTIRE GLOBAL BOARD. There is no
// server-side keyword search and — critically — NO SERVER-SIDE RADIUS FILTER.
// Monzo's Greenhouse board says "Cardiff, London or Remote (UK)"; Palantir's
// Lever board says "Seoul, South Korea" and "Palo Alto, CA".
//
// Two consequences, both non-negotiable:
//   1. We must filter location OURSELVES (see lib/geo). Before ATS, the pipeline
//      had NO post-pull distance filter — it trusted each source's radius search.
//      Wire an ATS source in without geo and a Birmingham user asking for
//      "within 25 miles" gets Palo Alto.
//   2. We cannot poll boards at search time. A search can't hit 2,000 boards in
//      60s. So ATS is ingested by a BACKGROUND WORKER into a shared corpus
//      (job_postings), and search time queries that corpus locally. That is what
//      makes ATS-direct the DEFAULT supply rather than a bolt-on.
//
// PROVIDER STATUS — every endpoint below was probed live on 2026-07-12.
// Do not trust a provider you have not seen return a real job.

import type { RawJob } from "@/lib/job-search/types";

export type AtsProviderId =
  | "greenhouse"
  | "lever"
  | "ashby"
  | "smartrecruiters"
  | "recruitee"
  | "workday"
  | "workable"
  // The universal reader. Not one vendor's API — a crawler for the schema.org
  // JobPosting JSON-LD that employers embed in their public careers pages so
  // Google for Jobs can index them. The LAST rung of the discovery ladder: it
  // only ever runs when no supported ATS embed was found, because a native API
  // adapter is always better data than scraped markup. token = the careers URL.
  | "jsonld";

/**
 * Verified = probed live and seen to return real jobs.
 *
 * `workable` is UNVERIFIED and disabled by default. Its public API (both the v1
 * widget and the v3 jobs endpoint) returns `jobs: []` for every account that
 * exists — including Tide, Bolt, Typeform and Glovo, all of which are demonstrably
 * hiring. The account metadata still serves, so the endpoint looks healthy; only
 * the job array is empty. That is the Adzuna failure mode exactly (see
 * lib/job-search/postcode.ts): a source returning 0 is indistinguishable from
 * "no jobs matched" unless you assert per-source counts. The adapter is written
 * and ready, but it stays off until a board is observed returning a job —
 * `assertProviderHealth()` in ingest.ts is what will tell us.
 */
export const PROVIDER_STATUS: Record<AtsProviderId, "verified" | "unverified"> = {
  greenhouse: "verified",
  lever: "verified",
  ashby: "verified",
  smartrecruiters: "verified",
  recruitee: "verified",
  workday: "verified",
  workable: "unverified",
  // Probed live 2026-07-16: boots.jobs detail pages return complete JobPosting
  // JSON-LD (title, JD, geo coords, salary, validThrough) from a static fetch.
  jsonld: "verified",
};

export const ENABLED_PROVIDERS: AtsProviderId[] = (
  Object.keys(PROVIDER_STATUS) as AtsProviderId[]
).filter((p) => PROVIDER_STATUS[p] === "verified");

/**
 * Where a company's board lives.
 *
 * Every provider except Workday is addressed by ONE opaque token:
 *   greenhouse       boards-api.greenhouse.io/v1/boards/{token}/jobs
 *   lever            api.lever.co/v0/postings/{token}
 *   ashby            api.ashbyhq.com/posting-api/job-board/{token}
 *   smartrecruiters  api.smartrecruiters.com/v1/companies/{token}/postings
 *   recruitee        {token}.recruitee.com/api/offers/
 *   workable         apply.workable.com/api/v1/widget/accounts/{token}
 *
 * Workday needs THREE coordinates (tenant + host + site), because one tenant can
 * host several career sites:
 *   {tenant}.{host}/wday/cxs/{tenant}/{site}/jobs
 *   e.g. astrazeneca.wd3.myworkdayjobs.com/wday/cxs/astrazeneca/Careers/jobs
 * A wrong `site` returns HTTP 422 — NOT 404 — so discovery must treat 422 as
 * "right tenant, wrong site" and keep trying sites rather than giving up.
 */
export interface AtsBoard {
  provider: AtsProviderId;
  /** The single-token id. For Workday this is the tenant, for convenience. */
  token: string;
  /** Workday only. */
  workday?: {
    tenant: string;
    /** e.g. "wd3.myworkdayjobs.com" — the datacenter differs per tenant. */
    host: string;
    /** e.g. "Careers", "External" — the career-site id. */
    site: string;
  };
  /**
   * jsonld only. "playwright" = the careers site injects its job links (or the
   * JSON-LD itself) via JavaScript, so this board can only be pulled where a
   * headless browser exists — i.e. the offline ingest script, never the Vercel
   * cron. The cron SKIPS these boards rather than failing them: five phantom
   * "failures" would mark a perfectly healthy board dead.
   */
  renderMode?: "static" | "playwright";
  /** The company we BELIEVE this board belongs to. Used to verify discovery. */
  companyName?: string | null;
}

export interface AtsPullResult {
  jobs: RawJob[];
  /**
   * The company name as the BOARD reports it (Greenhouse gives `company_name`,
   * Workable gives `name`, ...). Discovery compares this against the company we
   * think we're looking at, so a token collision can't silently attach the wrong
   * employer's jobs to a company.
   */
  boardCompanyName?: string | null;
  error?: string;
  /** True when the board has more jobs than we pulled (pagination cap hit). */
  truncated?: boolean;
}

export interface AtsProbeResult {
  /** The board resolves. NOTE: a board with zero open roles still `exists`. */
  exists: boolean;
  /** 0 is a legitimate state — an employer with nothing open right now. */
  jobCount: number;
  boardCompanyName?: string | null;
  error?: string;
}

export interface AtsProvider {
  id: AtsProviderId;

  /** Pull the board's full current job list. */
  listJobs(board: AtsBoard): Promise<AtsPullResult>;

  /**
   * Does this board exist? Cheap — used by discovery to test candidate tokens.
   * Must distinguish "no such board" (exists:false) from "board with no open
   * roles" (exists:true, jobCount:0). Conflating those loses real employers.
   */
  probe(board: AtsBoard): Promise<AtsProbeResult>;

  /**
   * Parse an ATS URL scraped off a careers page → board coordinates.
   * Returns null when the URL doesn't belong to this provider.
   * e.g. "https://boards.greenhouse.io/monzo" → { provider: "greenhouse", token: "monzo" }
   */
  detect(url: string): AtsBoard | null;

  /**
   * Candidate tokens to try for a company name, best guess first.
   * Most boards are just the slugified name ("GoCardless" → "gocardless"), so a
   * direct probe resolves the majority of companies for free — no crawl, no LLM.
   */
  candidateTokens(companyName: string): string[];
}

/** Employment type, canonicalised across providers. Feeds the Job Type filter. */
export type EmploymentType =
  | "full_time"
  | "part_time"
  | "contract"
  | "temporary"
  | "internship"
  | "apprenticeship";

/** Seniority, canonicalised across providers. Feeds the Experience Level filter. */
export type SeniorityLevel =
  | "intern"
  | "entry"
  | "junior"
  | "mid"
  | "senior"
  | "lead"
  | "principal"
  | "director"
  | "executive";

/**
 * How many jobs we'll take from one board in one pass. The cap exists so one giant
 * board can't monopolise an ingest run.
 *
 * ⚠️ IT WAS 1000, AND ASTRAZENECA HAS 1,314. So we pulled exactly 1000 and threw
 * the other 314 away — and because an ATS board is the employer's ENTIRE GLOBAL
 * board in whatever order the provider feels like, the discarded tail is not
 * foreign jobs we'd have dropped anyway. It's an arbitrary slice, and AstraZeneca
 * is a UK enterprise employer: precisely the supply Workday is in this codebase to
 * unlock. The old comment here claimed "`truncated` is set when we hit it, so it's
 * visible" — every provider did set it, and ingest.ts never read it. It was
 * visible to nobody. See assertNoSilentTruncation() in ingest.ts.
 *
 * ⚠️ AND THEN 3000 WAS NOT ENOUGH EITHER. Greene King — a pub company, ~2,700 sites
 * — pulled exactly 3000 and flagged truncated. Note what kind of employer that is:
 * the cap does not bite the tech scaleups, it bites the HIGH-SITE-COUNT, NATIONWIDE
 * employers (pubs, retail chains, care homes, logistics depots), which are exactly
 * the ones whose jobs are spread across every town in Britain rather than piled up
 * in London. So the job cap was, quietly, a LONDON BIAS: it truncated the boards
 * that carry regional coverage and never touched the ones that don't.
 *
 * 6000 clears the largest board we have seen with room to spare. If a board ever
 * exceeds it the ingest says so LOUDLY rather than quietly serving 77% of it.
 */
export const MAX_JOBS_PER_BOARD = 6000;

/** Per-request timeout. ATS endpoints are usually fast; Workday can be slow. */
export const ATS_FETCH_TIMEOUT_MS = 20_000;
