// Teaching Vacancies — the DfE's national first-party school-jobs portal.
//
// WHY THIS IS A NEW *KIND* OF SOURCE (a PORTAL, not a per-employer board)
// ----------------------------------------------------------------------
// The moat so far is per-employer boards: one careers page = one employer, and the
// jsonld reader REFUSES any page showing more than one distinct hiringOrganization
// (that is how a recruiter board leaks in — see jsonld.ts trust rule 1). That very
// invariant is why blue-collar / care / education supply is ~0: NHS trusts, state
// schools and councils don't post on Greenhouse/Lever/Workday — they post on
// government-run FIRST-PARTY PORTALS (SEARCH_QUALITY_BASELINE #6).
//
// Teaching Vacancies (teaching-vacancies.service.gov.uk, run by the Department for
// Education) is exactly that: a single endpoint carrying thousands of DISTINCT
// schools' own vacancies. It is a portal, so it cannot ride the jsonld reader (that
// would reject it as multi-org). But it is still FIRST-PARTY, and — crucially —
// zero-recruiter BY CONSTRUCTION: only the school / trust / local authority that
// owns a job can list it. An agency cannot pose as a state school, because the
// portal itself gatekeeps who may post. So the moat's zero-recruiter guarantee
// holds here through the PORTAL's gatekeeping instead of our single-org check —
// which is why teaching_vacancies belongs in ATS_SOURCES (first-party) exactly like
// an employer's own board.
//
// THE DATA
// --------
//   GET https://teaching-vacancies.service.gov.uk/api/v1/jobs.json?page=N
//   • keyless, public, free, 100 jobs/page. `meta.{totalPages,count}` is
//     authoritative (~31 pages / ~3.0k live UK vacancies at time of writing);
//     pages past the end return an empty `data` array.
//   • each item is a schema.org JobPosting (the SAME vocabulary jsonld.ts reads),
//     with the school as hiringOrganization.name, a UK postcode on jobLocation,
//     and the full HTML description inline — so there is NO per-job detail fetch
//     (unlike Workday/SmartRecruiters): one GET per page pulls the whole board.
//   • all UK (England + Wales state schools), so is_foreign never fires; we still
//     hand geo country_hint:"GB" as belt-and-braces against name collisions
//     ("Boston" is Boston, Lincs here — not Massachusetts).
//
// This adapter just maps each JobPosting → RawJob. Everything downstream — geocode,
// dedupe, salary parse, classify, canonical key, upsert — is the identical hardened
// path ingest.ts runs for every other board. Nothing about the write side is new.
//
// ⚠️ THE PORTAL'S OWN PAGINATION OVERLAPS. `?page=N` is offset pagination over a
// non-unique sort (many jobs share a publish date), so adjacent pages share ~15-20
// URLs and the tail of the list is under-covered: a single full pull sees ~2.5k of
// the ~3.0k `meta.count` distinct vacancies, and the SAME url recurs across pages.
// Two consequences handled here:
//   1. We DEDUPE by source_id inside the pull. Returning the same (source, source_id)
//      twice would fail the batch upsert ("ON CONFLICT DO UPDATE cannot affect row a
//      second time") and silently drop a whole 100-row chunk — a supply loss dressed
//      as success. The other providers never hit this (their APIs return unique ids);
//      a portal paging a live list does.
//   2. The ~15% not seen on a given night is not lost: the board churns daily, the
//      nightly cron re-pulls, and last_seen_at holds a job for 14 days — so coverage
//      converges across runs. (There is no cursor / stable id to page cleanly; the
//      links object's `next` is just `?page=N+1`.)

import type { AtsBoard, AtsProbeResult, AtsPullResult } from "../types";
import type { RawJob } from "@/lib/job-search/types";
import {
  type AtsProviderImpl,
  type AtsPullOptions,
  budgetDeadline,
  canonEmploymentType,
  decodeThenHtmlToText,
  errMsg,
  httpJson,
  joinJd,
  mergeCandidates,
  safeIso,
} from "./_util";

/** The listing endpoint. token = this URL (a portal has one, fixed, address). */
export const TEACHING_VACANCIES_API =
  "https://teaching-vacancies.service.gov.uk/api/v1/jobs.json";

/**
 * Page ceiling — a backstop, not the stop condition. We page until `meta.totalPages`
 * (authoritative) or an EMPTY `data` array, whichever comes first. 500 pages is
 * ~50k jobs of headroom (the portal is ~31 pages today), so a normal pull never
 * reaches it. If the portal ever grew past this, we flag `truncated` —
 * assertNoSilentTruncation() in ingest.ts turns that into a loud, recorded problem
 * rather than a silent cut. We deliberately do NOT stop on a short page: the real
 * page size is 100, but relying on it would silently truncate supply the day the
 * portal changed it — the exact failure class this codebase guards against.
 */
const MAX_PAGES = 500;

/** Politeness between page fetches against a single government host. */
const POLITE_DELAY_MS = 120;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- schema.org JobPosting, as this portal ships it -------------------------

