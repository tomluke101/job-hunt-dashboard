// Reed adapter. Reed API docs: https://www.reed.co.uk/developers
// Auth: HTTP Basic with API key as username, empty password.
// Free tier: ~500 calls/day. Search returns TRUNCATED JD; /jobs/{id} returns full.

import type { JobSourceAdapter, PullInput, PullResult, RawJob } from "../types";
import { htmlToText } from "../html-to-text";

const REED_BASE = "https://www.reed.co.uk/api/1.0";

function auth(): string {
  const key = process.env.REED_API_KEY;
  if (!key) throw new Error("REED_API_KEY not set");
  return "Basic " + Buffer.from(`${key}:`).toString("base64");
}

interface ReedSearchResult {
  jobId: number;
  employerName: string;
  jobTitle: string;
  locationName?: string;
  minimumSalary?: number;
  maximumSalary?: number;
  currency?: string;
  jobDescription?: string;
  jobUrl?: string;
  date?: string;
  expirationDate?: string;
}

interface ReedJobDetail {
  jobDescription?: string;
  employerName?: string;
  jobTitle?: string;
  locationName?: string;
  minimumSalary?: number;
  maximumSalary?: number;
  currency?: string;
  jobUrl?: string;
  datePosted?: string;
  expirationDate?: string;
}

// Reed's date format is dd/mm/yyyy — parse defensively.
function parseReedDate(v: string | undefined): string | null {
  if (!v) return null;
  const uk = v.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (uk) {
    const iso = `${uk[3]}-${uk[2]}-${uk[1]}T00:00:00Z`;
    const d = new Date(iso);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d.toISOString();
}


async function fetchFullDetail(jobId: number, headers: HeadersInit): Promise<ReedJobDetail | null> {
  try {
    const res = await fetch(`${REED_BASE}/jobs/${jobId}`, { headers, cache: "no-store" });
    if (!res.ok) return null;
    return (await res.json()) as ReedJobDetail;
  } catch {
    return null;
  }
}

export const reedAdapter: JobSourceAdapter = {
  type: "reed",
  async pull(input: PullInput): Promise<PullResult> {
    const headers = { Authorization: auth() };

    const params = new URLSearchParams();
    if (input.keywords) params.set("keywords", input.keywords);
    const loc = input.locationText || input.postcode;
    if (loc) params.set("locationName", loc);
    if (input.radiusMiles) params.set("distanceFromLocation", String(input.radiusMiles));
    if (input.minSalary) params.set("minimumSalary", String(input.minSalary));
    if (input.maxSalary) params.set("maximumSalary", String(input.maxSalary));
    params.set("resultsToTake", String(Math.min(input.limit, 100)));

    const searchUrl = `${REED_BASE}/search?${params.toString()}`;
    let searchRes: Response;
    try {
      searchRes = await fetch(searchUrl, { headers, cache: "no-store" });
    } catch (e) {
      return { jobs: [], error: `Reed network error: ${String(e)}` };
    }
    if (!searchRes.ok) {
      const body = await searchRes.text().catch(() => "");
      return { jobs: [], error: `Reed ${searchRes.status}: ${body.slice(0, 200)}` };
    }

    const searchBody = (await searchRes.json()) as { results?: ReedSearchResult[] };
    const stubs = searchBody.results ?? [];
    if (stubs.length === 0) return { jobs: [] };

    // Full-JD fetch in parallel (Reed's search only returns truncated).
    const details = await Promise.all(stubs.map((s) => fetchFullDetail(s.jobId, headers)));

    const jobs: RawJob[] = stubs.map((s, i) => {
      const detail = details[i];
      const fullJd = detail?.jobDescription ?? s.jobDescription ?? "";
      return {
        source: "reed",
        source_id: String(s.jobId),
        source_url: s.jobUrl ?? `https://www.reed.co.uk/jobs/details/${s.jobId}`,
        company: s.employerName ?? "",
        title: s.jobTitle ?? "",
        location_raw: s.locationName ?? null,
        jd_text: htmlToText(fullJd),
        jd_html: fullJd,
        posted_at: parseReedDate(s.date),
        expires_at: parseReedDate(s.expirationDate),
        salary_min: s.minimumSalary ?? null,
        salary_max: s.maximumSalary ?? null,
        salary_currency: s.currency ?? "GBP",
        raw: s,
      };
    });

    return { jobs };
  },
};
