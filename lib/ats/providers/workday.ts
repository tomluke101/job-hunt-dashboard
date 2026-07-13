// Workday — the UK ENTERPRISE unlock (AstraZeneca, Tesco, Sainsbury's, Rolls-Royce,
// Aviva...). None of those employers appear on Greenhouse/Lever/Ashby, and they are
// exactly the large UK employers a non-tech user is applying to. Worth every bit of
// the extra complexity below.
//
//   list   POST https://{tenant}.{host}/wday/cxs/{tenant}/{site}/jobs
//          body {"appliedFacets":{},"limit":20,"offset":N,"searchText":""}
//   detail GET  https://{tenant}.{host}/wday/cxs/{tenant}/{site}{externalPath}
//
// THREE traps, all of which produce a plausible-looking wrong answer:
//
//  1. POST, not GET. A GET to /jobs returns the SPA's HTML shell with a 200.
//  2. `limit` caps at 20 server-side. Ask for 100 and you get 20 — so a naive
//     "one page is enough" read silently truncates a 900-job board to 20.
//  3. The error codes are INVERTED from what you'd expect: 404 = wrong SITE,
//     422 = wrong HOST. Both mean "keep looking", and they tell you WHICH of the
//     three coordinates to change. See WORKDAY_WRONG_SITE below — this is the
//     difference between finding Tesco's board and concluding it doesn't exist.
//
// Plus: the LIST's `postedOn` is a relative string ("Posted 30+ Days Ago"), which
// is useless as a date. The DETAIL's `startDate` is a real one. That is the main
// reason the N+1 detail fetch is not optional here.

import type { AtsBoard, AtsProbeResult, AtsPullResult } from "../types";
import type { RawJob } from "@/lib/job-search/types";
import {
  type AtsProviderImpl,
  type AtsPullOptions,
  DETAIL_CONCURRENCY,
  budgetDeadline,
  canonEmploymentType,
  decodeThenHtmlToText,
  errMsg,
  httpJson,
  jobCap,
  mapWithConcurrency,
  mergeCandidates,
  safeIso,
  slugCandidates,
  sourceId,
  toIso2,
} from "./_util";

/** Workday caps `limit` at 20 server-side. Asking for more just gets you 20. */
const PAGE_SIZE = 20;

/**
 * ⚠️ WORKDAY'S STATUS CODES ARE THE OPPOSITE OF WHAT EVERYONE ASSUMES.
 *
 * Verified live 2026-07-12 against astrazeneca / tesco / sainsburys:
 *
 *   HTTP 404  {"errorCode":"S21", "message":"not found: Job_Post..."}
 *             → the TENANT + HOST are RIGHT and the SITE id is wrong.
 *               astrazeneca.wd3 + site "External"  → 404
 *
 *   HTTP 422  {"errorCode":"HTTP_422"}
 *             → the TENANT is not on THIS HOST (wrong wdN datacenter, or the
 *               tenant doesn't exist at all).
 *               astrazeneca.wd1 / .wd5 / .wd103    → 422   (it lives on wd3)
 *               astrazeneca.wd3 + site "Careers"   → 200   (1,314 jobs)
 *
 * Get this backwards — treat 422 as "wrong site" and walk the site list — and you
 * burn 9 requests per bogus tenant while NEVER finding the board, and you give up
 * on the 404s, which are precisely the employers you HAVE found and only need one
 * more site guess for. The correct search order is therefore HOST first, SITE
 * second: keep changing host while you see 422, keep changing site while you see 404.
 */
export const WORKDAY_WRONG_SITE = "WORKDAY_WRONG_SITE";
export const WORKDAY_WRONG_HOST = "WORKDAY_WRONG_HOST";

/**
 * The wdN datacenter varies per tenant and is NOT guessable from the name — you
 * have to probe. Ordered by how often they hit. (wd2/wd101 don't resolve in DNS at
 * all; a network error just skips the host.)
 */
export const DEFAULT_WORKDAY_HOSTS = [
  "wd3.myworkdayjobs.com",
  "wd1.myworkdayjobs.com",
  "wd5.myworkdayjobs.com",
  "wd103.myworkdayjobs.com",
  "wd10.myworkdayjobs.com",
  "wd12.myworkdayjobs.com",
];

