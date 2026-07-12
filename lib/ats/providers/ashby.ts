// Ashby. Keyless, public.
//   GET https://api.ashbyhq.com/posting-api/job-board/{token}?includeCompensation=true
//
// The best-structured board of the seven: it ships a real employment type, a
// postal address (country + locality), an explicit isRemote flag, secondary
// locations as an ARRAY rather than free text, and — uniquely — structured
// compensation. Fast-growing UK startups run it (Synthesia, Multiverse, Cleo).

import type { AtsBoard, AtsProbeResult, AtsPullResult } from "../types";
import type { RawJob } from "@/lib/job-search/types";
import {
  type AtsProviderImpl,
  type AtsPullOptions,
  canonEmploymentType,
  decodeThenHtmlToText,
  errMsg,
  httpJson,
  jobCap,
  mergeCandidates,
  pathSegments,
  safeIso,
  slugCandidates,
  sourceId,
  toIso2,
} from "./_util";

interface AshbyCompensationComponent {
  compensationType?: string; // "Salary" | "EquityPercentage" | "Bonus" | ...
  interval?: string;
  currencyCode?: string;
  minValue?: number;
  maxValue?: number;
}

interface AshbyJob {
  id?: string;
  title?: string;
  department?: string;
  team?: string;
  employmentType?: string; // "FullTime" | "PartTime" | "Contract" | "Intern" | "Temporary"
  location?: string;
  secondaryLocations?: { location?: string }[];
  publishedAt?: string;
  isListed?: boolean;
  isRemote?: boolean;
  workplaceType?: string;
  address?: {
    postalAddress?: {
      addressCountry?: string;
      addressLocality?: string;
      addressRegion?: string;
    };
  };
  jobUrl?: string;
  applyUrl?: string;
  descriptionHtml?: string;
  descriptionPlain?: string;
  compensation?: {
    compensationTiers?: { components?: AshbyCompensationComponent[] }[];
  };
}

interface AshbyResponse {
  jobs?: AshbyJob[];
  name?: string;
}

function boardUrl(token: string): string {
  return `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(token)}?includeCompensation=true`;
}

/**
 * Ashby is the only provider handing us a structured salary — but the pipeline
 * ranks salary in GBP and does NOT convert. A $180k US range read as "180000 GBP"
 * would outrank every real UK role in the corpus, permanently, at the top of the
 * list. So: GBP only. Anything else is dropped as if the employer said nothing,
 * which is exactly what it said as far as a GBP ranker is concerned.
 *
 * The compensation shape is the least stable part of the API (tiers, components,
 * summary-only boards, equity-only components), so every access is defensive.
 */
function gbpSalary(job: AshbyJob): { min: number | null; max: number | null; currency: string | null } {
  const none = { min: null, max: null, currency: null };
  try {
    const tiers = job.compensation?.compensationTiers;
    if (!Array.isArray(tiers)) return none;

    let min: number | null = null;
    let max: number | null = null;

    for (const tier of tiers) {
      for (const c of tier?.components ?? []) {
        if (c?.compensationType !== "Salary") continue; // skip equity / bonus / commission
        if ((c.currencyCode ?? "").toUpperCase() !== "GBP") continue;
        const lo = typeof c.minValue === "number" ? c.minValue : null;
        const hi = typeof c.maxValue === "number" ? c.maxValue : null;
        if (lo !== null && lo > 0) min = min === null ? lo : Math.min(min, lo);
        if (hi !== null && hi > 0) max = max === null ? hi : Math.max(max, hi);
      }
    }
    if (min === null && max === null) return none;
    return { min, max, currency: "GBP" };
  } catch {
    return none;
  }
}

