// SmartRecruiters. Keyless, public.
//   list   GET https://api.smartrecruiters.com/v1/companies/{token}/postings?limit=100&offset=N
//   detail GET https://api.smartrecruiters.com/v1/companies/{token}/postings/{id}
//
// 🎁 The richest STRUCTURED provider. It hands us, per posting, for free:
//   • lat + lng          → the geo layer can skip geocoding entirely
//   • country as ISO-2   → no name→code guessing
//   • typeOfEmployment   → the Job Type filter
//   • experienceLevel    → the Experience Level filter
//   • function           → the Job Function filter
// Those are exactly the three filters we're building next, and no aggregator has
// any of them. Capture all of it at ingest — backfilling later means re-pulling
// the whole corpus.
//
// ⚠️ THE COST: the LIST CARRIES NO JD. Getting the description means one extra
// request PER JOB (an N+1). Left unbounded, a 900-posting board = 900 sequential
// requests and one slow employer stalls an entire ingest run. Hence: concurrency
// cap + a wall-clock budget + `truncated`.

import type { AtsBoard, AtsProbeResult, AtsPullResult } from "../types";
import type { RawJob } from "@/lib/job-search/types";
import {
  type AtsProviderImpl,
  type AtsPullOptions,
  DETAIL_CONCURRENCY,
  budgetDeadline,
  canonEmploymentType,
  canonSeniority,
  decodeThenHtmlToText,
  errMsg,
  httpJson,
  jobCap,
  joinJd,
  mapWithConcurrency,
  pathSegments,
  safeIso,
  slugCandidates,
  sourceId,
  splitLocationCandidates,
  toIso2,
} from "./_util";

const PAGE_SIZE = 100;

interface SrLabel {
  id?: string;
  label?: string;
}

interface SrPosting {
  id?: string;
  name?: string; // the TITLE
  uuid?: string;
  refNumber?: string;
  company?: { identifier?: string; name?: string };
  releasedDate?: string;
  location?: {
    city?: string;
    region?: string;
    country?: string; // ISO-2, LOWERCASE ("gb", "us")
    remote?: boolean;
    hybrid?: boolean;
    latitude?: string; // strings, not numbers
    longitude?: string;
    fullLocation?: string;
  };
  industry?: SrLabel;
  department?: SrLabel;
  function?: SrLabel;
  typeOfEmployment?: SrLabel;
  experienceLevel?: SrLabel;
  ref?: string;
}

interface SrListResponse {
  content?: SrPosting[];
  totalFound?: number;
  limit?: number;
  offset?: number;
}

interface SrDetail extends SrPosting {
  postingUrl?: string;
  applyUrl?: string;
  jobAd?: {
    sections?: {
      companyDescription?: { title?: string; text?: string };
      jobDescription?: { title?: string; text?: string };
      qualifications?: { title?: string; text?: string };
      additionalInformation?: { title?: string; text?: string };
    };
  };
}

function listUrl(token: string, offset: number): string {
  return `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(token)}/postings?limit=${PAGE_SIZE}&offset=${offset}`;
}

function detailUrl(token: string, id: string): string {
  return `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(token)}/postings/${encodeURIComponent(id)}`;
}

/**
 * Concatenate the JD sections — but NOT `companyDescription`.
 *
 * companyDescription is identical boilerplate on every one of an employer's
 * postings ("Visa is a world leader in digital payments…"). Including it would
 * (a) inflate the JD-length quality score uniformly, making a one-line req look
 * as substantial as a real one, and (b) pollute keyword matching, so a search for
 * "payments" matches all 900 Visa jobs regardless of what they are.
 */
function buildJd(detail: SrDetail | null): { text: string; html: string | null } {
  const s = detail?.jobAd?.sections;
  if (!s) return { text: "", html: null };
  const htmlParts = [s.jobDescription?.text, s.qualifications?.text, s.additionalInformation?.text]
    .filter((t): t is string => !!t && t.trim().length > 0);
  return {
    text: joinJd(htmlParts.map((h) => decodeThenHtmlToText(h))),
    html: htmlParts.length ? htmlParts.join("\n") : null,
  };
}

function num(v: string | number | undefined | null): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