interface TvAddress {
  addressLocality?: string | null;
  addressRegion?: string | null;
  postalCode?: string | null;
  streetAddress?: string | null;
  addressCountry?: string | null;
}
interface TvPlace {
  address?: TvAddress | null;
}
interface TvJob {
  title?: string | null;
  description?: string | null;
  datePosted?: string | null;
  validThrough?: string | null;
  employmentType?: string[] | string | null;
  occupationalCategory?: string | null;
  // schema.org allows one place or several (a trust hiring across sites).
  jobLocation?: TvPlace | TvPlace[] | null;
  baseSalary?: {
    currency?: string | null;
    value?: unknown; // "£12.71 Hourly" | "£25,989–£27,255 FTE" | {value,unitText} | number
  } | null;
  hiringOrganization?: { name?: string | null } | null;
  url?: string | null;
  identifier?: { value?: string | number | null } | string | number | null;
}
interface TvResponse {
  data?: TvJob[];
  /** Authoritative pagination. Present on every page. */
  meta?: { totalPages?: number; count?: number } | null;
}

function clean(s: string | null | undefined): string | null {
  const t = (s ?? "").trim();
  return t ? t : null;
}

function pageUrl(token: string, page: number): string {
  const u = new URL(token);
  u.searchParams.set("page", String(page));
  return u.toString();
}

/** A stable, unique id for this vacancy. The portal's URL slug is unique and never
 *  changes for a live posting, so it keeps upserts idempotent across nightly runs. */
function vacancyId(job: TvJob): string | null {
  const ident =
    typeof job.identifier === "object" && job.identifier
      ? job.identifier.value
      : job.identifier;
  if (ident !== null && ident !== undefined && String(ident).trim()) {
    return String(ident).trim();
  }
  const url = clean(job.url);
  if (!url) return null;
  try {
    const segs = new URL(url).pathname.split("/").filter(Boolean);
    return segs[segs.length - 1] ?? null;
  } catch {
    return null;
  }
}

/** Render the employer's stated pay as text so the shared salary parser (which
 *  rounds — see salary-parse.ts / SEARCH_QUALITY_BASELINE #1) can read it. We emit
 *  NO structured salary_min/max ourselves: the value is free text ("£12.71 Hourly",
 *  "£25,989–£27,255 FTE"), and a fractional number in an integer column is the exact
 *  crash defect #1 was. Better a parsed-or-null figure from one chokepoint. */
function salaryText(base: TvJob["baseSalary"]): string | null {
  if (!base) return null;
  const v = base.value;
  if (typeof v === "string") return clean(v);
  if (typeof v === "number") return String(v);
  if (v && typeof v === "object") {
    const o = v as { value?: unknown; minValue?: unknown; maxValue?: unknown; unitText?: unknown };
    const val = o.value ?? [o.minValue, o.maxValue].filter((x) => x != null).join("–");
    const s = val != null && String(val).trim() ? String(val).trim() : null;
    if (!s) return null;
    return o.unitText ? `${s} ${String(o.unitText)}` : s;
  }
  return null;
}

function places(job: TvJob): TvPlace[] {
  const jl = job.jobLocation;
  if (Array.isArray(jl)) return jl.filter(Boolean);
  return jl ? [jl] : [];
}

/** One JobPosting → RawJob. Returns null for an item too broken to place (no title
 *  or no url) — the caller counts those so an all-broken pull reads as an ERROR
 *  (site/markup change), never as "no jobs" (jsonld.ts trust rule 2). */
function toRawJob(job: TvJob): RawJob | null {
  const title = clean(job.title);
  const url = clean(job.url);
  const id = vacancyId(job);
  if (!title || !url || !id) return null;

  const locs = places(job);
  const primary = locs[0]?.address ?? null;
  const locality = clean(primary?.addressLocality);
  const postcode = clean(primary?.postalCode);
  const region = clean(primary?.addressRegion);

  // location_raw is the human-readable truth ("Bedford, MK45 5JH"); the town
  // resolves off the gazetteer with zero network, the postcode rides as a
  // candidate so postcodes.io can place a locality the gazetteer misses.
  const locationRaw = [locality, postcode].filter(Boolean).join(", ") || region || null;
  const candidates = mergeCandidates(
    [postcode],
    [locality],
    locs.slice(1).map((l) => clean(l.address?.postalCode) ?? ""),
    locs.slice(1).map((l) => clean(l.address?.addressLocality) ?? "")
  );

  const empRaw = Array.isArray(job.employmentType) ? job.employmentType[0] : job.employmentType;
  const salary = salaryText(job.baseSalary);

  return {
    source: "teaching_vacancies",
    source_id: `tv:${id}`,
    source_url: url,
    company: clean(job.hiringOrganization?.name) ?? "",
    title,
    location_raw: locationRaw,
    // Prepend the stated pay so the shared parser can extract it; keep null figures.
    jd_text: joinJd([salary ? `Salary: ${salary}` : null, decodeThenHtmlToText(job.description)]),
    jd_html: typeof job.description === "string" && job.description.trim() ? job.description : null,
    posted_at: safeIso(job.datePosted),
    expires_at: safeIso(job.validThrough),
    salary_min: null,
    salary_max: null,
    salary_currency: clean(job.baseSalary?.currency) ?? "GBP",
    department: clean(job.occupationalCategory),
    employment_type: canonEmploymentType(empRaw),
    seniority_hint: null, // schools don't ship a seniority field; classify derives it.
    job_function: null,
    is_remote: null, // school roles are on-site; never assert remote.
    location_candidates: candidates.length ? candidates : undefined,
    country_hint: "GB", // all TV supply is UK — reinforces the gazetteer, blocks collisions.
    lat: null,
    lng: null,
    raw: job,
  };
}

