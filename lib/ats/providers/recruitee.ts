// Recruitee. Keyless, public, per-tenant subdomain.
//   GET https://{token}.recruitee.com/api/offers/
//
// Strong in EU/UK scale-ups. Ships the JD in TWO fields (description +
// requirements) and gives us employment type, experience level and an ISO-2
// country outright.

import type { AtsBoard, AtsProbeResult, AtsPullResult } from "../types";
import type { RawJob } from "@/lib/job-search/types";
import {
  type AtsProviderImpl,
  type AtsPullOptions,
  canonEmploymentType,
  canonSeniority,
  decodeThenHtmlToText,
  errMsg,
  httpJson,
  jobCap,
  joinJd,
  mergeCandidates,
  parseLooseUtc,
  pathSegments,
  slugCandidates,
  sourceId,
  toIso2,
} from "./_util";

interface RecruiteeLocation {
  city?: string;
  country?: string;
  country_code?: string;
  full_address?: string;
}

interface RecruiteeOffer {
  id?: number | string;
  title?: string;
  slug?: string;
  description?: string;
  requirements?: string;
  city?: string;
  country?: string;
  country_code?: string;
  postal_code?: string;
  careers_url?: string;
  careers_apply_url?: string;
  created_at?: string;
  published_at?: string;
  employment_type_code?: string;
  experience_code?: string;
  education_code?: string;
  department?: string;
  remote?: boolean;
  hybrid?: boolean;
  on_site?: boolean;
  locations?: (RecruiteeLocation | string)[];
  company_name?: string;
  status?: string;
}

interface RecruiteeResponse {
  offers?: RecruiteeOffer[];
}

/**
 * Recruitee is the only provider where the token is a SUBDOMAIN, not a path
 * segment. encodeURIComponent does NOT protect a host position (it leaves `.`
 * alone), so a token like "evil.com/x" would build a URL pointing at someone
 * else's server. Tokens come from crawled careers pages, i.e. untrusted input —
 * validate the shape instead of encoding it.
 */
function boardUrl(token: string): string | null {
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/i.test(token)) return null;
  return `https://${token.toLowerCase()}.recruitee.com/api/offers/`;
}

function isPublished(o: RecruiteeOffer): boolean {
  // Be permissive: some tenants omit `status` entirely. Only exclude when the
  // field is present AND says something other than published — a strict
  // `=== "published"` would silently drop every job on the boards that omit it.
  if (typeof o.status !== "string" || !o.status) return true;
  return o.status.toLowerCase() === "published";
}

function locationStrings(o: RecruiteeOffer): (string | null | undefined)[] {
  const out: (string | null | undefined)[] = [];
  for (const l of o.locations ?? []) {
    if (typeof l === "string") out.push(l);
    else if (l && typeof l === "object") out.push(l.city ?? l.full_address);
  }
  return out;
}

function toRawJob(board: AtsBoard, o: RecruiteeOffer): RawJob {
  const locationRaw =
    [o.city, o.country].filter((s): s is string => !!s && s.trim().length > 0).join(", ") || null;

  // Recruitee splits the JD in two and the requirements half is the half that
  // carries the skills a keyword match actually needs. Dropping it halves recall.
  const jdText = joinJd([decodeThenHtmlToText(o.description), decodeThenHtmlToText(o.requirements)]);
  const jdHtml = [o.description ?? "", o.requirements ?? ""].filter((s) => s.trim()).join("\n") || null;

  return {
    source: "recruitee",
    source_id: sourceId(board.token, o.id ?? o.slug ?? ""),
    source_url: o.careers_url ?? o.careers_apply_url ?? null,
    company: o.company_name ?? board.companyName ?? "",
    title: o.title ?? "",
    location_raw: locationRaw,
    jd_text: jdText,
    jd_html: jdHtml,
    // "2025-12-22 10:19:52 UTC" — not ISO. parseLooseUtc normalises it; passing it
    // to new Date() raw is engine-dependent and returns Invalid Date on some.
    posted_at: parseLooseUtc(o.published_at) ?? parseLooseUtc(o.created_at),
    expires_at: null,
    salary_min: null, // `salary` here is a free-text/partial object — not trustworthy structured data.
    salary_max: null,
    salary_currency: null,
    department: o.department ?? null,
    employment_type: canonEmploymentType(o.employment_type_code),
    seniority_hint: canonSeniority(o.experience_code),
    job_function: null,
    is_remote: typeof o.remote === "boolean" ? o.remote : null,
    location_candidates: mergeCandidates([o.city], locationStrings(o)),
    country_hint: toIso2(o.country_code ?? o.country),
    lat: null,
    lng: null,
    raw: o,
  };
}

export const recruiteeProvider: AtsProviderImpl = {
  id: "recruitee",

  async listJobs(board: AtsBoard, opts?: AtsPullOptions): Promise<AtsPullResult> {
    try {
      const url = boardUrl(board.token);
      if (!url) return { jobs: [], error: `recruitee: invalid token "${board.token}"` };
      const res = await httpJson<RecruiteeResponse>(url);
      if (!res.ok || !res.data) {
        return { jobs: [], error: `recruitee ${board.token}: ${res.error ?? "unknown error"}` };
      }
      const all = (Array.isArray(res.data.offers) ? res.data.offers : []).filter(isPublished);
      const cap = jobCap(opts);
      const taken = all.slice(0, cap);
      return {
        jobs: taken.map((o) => toRawJob(board, o)),
        boardCompanyName: all[0]?.company_name ?? board.companyName ?? null,
        truncated: all.length > cap,
      };
    } catch (e) {
      return { jobs: [], error: `recruitee ${board.token}: ${errMsg(e)}` };
    }
  },

  async probe(board: AtsBoard): Promise<AtsProbeResult> {
    try {
      const url = boardUrl(board.token);
      if (!url) return { exists: false, jobCount: 0, error: `invalid token "${board.token}"` };
      const res = await httpJson<RecruiteeResponse>(url);
      // A non-existent tenant subdomain doesn't resolve at all (status 0) or 404s.
      if (res.status === 404 || res.status === 0) {
        return { exists: false, jobCount: 0, error: res.error };
      }
      if (!res.ok || !res.data) {
        return { exists: false, jobCount: 0, error: res.error ?? "unknown error" };
      }
      const offers = (res.data.offers ?? []).filter(isPublished);
      return {
        exists: true,
        jobCount: offers.length,
        boardCompanyName: offers[0]?.company_name ?? null,
      };
    } catch (e) {
      return { exists: false, jobCount: 0, error: errMsg(e) };
    }
  },

  detect(url: string): AtsBoard | null {
    const p = pathSegments(url);
    if (!p) return null;
    const { host } = p;
    // {token}.recruitee.com — the token is the SUBDOMAIN, unlike every other provider.
    const m = host.match(/^([a-z0-9-]+)\.recruitee\.com$/);
    if (!m || m[1] === "www" || m[1] === "api") return null;
    return { provider: "recruitee", token: m[1] };
  },

  candidateTokens(companyName: string): string[] {
    // Subdomains can't contain "_", so drop that variant.
    return slugCandidates(companyName).filter((t) => !t.includes("_"));
  },
};