/**
 * Career-site ids seen in the wild, most common first. Workday lets a tenant name
 * its site freely, but the overwhelming majority use one of these.
 */
export const DEFAULT_WORKDAY_SITES = [
  "Careers",
  "External",
  "careers",
  "External_Career_Site",
  "en-US",
  "Search",
  "Global",
  "ExternalCareerSite",
  "CareerSite",
];

interface WdListPosting {
  title?: string;
  externalPath?: string; // "/job/London/Analyst_R-123"
  timeType?: string; // "Full time"
  locationsText?: string; // "London" | "2 Locations"
  postedOn?: string; // RELATIVE — "Posted Today". Not a date.
  bulletFields?: string[];
}

interface WdListResponse {
  total?: number;
  jobPostings?: WdListPosting[];
}

interface WdDetailResponse {
  jobPostingInfo?: {
    id?: string;
    title?: string;
    jobDescription?: string; // HTML
    location?: string;
    additionalLocations?: string[];
    postedOn?: string;
    startDate?: string; // "2026-07-12" — the REAL posting date
    endDate?: string;
    timeType?: string;
    jobReqId?: string;
    country?: { descriptor?: string }; // "United States of America"
    externalUrl?: string;
    remoteType?: string;
  };
}

/**
 * Workday writes locations as "{COUNTRY} - {CITY}[ - {STATE}]", with either a
 * hyphen or an EN-DASH. Verified on AstraZeneca's board 2026-07-12:
 *   "UK - Cambridge"  "UK - Luton"  "UK - Macclesfield"
 *   "US - Gaithersburg - MD"   "US – Tarzana – CA"   "2 Locations"
 *
 * Handing "UK - Cambridge" to a geocoder as-is fails — and types.ts is explicit
 * that an ATS location we cannot resolve gets DROPPED. So the naive mapping would
 * silently bin AstraZeneca's entire UK req list: Cambridge, Luton, Macclesfield.
 * That is the exact enterprise supply Workday is in this codebase to unlock, and
 * it would have vanished with no error anywhere.
 *
 * Emitting the bare city isn't enough either: "Cambridge" is ambiguous with
 * Cambridge, Massachusetts, and a UK user searching a 25-mile radius would either
 * miss the job or match a job 3,000 miles away. So we emit the QUALIFIED form
 * ("Cambridge, UK") first and the bare city as a fallback.
 */
function workdayLocations(raw: string | null): { candidates: string[]; countryToken: string | null } {
  if (!raw || !raw.trim()) return { candidates: [], countryToken: null };
  const s = raw.trim();

  // "2 Locations" / "5 Locations" is Workday's UI placeholder for a multi-site
  // req — it is not a place and would geocode to nothing (or worse, to garbage).
  if (/^\d+\s+locations?$/i.test(s)) return { candidates: [], countryToken: null };

  const segs = s.split(/\s*[-–—]\s*/).map((x) => x.trim()).filter(Boolean);
  if (segs.length === 0) return { candidates: [], countryToken: null };

  // A leading segment that resolves to a country ("UK", "US", "China") is a
  // prefix, not a place. Anything else means the string isn't in the country-first
  // shape, so leave it alone rather than guessing.
  const leadIsCountry = segs.length >= 2 && toIso2(segs[0]) !== null;
  const countryToken = leadIsCountry ? segs[0] : null;
  const rest = leadIsCountry ? segs.slice(1) : segs;
  if (rest.length === 0) return { candidates: [s], countryToken };

  const qualified = [...rest, countryToken].filter(Boolean).join(", ");
  // Qualified first (most geocodable), bare city second, raw last as a safety net.
  return { candidates: [qualified, rest[0], s], countryToken };
}

function coords(board: AtsBoard): { tenant: string; host: string; site: string } | null {
  const w = board.workday;
  if (!w?.tenant || !w?.host || !w?.site) return null;
  // Host/tenant land in a URL's AUTHORITY. Validate rather than encode — encoding
  // does not neutralise a "." or a "/" in a hostname position.
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(w.tenant)) return null;
  if (!/^[a-z0-9.-]+\.myworkdayjobs\.com$/i.test(w.host) && !/^[a-z0-9.-]+\.myworkdaysite\.com$/i.test(w.host)) {
    return null;
  }
  if (!/^[A-Za-z0-9._-]+$/.test(w.site)) return null;
  return { tenant: w.tenant, host: w.host.toLowerCase(), site: w.site };
}

