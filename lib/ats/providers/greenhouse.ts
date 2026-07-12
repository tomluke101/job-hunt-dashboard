// Greenhouse. Keyless, public, no rate limit published.
//   list  GET https://boards-api.greenhouse.io/v1/boards/{token}/jobs?content=true
//   probe GET https://boards-api.greenhouse.io/v1/boards/{token}/jobs   (no content — cheap)
//
// The single richest UK tech source: Monzo, GoCardless, Starling, Wise, Deliveroo,
// Cloudflare, Figma all run Greenhouse boards.
//
// ⚠️ `content` is ENTITY-ESCAPED HTML — see decodeEscapedHtml() in _util.ts. That
// one trap silently corrupts every JD on this provider; the probe script asserts
// against it.

import type { AtsBoard, AtsProbeResult, AtsPullResult } from "../types";
import type { RawJob } from "@/lib/job-search/types";
import {
  type AtsProviderImpl,
  type AtsPullOptions,
  canonEmploymentType,
  decodeEscapedHtml,
  decodeThenHtmlToText,
  errMsg,
  httpJson,
  jobCap,
  pathSegments,
  safeIso,
  slugCandidates,
  sourceId,
  splitLocationCandidates,
} from "./_util";

interface GhJob {
  id: number;
  title?: string;
  location?: { name?: string };
  absolute_url?: string;
  content?: string;
  updated_at?: string;
  first_published?: string;
  company_name?: string;
  departments?: { name?: string }[];
  offices?: { name?: string }[];
  requisition_id?: string;
  metadata?: { name?: string; value?: unknown; value_type?: string }[];
}

interface GhResponse {
  jobs?: GhJob[];
}

function listUrl(token: string, withContent: boolean): string {
  const base = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(token)}/jobs`;
  return withContent ? `${base}?content=true` : base;
}

/**
 * Greenhouse has no employment-type field, but many boards expose one as a custom
 * `metadata` entry. This reads the employer's OWN answer — it is not a guess from
 * the title (see canonEmploymentType). Anything unrecognised stays null.
 */
function employmentFromMetadata(job: GhJob): string | null {
  try {
    for (const m of job.metadata ?? []) {
      if (!m?.name) continue;
      if (!/employ|contract type|job type|working pattern/i.test(m.name)) continue;
      const v = Array.isArray(m.value) ? m.value[0] : m.value;
      const canon = canonEmploymentType(typeof v === "string" ? v : null);
      if (canon) return canon;
    }
  } catch {
    // metadata shape varies per board; a malformed entry must not lose the job.
  }
  return null;
}

function toRawJob(board: AtsBoard, job: GhJob): RawJob {
  const rawContent = job.content ?? "";
  const html = decodeEscapedHtml(rawContent); // store REAL html, not the escaped form
  const locationRaw = job.location?.name ?? null;

  return {
    source: "greenhouse",
    // Prefixed — a bare Greenhouse id collides across boards. See sourceId().
    source_id: sourceId(board.token, job.id),
    source_url: job.absolute_url ?? null,
    company: job.company_name ?? board.companyName ?? "",
    title: job.title ?? "",
    location_raw: locationRaw,
    jd_text: decodeThenHtmlToText(rawContent),
    jd_html: html || null,
    // `updated_at` moves every time a recruiter touches the req, which makes a
    // 2-year-old role look posted today. Prefer the real publication date.
    posted_at: safeIso(job.first_published) ?? safeIso(job.updated_at),
    expires_at: null,
    salary_min: null,
    salary_max: null,
    salary_currency: null,
    department: job.departments?.[0]?.name ?? null,
    employment_type: employmentFromMetadata(job),
    seniority_hint: null, // Greenhouse states none — never infer it from the title.
    job_function: null,
    is_remote: null, // no structured flag; "Remote" only ever appears in free text.
    location_candidates: splitLocationCandidates(locationRaw),
    country_hint: null,
    lat: null,
    lng: null,
    raw: job,
  };
}

export const greenhouseProvider: AtsProviderImpl = {
  id: "greenhouse",

  async listJobs(board: AtsBoard, opts?: AtsPullOptions): Promise<AtsPullResult> {
    try {
      const res = await httpJson<GhResponse>(listUrl(board.token, true));
      if (!res.ok || !res.data) {
        return { jobs: [], error: `greenhouse ${board.token}: ${res.error ?? "unknown error"}` };
      }
      const all = Array.isArray(res.data.jobs) ? res.data.jobs : [];
      const cap = jobCap(opts);
      const taken = all.slice(0, cap);
      return {
        jobs: taken.map((j) => toRawJob(board, j)),
        // Greenhouse gives the same company_name on every job — take it from the
        // first so discovery can catch a token that resolved to the wrong employer.
        boardCompanyName: all[0]?.company_name ?? board.companyName ?? null,
        truncated: all.length > cap,
      };
    } catch (e) {
      return { jobs: [], error: `greenhouse ${board.token}: ${errMsg(e)}` };
    }
  },

  async probe(board: AtsBoard): Promise<AtsProbeResult> {
    try {
      const res = await httpJson<GhResponse>(listUrl(board.token, false));
      if (res.status === 404) return { exists: false, jobCount: 0 };
      if (!res.ok || !res.data) {
        return { exists: false, jobCount: 0, error: res.error ?? "unknown error" };
      }
      const jobs = Array.isArray(res.data.jobs) ? res.data.jobs : [];
      // A board with zero open roles still EXISTS. Treating 0 as "no such board"
      // would permanently discard a real employer that happens to be between hires.
      return {
        exists: true,
        jobCount: jobs.length,
        boardCompanyName: jobs[0]?.company_name ?? null,
      };
    } catch (e) {
      return { exists: false, jobCount: 0, error: errMsg(e) };
    }
  },

  detect(url: string): AtsBoard | null {
    const p = pathSegments(url);
    if (!p) return null;
    const { host, segs } = p;

    // boards-api.greenhouse.io/v1/boards/{token}/jobs
    if (host.endsWith("greenhouse.io") && segs[0] === "v1" && segs[1] === "boards" && segs[2]) {
      return { provider: "greenhouse", token: segs[2] };
    }
    // boards.greenhouse.io/{token}, job-boards.greenhouse.io/{token},
    // boards.eu.greenhouse.io/{token} — the EU host is a separate datacenter but
    // the SAME token namespace on the API host, so we don't need to record it.
    if (host.endsWith("greenhouse.io") && segs[0]) {
      // .../embed/job_board?for={token}
      if (segs[0] === "embed") {
        try {
          const forToken = new URL(url).searchParams.get("for");
          return forToken ? { provider: "greenhouse", token: forToken } : null;
        } catch {
          return null;
        }
      }
      return { provider: "greenhouse", token: segs[0] };
    }
    return null;
  },

  candidateTokens(companyName: string): string[] {
    // Greenhouse tokens are lowercase alphanumeric with no separators far more
    // often than not ("gocardless", "monzo"), which slugCandidates emits first.
    return slugCandidates(companyName);
  },
};