export const teachingVacanciesProvider: AtsProviderImpl = {
  id: "teaching_vacancies",

  async listJobs(board: AtsBoard, opts?: AtsPullOptions): Promise<AtsPullResult> {
    const token = board.token || TEACHING_VACANCIES_API;
    const deadline = budgetDeadline(opts);
    const jobs: RawJob[] = [];
    // The portal's offset pages overlap (see header) — the same posting recurs on
    // several pages. Dedupe by source_id here so we never hand ingest two rows with
    // the same conflict key (which fails the whole batch upsert).
    const seenIds = new Set<string>();
    let enumerated = 0;
    let truncated = false;
    let softError: string | null = null;
    let totalPages = MAX_PAGES; // narrowed to meta.totalPages after page 1.

    let page = 1;
    for (; page <= MAX_PAGES && page <= totalPages; page++) {
      if (Date.now() > deadline) {
        truncated = true;
        softError = `budget exhausted at page ${page} of ${totalPages}`;
        break;
      }
      const res = await httpJson<TvResponse>(pageUrl(token, page));
      if (!res.ok || !res.data) {
        // Page 1 failing = the source is down; report it as an error (no jobs).
        // A LATER page failing after we already have jobs = a partial pull: keep
        // what we have, but flag it loudly rather than silently serving a slice.
        if (page === 1) {
          return { jobs: [], error: `teaching_vacancies page 1: ${res.error ?? `HTTP ${res.status}`}` };
        }
        truncated = true;
        softError = `stopped at page ${page}: ${res.error ?? `HTTP ${res.status}`}`;
        break;
      }
      // Authoritative page count — believe it once, but the empty-page break below
      // is the real backstop in case it is ever absent or wrong.
      const mtp = res.data.meta?.totalPages;
      if (typeof mtp === "number" && mtp > 0 && mtp < MAX_PAGES) totalPages = mtp;

      const items = Array.isArray(res.data.data) ? res.data.data : [];
      if (items.length === 0) break; // walked off the end
      enumerated += items.length;
      for (const it of items) {
        const rj = toRawJob(it);
        if (rj && !seenIds.has(rj.source_id)) {
          seenIds.add(rj.source_id);
          jobs.push(rj);
        }
      }
      await sleep(POLITE_DELAY_MS);
    }
    // Hit the hard ceiling with the portal claiming still more pages = a real cut.
    if (page > MAX_PAGES && totalPages > MAX_PAGES) truncated = true;

    // Enumerated > 0 but parsed 0 = the API shape moved under us. Returning [] here
    // would be the Adzuna failure mode: a dead source indistinguishable from an
    // empty market. Say it out loud instead.
    if (enumerated > 0 && jobs.length === 0) {
      return {
        jobs: [],
        error: `teaching_vacancies: enumerated ${enumerated} postings but parsed 0 — API shape changed?`,
      };
    }

    return {
      jobs,
      boardCompanyName: null, // a portal has no single company — and it is never discovered by name.
      truncated,
      ...(softError ? { error: softError } : {}),
    };
  },

  async probe(board: AtsBoard): Promise<AtsProbeResult> {
    try {
      const res = await httpJson<TvResponse>(pageUrl(board.token || TEACHING_VACANCIES_API, 1));
      if (!res.ok || !res.data) {
        return { exists: false, jobCount: 0, error: res.error ?? `HTTP ${res.status}` };
      }
      const items = Array.isArray(res.data.data) ? res.data.data : [];
      // A portal always exists; jobCount is this first page's count (a liveness signal).
      return { exists: true, jobCount: items.length, boardCompanyName: null };
    } catch (e) {
      return { exists: false, jobCount: 0, error: errMsg(e) };
    }
  },

  detect(url: string): AtsBoard | null {
    try {
      const host = new URL(url.trim()).hostname.toLowerCase();
      if (host.endsWith("teaching-vacancies.service.gov.uk")) {
        return { provider: "teaching_vacancies", token: TEACHING_VACANCIES_API };
      }
    } catch {
      /* not a URL */
    }
    return null;
  },

  // A fixed national portal is NEVER discovered by guessing a company slug — it is
  // seeded once (scripts/seed-teaching-vacancies.ts). Returning [] keeps discovery
  // from ever fabricating a bogus teaching_vacancies board for some company name.
  candidateTokens(): string[] {
    return [];
  },
};
