// Adzuna adapter. Docs: https://developer.adzuna.com/docs/search
// Auth: app_id + app_key as query params.
// Free tier: 1000 calls/day. Region: `gb` for UK.
//
// Multi-role searches — a keyword string like
// "Supply Chain Analyst, Procurement Analyst, Buyer" — fan out to ONE API
// call per role phrase. Adzuna's default `what` is loose-AND (every word must
// appear), which precision-matches each role. Merging with `what_or` doesn't
// work — it broad-matches on single words ("chain", "buyer") and swamps the
// title-relevance filter with garbage. Per-role AND is the right shape.

import type { JobSourceAdapter, PullInput, PullResult, RawJob } from "../types";
import { htmlToText } from "../html-to-text";
import { resolvePlaceName } from "../postcode";

const ADZUNA_BASE = "https://api.adzuna.com/v1/api/jobs/gb/search";
const MAX_PER_PAGE = 50;
const MAX_ROLES_PER_RUN = 4;

interface AdzunaResult {
  id: string | number;
  title?: string;
  description?: string;
  company?: { display_name?: string };
  location?: { display_name?: string; area?: string[] };
  salary_min?: number;
  salary_max?: number;
  salary_is_predicted?: string | number;
  redirect_url?: string;
  created?: string;
  contract_time?: string;
  contract_type?: string;
  category?: { label?: string; tag?: string };
}

interface AdzunaSearchResponse {
  results?: AdzunaResult[];
  count?: number;
  __CLASS__?: string;
}

function creds(): { app_id: string; app_key: string } {
  const app_id = process.env.ADZUNA_APP_ID;
  const app_key = process.env.ADZUNA_APP_KEY;
  if (!app_id || !app_key) throw new Error("ADZUNA_APP_ID / ADZUNA_APP_KEY not set");
  return { app_id, app_key };
}

// Adzuna's `distance` param is in KILOMETRES. Convert from miles.
function milesToKm(miles: number | null): number | null {
  if (miles === null) return null;
  return Math.max(1, Math.round(miles * 1.609));
}

// Split a keyword string into distinct role phrases. Accepts commas, slashes,
// newlines, or ` and ` as separators — matches the tolerance rules the UI
// applies to `target_titles`. Cap to keep daily API quota sane.
function splitRoles(keywords: string): string[] {
  const parts = keywords
    .split(/[,/\n]+|\s+and\s+/gi)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const p of parts) {
    const k = p.toLowerCase();
    if (!seen.has(k)) {
      seen.add(k);
      unique.push(p);
    }
  }
  return unique.slice(0, MAX_ROLES_PER_RUN);
}

function buildParams(
  role: string,
  input: PullInput,
  perRoleLimit: number,
  app_id: string,
  app_key: string,
  // A PLACE NAME ("Birmingham"), never a postcode — see the note in fetchRole.
  place: string | null
): URLSearchParams {
  const params = new URLSearchParams();
  params.set("app_id", app_id);
  params.set("app_key", app_key);
  params.set("results_per_page", String(Math.min(perRoleLimit, MAX_PER_PAGE)));
  // `what` is loose-AND — every word of the role phrase must appear in the
  // job. Perfect for "Supply Chain Analyst" style multi-word role queries.
  // Omitted in browse mode so the pull is driven by location + salary alone.
  if (role.trim()) params.set("what", role);
  else params.set("sort_by", "date"); // browse mode — surface fresh listings
  if (place) {
    params.set("where", place);
    const distanceKm = milesToKm(input.radiusMiles);
    if (distanceKm !== null) params.set("distance", String(distanceKm));
  }
  if (input.minSalary !== null) params.set("salary_min", String(input.minSalary));
  if (input.maxSalary !== null) params.set("salary_max", String(input.maxSalary));
  return params;
}