function toRawJob(board: AtsBoard, p: SrPosting, detail: SrDetail | null): RawJob {
  const loc = p.location;
  const locationRaw =
    loc?.fullLocation ||
    [loc?.city, loc?.region, loc?.country?.toUpperCase()].filter(Boolean).join(", ") ||
    null;
  const { text, html } = buildJd(detail);
  const id = p.id ?? p.uuid ?? "";

  return {
    source: "smartrecruiters",
    source_id: sourceId(board.token, id),
    source_url:
      detail?.postingUrl ??
      detail?.applyUrl ??
      // Budget-blown fallback: this URL shape is stable and resolves without the slug.
      (id ? `https://jobs.smartrecruiters.com/${board.token}/${id}` : null),
    company: p.company?.name ?? board.companyName ?? "",
    title: p.name ?? "",
    location_raw: locationRaw,
    // "" when the detail fetch was skipped by the budget. A title-only job is
    // still useful supply (title + company + location + lat/lng all survive), so
    // we keep it and let the caller decide — dropping it would throw away the
    // structured half of the richest provider we have.
    jd_text: text,
    jd_html: html,
    posted_at: safeIso(p.releasedDate),
    expires_at: null,
    salary_min: null,
    salary_max: null,
    salary_currency: null,
    department: p.department?.label ?? null,
    employment_type: canonEmploymentType(p.typeOfEmployment?.label),
    // `experienceLevel.id` is the machine value ("mid_senior_level"); the label is
    // the display string. Map from the id — labels are localised per board.
    seniority_hint: canonSeniority(p.experienceLevel?.id) ?? canonSeniority(p.experienceLevel?.label),
    job_function: p.function?.label ?? null,
    is_remote: typeof loc?.remote === "boolean" ? loc.remote : null,
    location_candidates: splitLocationCandidates(locationRaw),
    country_hint: toIso2(loc?.country),
    lat: num(loc?.latitude),
    lng: num(loc?.longitude),
    raw: detail ?? p,
  };
}

async function fetchAllPostings(
  token: string,
  cap: number,
  deadlineAt: number
): Promise<{ postings: SrPosting[]; truncated: boolean; error?: string }> {
  const postings: SrPosting[] = [];
  let offset = 0;
  let total = Infinity;
  let ranDry = false;

  while (postings.length < cap && offset < total) {
    if (Date.now() > deadlineAt) return { postings, truncated: true };

    const res = await httpJson<SrListResponse>(listUrl(token, offset));
    if (!res.ok || !res.data) {
      // Partial pages already collected are still good supply — return them with
      // the error rather than throwing the whole board away.
      return { postings, truncated: postings.length > 0, error: res.error ?? "unknown error" };
    }
    const page = Array.isArray(res.data.content) ? res.data.content : [];
    if (page.length === 0) {
      ranDry = true;
      break; // the real end-of-list signal
    }

    postings.push(...page);
    if (typeof res.data.totalFound === "number") total = res.data.totalFound;
    offset += page.length;
  }

  // `offset < total` alone is NOT truncation: totalFound is a live count, so a
  // posting closing mid-pagination leaves offset short of it on a board we pulled
  // in full. Truncation is only ever "we stopped early because we hit the cap".
  const truncated = !ranDry && postings.length >= cap && offset < total;
  return { postings: postings.slice(0, cap), truncated };
}

