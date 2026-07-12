// Lever. Keyless, public.
//   GET https://api.lever.co/v0/postings/{token}?mode=json  → TOP-LEVEL ARRAY
//
// Note the response is a bare array, not {jobs:[...]} like everyone else. Reading
// `.jobs` off it yields undefined → 0 jobs → a healthy-looking, silently empty
// board. That is exactly the Adzuna failure mode this whole subsystem exists to
// avoid, so we assert the array shape explicitly.

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
  joinJd,
  pathSegments,
  safeIso,
  slugCandidates,
  sourceId,
  splitLocationCandidates,
  toIso2,
} from "./_util";

interface LeverList {
  text?: string;
  content?: string; // HTML: a bare run of <li>…</li>
}

interface LeverPosting {
  id?: string;
  text?: string; // the TITLE. Not the description.
  categories?: {
    location?: string;
    team?: string;
    commitment?: string;
    department?: string;
  };
  description?: string;
  descriptionPlain?: string;
  additional?: string;
  additionalPlain?: string;
  lists?: LeverList[];
  hostedUrl?: string;
  applyUrl?: string;
  createdAt?: number; // MILLISECONDS since epoch
  country?: string;
  workplaceType?: string; // "remote" | "hybrid" | "onsite"
  opening?: string;
  openingPlain?: string;
}

function listUrl(token: string): string {
  return `https://api.lever.co/v0/postings/${encodeURIComponent(token)}?mode=json`;
}

/**
 * Lever splits a JD across FOUR fields and the interesting half lives in the ones
 * you'd skip. `descriptionPlain` is usually the team/company blurb; the actual
 * requirements ("5+ years in supply chain", "SAP") sit in `lists` and `additional`.
 * Take only the description and you get a JD that reads fine and matches nothing.
 */
function buildJd(p: LeverPosting): { text: string; html: string | null } {
  const listsText = (p.lists ?? [])
    .map((l) => {
      const heading = (l.text ?? "").trim();
      const body = decodeThenHtmlToText(l.content);
      return joinJd([heading, body]);
    })
    .filter(Boolean);

  const text = joinJd([
    p.openingPlain ?? decodeThenHtmlToText(p.opening),
    p.descriptionPlain ?? decodeThenHtmlToText(p.description),
    ...listsText,
    p.additionalPlain ?? decodeThenHtmlToText(p.additional),
  ]);

  const htmlParts = [
    p.description ?? "",
    ...(p.lists ?? []).map((l) => `<h3>${l.text ?? ""}</h3><ul>${l.content ?? ""}</ul>`),
    p.additional ?? "",
  ].filter((s) => s.trim().length > 0);

  return { text, html: htmlParts.length ? htmlParts.join("\n") : null };
}

function toRawJob(board: AtsBoard, p: LeverPosting): RawJob {
  const locationRaw = p.categories?.location ?? null;
  const { text, html } = buildJd(p);

  return {
    source: "lever",
    source_id: sourceId(board.token, p.id ?? ""),
    source_url: p.hostedUrl ?? p.applyUrl ?? null,
    // Lever ships no company name anywhere in the payload — the token IS the
    // identity, so we fall back to whatever discovery believed.
    company: board.companyName ?? "",
    title: p.text ?? "",
    location_raw: locationRaw,
    jd_text: text,
    jd_html: html,
    // createdAt is MILLISECONDS. Passing it to new Date() as seconds lands the
    // posting in 1970 and every freshness filter drops the job.
    posted_at: typeof p.createdAt === "number" ? safeIso(p.createdAt) : null,
    expires_at: null,
    salary_min: null,
    salary_max: null,
    salary_currency: null,
    department: p.categories?.department ?? p.categories?.team ?? null,
    employment_type: canonEmploymentType(p.categories?.commitment),
    seniority_hint: null, // Lever states none.
    job_function: p.categories?.team ?? null,
    is_remote: p.workplaceType ? p.workplaceType.toLowerCase() === "remote" : null,
    location_candidates: splitLocationCandidates(locationRaw),
    country_hint: toIso2(p.country),
    lat: null,
    lng: null,
    raw: p,
  };
}

export const leverProvider: AtsProviderImpl = {
  id: "lever",

  async listJobs(board: AtsBoard, opts?: AtsPullOptions): Promise<AtsPullResult> {
    try {
      const res = await httpJson<LeverPosting[]>(listUrl(board.token));
      if (!res.ok || !res.data) {
        return { jobs: [], error: `lever ${board.token}: ${res.error ?? "unknown error"}` };
      }
      if (!Array.isArray(res.data)) {
        return { jobs: [], error: `lever ${board.token}: expected an array, got ${typeof res.data}` };
      }
      const cap = jobCap(opts);
      const taken = res.data.slice(0, cap);
      return {
        jobs: taken.map((p) => toRawJob(board, p)),
        // Lever's postings API carries NO company-name field — only `categories`
        // (team/department) and the posting text. It MUST be null.
        //
        // Echoing back `board.companyName` (the name the CALLER passed in) makes
        // discovery's namesMatch() compare the company against itself and return
        // true every time — a circular check that verifies nothing. That bug
        // silently "verified" lever/bloom for Bloom & Wild, where the board is
        // actually a shared agency board for Craft Public Relations. A Lever board
        // can only be trusted via a careers-page crawl, never a token guess.
        boardCompanyName: null,
        truncated: res.data.length > cap,
      };
    } catch (e) {
      return { jobs: [], error: `lever ${board.token}: ${errMsg(e)}` };
    }
  },

  async probe(board: AtsBoard): Promise<AtsProbeResult> {
    try {
      const res = await httpJson<LeverPosting[]>(listUrl(board.token));
      if (res.status === 404) return { exists: false, jobCount: 0 };
      if (!res.ok || !res.data) {
        return { exists: false, jobCount: 0, error: res.error ?? "unknown error" };
      }
      if (!Array.isArray(res.data)) {
        return { exists: false, jobCount: 0, error: "unexpected response shape" };
      }
      // 200 with [] is a REAL board that has nothing open today. A missing board
      // 404s. Collapsing the two loses the employer for good.
      //
      // boardCompanyName stays null — see listJobs. Lever cannot self-identify, so
      // a Lever board found by token-probe is always UNVERIFIED by construction.
      return { exists: true, jobCount: res.data.length, boardCompanyName: null };
    } catch (e) {
      return { exists: false, jobCount: 0, error: errMsg(e) };
    }
  },

  detect(url: string): AtsBoard | null {
    const p = pathSegments(url);
    if (!p) return null;
    const { host, segs } = p;

    // api.lever.co/v0/postings/{token}
    if (host.endsWith("lever.co") && segs[0] === "v0" && segs[1] === "postings" && segs[2]) {
      return { provider: "lever", token: segs[2] };
    }
    // jobs.lever.co/{token}[/{postingId}], jobs.eu.lever.co/{token}
    if (host.endsWith("lever.co") && segs[0]) {
      return { provider: "lever", token: segs[0] };
    }
    return null;
  },

  candidateTokens(companyName: string): string[] {
    return slugCandidates(companyName);
  },
};