function toRawJob(board: AtsBoard, job: AshbyJob, boardName: string | null): RawJob {
  const postal = job.address?.postalAddress;
  const secondary = (job.secondaryLocations ?? []).map((s) => s?.location ?? null);
  const salary = gbpSalary(job);

  return {
    source: "ashby",
    source_id: sourceId(board.token, job.id ?? ""),
    source_url: job.jobUrl ?? job.applyUrl ?? null,
    company: boardName ?? board.companyName ?? "",
    title: job.title ?? "",
    location_raw: job.location ?? null,
    jd_text: decodeThenHtmlToText(job.descriptionHtml) || (job.descriptionPlain ?? "").trim(),
    jd_html: job.descriptionHtml ?? null,
    posted_at: safeIso(job.publishedAt),
    expires_at: null,
    salary_min: salary.min,
    salary_max: salary.max,
    salary_currency: salary.currency,
    department: job.department ?? job.team ?? null,
    employment_type: canonEmploymentType(job.employmentType),
    seniority_hint: null, // Ashby states none.
    job_function: job.team ?? null,
    is_remote: typeof job.isRemote === "boolean" ? job.isRemote : null,
    // A posting can be open in several offices. `addressLocality` is the strongest
    // candidate (it's the geocoder-friendly one), then the free-text primary, then
    // every secondary — so a London user and a Manchester user both match a role
    // that's genuinely open in both.
    location_candidates: mergeCandidates(
      [postal?.addressLocality],
      [job.location],
      secondary
    ),
    country_hint: toIso2(postal?.addressCountry),
    lat: null,
    lng: null,
    raw: job,
  };
}

export const ashbyProvider: AtsProviderImpl = {
  id: "ashby",

  async listJobs(board: AtsBoard, opts?: AtsPullOptions): Promise<AtsPullResult> {
    try {
      const res = await httpJson<AshbyResponse>(boardUrl(board.token));
      if (!res.ok || !res.data) {
        return { jobs: [], error: `ashby ${board.token}: ${res.error ?? "unknown error"}` };
      }
      const all = Array.isArray(res.data.jobs) ? res.data.jobs : [];
      // isListed:false = the employer has UNPUBLISHED the role but kept it on the
      // API (confidential reqs, filled roles). Ingesting them shows users jobs
      // that are not open and cannot be applied to.
      const listed = all.filter((j) => j?.isListed !== false);
      const cap = jobCap(opts);
      const taken = listed.slice(0, cap);
      const boardName = res.data.name ?? board.companyName ?? null;
      return {
        jobs: taken.map((j) => toRawJob(board, j, boardName)),
        boardCompanyName: boardName,
        truncated: listed.length > cap,
      };
    } catch (e) {
      return { jobs: [], error: `ashby ${board.token}: ${errMsg(e)}` };
    }
  },

  async probe(board: AtsBoard): Promise<AtsProbeResult> {
    try {
      const res = await httpJson<AshbyResponse>(
        `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(board.token)}`
      );
      if (res.status === 404) return { exists: false, jobCount: 0 };
      if (!res.ok || !res.data) {
        return { exists: false, jobCount: 0, error: res.error ?? "unknown error" };
      }
      const listed = (res.data.jobs ?? []).filter((j) => j?.isListed !== false);
      return {
        exists: true,
        jobCount: listed.length,
        boardCompanyName: res.data.name ?? null,
      };
    } catch (e) {
      return { exists: false, jobCount: 0, error: errMsg(e) };
    }
  },

  detect(url: string): AtsBoard | null {
    const p = pathSegments(url);
    if (!p) return null;
    const { host, segs } = p;

    // api.ashbyhq.com/posting-api/job-board/{token}
    if (host.endsWith("ashbyhq.com") && segs[0] === "posting-api" && segs[2]) {
      return { provider: "ashby", token: segs[2] };
    }
    // jobs.ashbyhq.com/{token}[/{jobId}]
    if (host.endsWith("ashbyhq.com") && segs[0]) {
      return { provider: "ashby", token: segs[0] };
    }
    return null;
  },

  candidateTokens(companyName: string): string[] {
    return slugCandidates(companyName);
  },
};