export const smartrecruitersProvider: AtsProviderImpl = {
  id: "smartrecruiters",

  async listJobs(board: AtsBoard, opts?: AtsPullOptions): Promise<AtsPullResult> {
    try {
      const deadlineAt = budgetDeadline(opts);
      const cap = jobCap(opts);

      const { postings, truncated: listTruncated, error } = await fetchAllPostings(board.token, cap, deadlineAt);
      if (postings.length === 0) {
        return { jobs: [], error: error ? `smartrecruiters ${board.token}: ${error}` : undefined };
      }

      // The N+1. Capped concurrency so we don't get rate-limited across thousands
      // of boards; hard deadline so a slow board can't hold the run hostage.
      const { results, timedOut } = await mapWithConcurrency(
        postings,
        DETAIL_CONCURRENCY,
        deadlineAt,
        async (p) => {
          const id = p.id ?? p.uuid;
          if (!id) return null;
          const res = await httpJson<SrDetail>(detailUrl(board.token, id));
          return res.ok ? res.data : null;
        }
      );

      const jobs = postings.map((p, i) => toRawJob(board, p, results[i]));
      return {
        jobs,
        boardCompanyName: postings[0]?.company?.name ?? board.companyName ?? null,
        // `truncated` here means "the JD half may be incomplete", not just
        // "more jobs exist". Both are things the caller must not treat as final.
        truncated: listTruncated || timedOut,
        error: error ? `smartrecruiters ${board.token}: ${error}` : undefined,
      };
    } catch (e) {
      return { jobs: [], error: `smartrecruiters ${board.token}: ${errMsg(e)}` };
    }
  },

  /**
   * ⚠️ SMARTRECRUITERS CANNOT TELL YOU A COMPANY DOESN'T EXIST.
   *
   * Verified live 2026-07-12:
   *     GET /v1/companies/zzz-not-a-real-company-xyz/postings?limit=1
   *     → HTTP 200 {"totalFound":0,"content":[]}
   * Byte-for-byte identical to a REAL employer with nothing open right now
   * (`Serco` returns exactly the same). It never 404s, and there is no company
   * endpoint to ask instead — /v1/companies/{id} 404s with an HTML page for
   * every token, valid or not.
   *
   * So the exists/empty distinction the AtsProvider contract asks for is
   * physically unavailable here, and we have to choose which way to be wrong:
   *
   *   exists:true on 0  → EVERY slug discovery ever guesses "resolves". The
   *                       registry fills with thousands of phantom boards, each
   *                       polled forever, and the zero-jobs health signal is
   *                       drowned. Unrecoverable.
   *   exists:false on 0 → we miss a genuine SmartRecruiters employer during a
   *                       window when they have no open roles. Self-healing:
   *                       discovery re-probes, and the moment they post a job
   *                       they resolve.
   *
   * The second is obviously right, so a 0 here means "unconfirmed", not "empty".
   * The error string says so, because a future reader WILL otherwise "fix" this
   * back to exists:true to satisfy the contract comment.
   */
  async probe(board: AtsBoard): Promise<AtsProbeResult> {
    try {
      // limit=1 — we only need existence + totalFound, never the page itself.
      const res = await httpJson<SrListResponse>(
        `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(board.token)}/postings?limit=1`
      );
      if (res.status === 404) return { exists: false, jobCount: 0 };
      if (!res.ok || !res.data) {
        return { exists: false, jobCount: 0, error: res.error ?? "unknown error" };
      }

      const count = res.data.totalFound ?? (res.data.content?.length ?? 0);
      if (count === 0) {
        return {
          exists: false,
          jobCount: 0,
          error:
            `smartrecruiters: token "${board.token}" returned 200 with totalFound:0. ` +
            `This API returns the SAME response for an unknown company and for a real ` +
            `company with no open roles, so existence cannot be confirmed. Treating as ` +
            `not-found (re-probe later — a real employer resolves the moment they post).`,
        };
      }

      return {
        exists: true,
        jobCount: count,
        boardCompanyName: res.data.content?.[0]?.company?.name ?? null,
      };
    } catch (e) {
      return { exists: false, jobCount: 0, error: errMsg(e) };
    }
  },

  detect(url: string): AtsBoard | null {
    const p = pathSegments(url);
    if (!p) return null;
    const { host, segs } = p;

    // api.smartrecruiters.com/v1/companies/{token}/postings
    if (host.endsWith("smartrecruiters.com") && segs[0] === "v1" && segs[1] === "companies" && segs[2]) {
      return { provider: "smartrecruiters", token: segs[2] };
    }
    // jobs.smartrecruiters.com/{token}[/{id}-{slug}]
    // careers.smartrecruiters.com/{token}
    if (host.endsWith("smartrecruiters.com") && segs[0]) {
      return { provider: "smartrecruiters", token: segs[0] };
    }
    return null;
  },

  candidateTokens(companyName: string): string[] {
    // ⚠️ SmartRecruiters identifiers are CASE-SENSITIVE and usually PascalCase
    // ("Visa", "Bosch", "PublicisGroupe") — a lowercase "visa" 404s. Try the
    // cased forms FIRST; the lowercase slugs stay as a fallback because some
    // tenants really are lowercase.
    const words = companyName
      .replace(/\b(ltd|limited|plc|llp|inc|corp|group|holdings)\b/gi, " ")
      .replace(/[^A-Za-z0-9]+/g, " ")
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    if (words.length === 0) return [];

    const pascal = words.map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase()).join("");
    const asWritten = words.join("");
    const out = [pascal, asWritten, ...slugCandidates(companyName)];
    const seen = new Set<string>();
    return out.filter((t) => t && !seen.has(t) && (seen.add(t), true));
  },
};