function cxsBase(tenant: string, host: string, site: string): string {
  return `https://${tenant}.${host}/wday/cxs/${tenant}/${site}`;
}

async function fetchPage(
  tenant: string,
  host: string,
  site: string,
  offset: number,
  limit: number
) {
  return httpJson<WdListResponse>(`${cxsBase(tenant, host, site)}/jobs`, {
    method: "POST",
    // The empty facets/searchText object is required — Workday 400s on an empty body.
    body: JSON.stringify({ appliedFacets: {}, limit, offset, searchText: "" }),
    headers: { "content-type": "application/json", accept: "application/json" },
  });
}

function toRawJob(
  board: AtsBoard,
  tenant: string,
  host: string,
  site: string,
  p: WdListPosting,
  detail: WdDetailResponse["jobPostingInfo"] | null
): RawJob {
  const path = p.externalPath ?? "";
  // The externalPath is the only stable per-job key in the list payload. jobReqId
  // (from the detail) is prettier but absent when the budget skipped the detail —
  // and a source_id that changes depending on whether we had time to fetch the JD
  // would re-insert every job as new on the next run.
  const id = path || detail?.id || detail?.jobReqId || p.title || "";

  const locationRaw = detail?.location ?? p.locationsText ?? null;
  const extraLocations = detail?.additionalLocations ?? [];
  const primary = workdayLocations(locationRaw);

  return {
    source: "workday",
    source_id: sourceId(tenant, id),
    source_url: detail?.externalUrl ?? (path ? `https://${tenant}.${host}/${site}${path}` : null),
    company: board.companyName ?? tenant,
    title: detail?.title ?? p.title ?? "",
    location_raw: locationRaw,
    jd_text: decodeThenHtmlToText(detail?.jobDescription),
    jd_html: detail?.jobDescription ?? null,
    // NEVER use the list's `postedOn` — it is "Posted 30+ Days Ago", which
    // new Date() turns into Invalid Date (or, worse, something plausible).
    // `startDate` from the detail is the real one.
    posted_at: safeIso(detail?.startDate),
    expires_at: safeIso(detail?.endDate),
    salary_min: null,
    salary_max: null,
    salary_currency: null,
    department: null, // Workday's cxs payload exposes none.
    employment_type: canonEmploymentType(detail?.timeType ?? p.timeType),
    seniority_hint: null,
    job_function: null,
    is_remote: detail?.remoteType ? /remote/i.test(detail.remoteType) : null,
    // See workdayLocations(): unpacks "UK - Cambridge" → ["Cambridge, UK", "Cambridge"]
    // and drops the "2 Locations" placeholder. Without it every UK Workday job
    // fails to geocode and gets dropped at ingest.
    location_candidates: mergeCandidates(primary.candidates, extraLocations),
    // The detail's country is authoritative. When the budget skipped the detail,
    // fall back to the location string's country prefix ("UK - Cambridge" → GB) so
    // a title-only job still knows which country it's in.
    country_hint: toIso2(detail?.country?.descriptor) ?? toIso2(primary.countryToken),
    lat: null,
    lng: null,
    raw: { list: p, detail },
  };
}

