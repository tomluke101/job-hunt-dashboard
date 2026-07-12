// Workable — WRITTEN BUT UNVERIFIED. Disabled via PROVIDER_STATUS in ../types.ts.
//
//   GET https://apply.workable.com/api/v1/widget/accounts/{token}?details=true
//
// Probed live on 2026-07-12: the endpoint returns 200 with correct account
// metadata (`name`, `description`) and `jobs: []` for EVERY account tested —
// Tide, Bolt, Typeform, Glovo — all of which are demonstrably hiring. So the
// board "works", the health check passes, and it contributes nothing. That is the
// exact silent-zero failure this subsystem was built to avoid, so it stays off
// until a board is OBSERVED returning a real job.
//
// The adapter is kept short and unpolished on purpose: refining a mapping against
// a payload we have never actually seen is fiction. If the endpoint starts
// serving jobs, flip PROVIDER_STATUS and harden it against the real shape.

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

interface WorkableJob {
  id?: string;
  shortcode?: string;
  title?: string;
  city?: string;
  state?: string;
  country?: string;
  description?: string;
  url?: string;
  application_url?: string;
  published_on?: string;
  employment_type?: string;
  department?: string;
  telecommuting?: boolean;
}

interface WorkableResponse {
  name?: string;
  description?: string;
  jobs?: WorkableJob[];
}

function boardUrl(token: string): string {
  return `https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(token)}?details=true`;
}

function toRawJob(board: AtsBoard, j: WorkableJob, boardName: string | null): RawJob {
  const locationRaw = [j.city, j.state, j.country].filter(Boolean).join(", ") || null;
  return {
    source: "workable",
    source_id: sourceId(board.token, j.shortcode ?? j.id ?? ""),
    source_url: j.url ?? j.application_url ?? null,
    company: boardName ?? board.companyName ?? "",
    title: j.title ?? "",
    location_raw: locationRaw,
    jd_text: decodeThenHtmlToText(j.description),
    jd_html: j.description ?? null,
    posted_at: safeIso(j.published_on),
    expires_at: null,
    salary_min: null,
    salary_max: null,
    salary_currency: null,
    department: j.department ?? null,
    employment_type: canonEmploymentType(j.employment_type),
    seniority_hint: null,
    job_function: null,
    is_remote: typeof j.telecommuting === "boolean" ? j.telecommuting : null,
    location_candidates: mergeCandidates([j.city], [locationRaw]),
    country_hint: toIso2(j.country),
    lat: null,
    lng: null,
    raw: j,
  };
}

export const workableProvider: AtsProviderImpl = {
  id: "workable",

  async listJobs(board: AtsBoard, opts?: AtsPullOptions): Promise<AtsPullResult> {
    try {
      const res = await httpJson<WorkableResponse>(boardUrl(board.token));
      if (!res.ok || !res.data) {
        return { jobs: [], error: `workable ${board.token}: ${res.error ?? "unknown error"}` };
      }
      const all = Array.isArray(res.data.jobs) ? res.data.jobs : [];
      const cap = jobCap(opts);
      const taken = all.slice(0, cap);
      const boardName = res.data.name ?? board.companyName ?? null;
      return {
        jobs: taken.map((j) => toRawJob(board, j, boardName)),
        boardCompanyName: boardName,
        truncated: all.length > cap,
      };
    } catch (e) {
      return { jobs: [], error: `workable ${board.token}: ${errMsg(e)}` };
    }
  },

  async probe(board: AtsBoard): Promise<AtsProbeResult> {
    try {
      const res = await httpJson<WorkableResponse>(boardUrl(board.token));
      if (res.status === 404) return { exists: false, jobCount: 0 };
      if (!res.ok || !res.data) {
        return { exists: false, jobCount: 0, error: res.error ?? "unknown error" };
      }
      // ⚠️ jobCount is ALWAYS 0 here today (see the file header). `exists` being
      // true is therefore NOT evidence this provider works.
      return {
        exists: true,
        jobCount: (res.data.jobs ?? []).length,
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
    if (!host.endsWith("workable.com")) return null;
    // apply.workable.com/api/v1/widget/accounts/{token}
    const accIdx = segs.indexOf("accounts");
    if (accIdx !== -1 && segs[accIdx + 1]) {
      return { provider: "workable", token: segs[accIdx + 1] };
    }
    // apply.workable.com/{token}/[j/{shortcode}]
    if (segs[0] && segs[0] !== "api") return { provider: "workable", token: segs[0] };
    // {token}.workable.com
    const sub = host.match(/^([a-z0-9-]+)\.workable\.com$/);
    if (sub && sub[1] !== "apply" && sub[1] !== "www") {
      return { provider: "workable", token: sub[1] };
    }
    return null;
  },

  candidateTokens(companyName: string): string[] {
    return slugCandidates(companyName);
  },
};