async function fetchRole(
  role: string,
  input: PullInput,
  perRoleLimit: number,
  app_id: string,
  app_key: string,
  place: string | null
): Promise<{ results: AdzunaResult[]; error?: string }> {
  const params = buildParams(role, input, perRoleLimit, app_id, app_key, place);
  const url = `${ADZUNA_BASE}/1?${params.toString()}`;
  let res: Response;
  try {
    res = await fetch(url, { cache: "no-store" });
  } catch (e) {
    return { results: [], error: `Adzuna network error (${role}): ${String(e)}` };
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return { results: [], error: `Adzuna ${res.status} (${role}): ${body.slice(0, 200)}` };
  }
  const body = (await res.json()) as AdzunaSearchResponse;
  return { results: body.results ?? [] };
}

function toRawJob(r: AdzunaResult): RawJob {
  const desc = r.description ?? "";
  // Adzuna flags `salary_is_predicted: "1"` when the range is Adzuna's own
  // estimate, NOT from the JD. Treat as hidden-salary so quality scoring +
  // hidden-salary filter aren't misled by fake precision.
  const predicted = String(r.salary_is_predicted ?? "0") === "1";
  return {
    source: "adzuna",
    source_id: String(r.id),
    source_url: r.redirect_url ?? null,
    company: r.company?.display_name ?? "",
    title: r.title ?? "",
    location_raw: r.location?.display_name ?? null,
    jd_text: htmlToText(desc),
    jd_html: desc,
    posted_at: r.created ? safeIso(r.created) : null,
    expires_at: null,
    salary_min: predicted ? null : (r.salary_min ?? null),
    salary_max: predicted ? null : (r.salary_max ?? null),
    salary_currency: "GBP",

    // Adzuna has ALWAYS returned these three, and we have always thrown them away —
    // which is why every Adzuna job in the corpus reads as "job type: unknown".
    //
    //   contract_time  "full_time" | "part_time"     — the HOURS
    //   contract_type  "permanent" | "contract"      — the BASIS
    //   category.label "Logistics & Warehouse Jobs"  — Adzuna's own function taxonomy
    //
    // The basis is the scarcer signal and the one a user means when they tick
    // "Contract", so it goes first and classifyJobType()'s precedence resolves it.
    // See lib/job-search/classify.ts.
    employment_type: r.contract_type ?? r.contract_time ?? null,
    department: r.category?.label ?? null,
    raw: r,
  };
}

export const adzunaAdapter: JobSourceAdapter = {
  type: "adzuna",
  async pull(input: PullInput): Promise<PullResult> {
    const { app_id, app_key } = creds();

    // Adzuna cannot read a UK postcode. `where=B1 1AA` returns ZERO results for
    // every query — no error, just count: 0 — which is why this source silently
    // contributed nothing from the day it shipped while Reed (which does accept
    // postcodes) carried every pull. Resolve to a town name first.
    const rawLoc = input.locationText || input.postcode;
    let place: string | null = null;
    if (rawLoc) {
      place = await resolvePlaceName(rawLoc);
      if (!place) {
        // Do NOT fall back to a nationwide pull. The pipeline applies no
        // post-pull distance filter, so a location-less search would hand back
        // jobs 300 miles away to someone who asked for "within 25 miles".
        return {
          jobs: [],
          error: `adzuna: could not resolve "${rawLoc}" to a place name; skipping rather than searching the wrong area`,
        };
      }
    }

    const roles = splitRoles(input.keywords || "");
    // Browse mode — no keyword. Single pull with location + salary alone.
    const rolesToFetch = roles.length === 0 ? [""] : roles;
    const perRoleLimit = Math.max(10, Math.ceil(input.limit / rolesToFetch.length));

    const settled = await Promise.allSettled(
      rolesToFetch.map((role) => fetchRole(role, input, perRoleLimit, app_id, app_key, place))
    );

    const seen = new Set<string>();
    const jobs: RawJob[] = [];
    const errors: string[] = [];
    for (const s of settled) {
      if (s.status !== "fulfilled") {
        errors.push(String(s.reason));
        continue;
      }
      if (s.value.error) errors.push(s.value.error);
      for (const r of s.value.results) {
        const id = String(r.id);
        if (seen.has(id)) continue;
        seen.add(id);
        jobs.push(toRawJob(r));
      }
    }

    return errors.length ? { jobs, error: errors.join(" | ") } : { jobs };
  },
};

function safeIso(v: string): string | null {
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d.toISOString();
}