export const workdayProvider: AtsProviderImpl = {
  id: "workday",

  async listJobs(board: AtsBoard, opts?: AtsPullOptions): Promise<AtsPullResult> {
    try {
      const c = coords(board);
      if (!c) return { jobs: [], error: `workday: board is missing valid {tenant,host,site}` };
      const { tenant, host, site } = c;

      const deadlineAt = budgetDeadline(opts);
      const cap = jobCap(opts);

      const postings: WdListPosting[] = [];
      let total = Infinity;
      let offset = 0;
      let listTruncated = false;
      // Did the board simply RUN OUT of jobs? That is a complete pull, not a cut-off
      // one — and the two are easy to confuse. See the `truncated` note below.
      let ranDry = false;

      while (postings.length < cap && offset < total) {
        if (Date.now() > deadlineAt) {
          listTruncated = true;
          break;
        }
        const res = await fetchPage(tenant, host, site, offset, PAGE_SIZE);
        if (!res.ok || !res.data) {
          if (postings.length === 0) {
            // Same inverted codes as probe(): 404 = wrong SITE, 422 = wrong HOST.
            const hint =
              res.status === 404
                ? ` (${WORKDAY_WRONG_SITE}: site "${site}" is wrong for tenant "${tenant}")`
                : res.status === 422
                  ? ` (${WORKDAY_WRONG_HOST}: tenant "${tenant}" is not on ${host})`
                  : "";
            return { jobs: [], error: `workday ${tenant}/${site}: ${res.error ?? "unknown error"}${hint}` };
          }
          listTruncated = true;
          break;
        }
        const page = res.data.jobPostings ?? [];
        if (page.length === 0) {
          ranDry = true;
          break;
        }
        postings.push(...page);
        if (typeof res.data.total === "number") total = res.data.total;
        offset += page.length;
      }

      const taken = postings.slice(0, cap);
      if (taken.length === 0) {
        return { jobs: [], boardCompanyName: board.companyName ?? null, truncated: listTruncated };
      }

      // N+1 detail fetch. Non-optional here: the JD *and* the only real posting
      // date both live in the detail. Same guards as SmartRecruiters.
      const { results, timedOut } = await mapWithConcurrency(
        taken,
        DETAIL_CONCURRENCY,
        deadlineAt,
        async (p) => {
          if (!p.externalPath) return null;
          const res = await httpJson<WdDetailResponse>(`${cxsBase(tenant, host, site)}${p.externalPath}`);
          return res.ok ? (res.data?.jobPostingInfo ?? null) : null;
        }
      );

      return {
        jobs: taken.map((p, i) => toRawJob(board, tenant, host, site, p, results[i])),
        boardCompanyName: board.companyName ?? null,
        // ⚠️ `offset < total` IS NOT A TRUNCATION TEST. Workday's reported `total` is
        // a live count, so a req that closes mid-pagination leaves offset one short
        // of it — AstraZeneca reports 1,319 and hands back 1,318 — and the board is
        // nonetheless COMPLETE. Flagging that as truncation cried wolf on every run.
        //
        // Truncation is exactly three things: we ran out of clock, the detail fetches
        // ran out of clock, or we stopped because we hit the cap while jobs remained.
        truncated: listTruncated || timedOut || (!ranDry && postings.length >= cap && offset < total),
      };
    } catch (e) {
      return { jobs: [], error: `workday ${board.token}: ${errMsg(e)}` };
    }
  },

  async probe(board: AtsBoard): Promise<AtsProbeResult> {
    try {
      const c = coords(board);
      if (!c) return { exists: false, jobCount: 0, error: "missing valid {tenant,host,site}" };
      const { tenant, host, site } = c;

      const res = await fetchPage(tenant, host, site, 0, 1);

      // See the WORKDAY_WRONG_SITE / WORKDAY_WRONG_HOST comment above — these two
      // codes mean the opposite of what you'd guess, and they're reported
      // distinctly so discovery knows WHICH coordinate to vary next. Conflate them
      // with a plain miss and we lose Tesco, Sainsbury's and every other enterprise
      // whose board isn't at {tenant}.wd3/Careers.
      if (res.status === 404) {
        return {
          exists: false,
          jobCount: 0,
          error: `${WORKDAY_WRONG_SITE}: tenant "${tenant}" exists on ${host} but site "${site}" does not — try another SITE`,
        };
      }
      if (res.status === 422) {
        return {
          exists: false,
          jobCount: 0,
          error: `${WORKDAY_WRONG_HOST}: tenant "${tenant}" is not on host ${host} — try another HOST (wdN)`,
        };
      }
      if (!res.ok || !res.data) {
        return { exists: false, jobCount: 0, error: res.error ?? "unknown error" };
      }
      return {
        exists: true,
        jobCount: res.data.total ?? (res.data.jobPostings?.length ?? 0),
        boardCompanyName: board.companyName ?? null,
      };
    } catch (e) {
      return { exists: false, jobCount: 0, error: errMsg(e) };
    }
  },

  detect(url: string): AtsBoard | null {
    let u: URL;
    try {
      u = new URL(url.trim());
    } catch {
      return null;
    }
    const host = u.hostname.toLowerCase();
    // {tenant}.wd3.myworkdayjobs.com — the wdN datacenter digit VARIES per tenant
    // (wd1, wd2, wd3, wd5, wd103...). Hardcoding wd3 silently misses most of them.
    const m = host.match(/^([a-z0-9-]+)\.((?:wd\d+\.)?myworkdayjobs\.com|(?:wd\d+\.)?myworkdaysite\.com)$/);
    if (!m) return null;
    const tenant = m[1];
    const wdHost = m[2];

    const segs = u.pathname.split("/").filter(Boolean);
    if (segs.length === 0) return null;

    // Raw API form: /wday/cxs/{tenant}/{site}/jobs
    if (segs[0] === "wday" && segs[1] === "cxs" && segs[3]) {
      return { provider: "workday", token: tenant, workday: { tenant, host: wdHost, site: segs[3] } };
    }

    // Public forms:
    //   /{site}/job/{loc}/{slug}          e.g. /Careers/job/London/Analyst
    //   /{locale}/{site}/job/{loc}/{slug} e.g. /en-US/Careers/job/London/Analyst
    // A locale prefix looks like "en-US" / "en_GB"; anything else is the site.
    const isLocale = /^[a-z]{2}[-_][A-Za-z]{2}$/.test(segs[0]);
    const site = isLocale ? segs[1] : segs[0];
    if (!site) return null;

    return { provider: "workday", token: tenant, workday: { tenant, host: wdHost, site } };
  },

  candidateTokens(companyName: string): string[] {
    // The tenant, not the site. Discovery must still resolve the host (wdN) and
    // then walk DEFAULT_WORKDAY_SITES via probeSites().
    return slugCandidates(companyName).filter((t) => !t.includes("_"));
  },
};

/**
 * Walk candidate site ids for a tenant on a KNOWN host; return the first that
 * resolves. Needed because "Careers" is only right about half the time, and a
 * wrong site is a 404 that looks exactly like "this employer has no Workday board".
 *
 * Bails out immediately on WORKDAY_WRONG_HOST (422): that says the tenant isn't on
 * this host at all, so every remaining site guess is a guaranteed miss. Without the
 * bail-out, discovery burns 9 requests per wrong host — times every candidate host,
 * times every company in the registry.
 *
 * Returns null when no site resolved.
 */
export async function probeSites(
  tenant: string,
  host: string,
  sites: string[] = DEFAULT_WORKDAY_SITES,
  companyName?: string | null
): Promise<{ site: string; result: AtsProbeResult } | null> {
  for (const site of sites) {
    const result = await workdayProvider.probe({
      provider: "workday",
      token: tenant,
      workday: { tenant, host, site },
      companyName,
    });
    if (result.exists) return { site, result };
    // Wrong HOST — no site on this host can ever work. Stop wasting requests.
    if (result.error?.startsWith(WORKDAY_WRONG_HOST)) return null;
    // A wrong SITE (404) or a transient error means keep trying the other sites.
  }
  return null;
}

/**
 * Full Workday discovery for a company: find the {host, site} pair, given only the
 * tenant guess. Host FIRST (a 422 rules out the whole host in one request), then
 * site within the surviving host.
 *
 * This is the function discovery should call — a tenant alone is not enough to
 * address a Workday board, and neither coordinate is guessable from the company
 * name. AstraZeneca is wd3/Careers; the next one won't be.
 */
export async function findWorkdayBoard(
  tenant: string,
  hosts: string[] = DEFAULT_WORKDAY_HOSTS,
  sites: string[] = DEFAULT_WORKDAY_SITES,
  companyName?: string | null
): Promise<{ host: string; site: string; result: AtsProbeResult } | null> {
  for (const host of hosts) {
    const hit = await probeSites(tenant, host, sites, companyName);
    if (hit) return { host, site: hit.site, result: hit.result };
  }
  return null;
}
