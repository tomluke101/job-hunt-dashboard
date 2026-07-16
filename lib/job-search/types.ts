// Canonical Job Search types. Shared by adapters, pipeline, actions, UI.
// See project_hunthq_job_search_plan_2026_07_01.md for the design.

// Type-only — erased at compile, so this does NOT create a runtime import cycle
// with classify.ts (which imports RawJob back from here, also type-only).
import type { JobType, Seniority, JobFunction } from "./classify";

export type SourceType =
  | "reed"
  | "adzuna"
  // ATS-direct (first-party, straight from the employer's own board).
  | "greenhouse"
  | "lever"
  | "ashby"
  | "smartrecruiters"
  | "recruitee"
  | "workday"
  | "workable"
  // The universal reader: schema.org JobPosting JSON-LD scraped from the
  // employer's OWN careers site. Still first-party — the employer authored the
  // markup so Google for Jobs could index it; we read the same markup.
  | "jsonld"
  | "apify_linkedin"
  | "apify_indeed"
  | "agent";

/**
 * Sources that are ATS-direct: the posting came from the employer's own
 * applicant-tracking system, so the employer IS the poster. No recruiter can
 * appear here by construction — which is the whole point.
 */
export const ATS_SOURCES: readonly SourceType[] = [
  "greenhouse", "lever", "ashby", "smartrecruiters", "recruitee", "workday", "workable",
  "jsonld",
] as const;

export function isAtsSource(s: SourceType): boolean {
  return ATS_SOURCES.includes(s);
}

/**
 * Sources that do their OWN server-side radius search, so a posting they return
 * is already known to be near the user. Our post-pull distance filter therefore
 * KEEPS a job from these sources when its location can't be geocoded — the
 * source already vouched for it.
 *
 * ATS sources vouch for nothing: they hand back the company's entire global
 * board. An unresolvable ATS location must be DROPPED, or "within 25 miles of
 * Birmingham" starts returning Palo Alto.
 */
export const TRUSTED_RADIUS_SOURCES: readonly SourceType[] = ["reed", "adzuna"] as const;

export function hasTrustedRadius(s: SourceType): boolean {
  return TRUSTED_RADIUS_SOURCES.includes(s);
}

export type WorkingModel = "remote" | "hybrid" | "office" | "unknown";
export type FilterableWorkingModel = "remote" | "hybrid" | "office";

export type ShortlistState =
  | "new"
  | "interested"
  | "applied"
  | "rejected_user"
  | "rejected_employer"
  | "deleted";

export interface RawJob {
  source: SourceType;
  source_id: string;
  source_url: string | null;
  company: string;
  title: string;
  location_raw: string | null;
  jd_text: string;
  jd_html: string | null;
  posted_at: string | null;
  expires_at: string | null;
  salary_min: number | null;
  salary_max: number | null;
  salary_currency: string | null;
  raw?: unknown;

  // ---- ATS-direct extras -------------------------------------------------
  // Aggregators leave these null; every one of them is data Reed and Adzuna
  // simply do not give us. Captured at INGEST even though the filters that use
  // them (job type / seniority / job function) ship after supply — the cost of
  // storing them now is zero, and the cost of re-ingesting the whole corpus
  // later to backfill them is not.

  /** "Engineering", "Commercial", ... — the employer's own department name. */
  department?: string | null;
  /** Canonicalised from the provider's native field, never guessed from text. */
  employment_type?: string | null;
  /** Canonicalised seniority where the provider states it (SmartRecruiters, Recruitee). */
  seniority_hint?: string | null;
  /** SmartRecruiters gives a real job-function taxonomy. */
  job_function?: string | null;

  /** The provider explicitly flags this as a remote role. */
  is_remote?: boolean | null;
  /**
   * A single posting can list SEVERAL locations — Monzo's Greenhouse board says
   * "Cardiff, London or Remote (UK)". Splitting that into candidates matters: a
   * Cardiff user and a London user should BOTH match this job. Collapsing it to
   * one location silently hides the role from one of them.
   */
  location_candidates?: string[];
  /** ISO-2 where the provider tells us outright (Workday, SmartRecruiters, Ashby). */
  country_hint?: string | null;
  /** SmartRecruiters ships lat/lng on every posting — no geocoding needed. */
  lat?: number | null;
  lng?: number | null;
}

export interface JobSourceAdapter {
  type: SourceType;
  pull(input: PullInput): Promise<PullResult>;
}

export interface PullInput {
  keywords: string;
  locationText: string | null;
  postcode: string | null;
  radiusMiles: number | null;
  minSalary: number | null;
  maxSalary: number | null;
  limit: number;
  sinceDate: string | null;
}

export interface PullResult {
  jobs: RawJob[];
  error?: string;
}

export type LocationFilterMode = "distance" | "commute" | "anywhere";
export type CommuteMode = "car" | "public_transport" | "cycle";

// Company-size buckets (rough headcount bands). Enrichment layer maps each
// posting's employer to one of these via Companies House data.
//   startup     1-20       small     21-100       mid    101-500
//   large     501-5000     enterprise 5000+       unknown  no data / dormant
export type SizeBucket = "startup" | "small" | "mid" | "large" | "enterprise" | "unknown";
export type FilterableSizeBucket = Exclude<SizeBucket, "unknown">;
export const SIZE_BUCKET_LABELS: Record<FilterableSizeBucket, string> = {
  startup: "Startup (1-20)",
  small: "Small (21-100)",
  mid: "Mid (101-500)",
  large: "Large (501-5,000)",
  enterprise: "Enterprise (5,000+)",
};
export const SIZE_BUCKET_ORDER: FilterableSizeBucket[] = [
  "startup", "small", "mid", "large", "enterprise",
];

// User-facing search criteria (persisted as JSONB on job_searches.criteria).
export interface SearchCriteria {
  location: {
    postcode: string | null;
    filter_mode: LocationFilterMode;
    max_distance_miles: number | null;
    max_commute_minutes: number | null;
    commute_mode: CommuteMode;
    willing_to_relocate: boolean;
    accepted_regions: string[];
    fallback_radius_miles: number | null;
  };
  working_model: {
    accepted: FilterableWorkingModel[];
    max_office_days: number | null;
    include_unknown: boolean;
  };
  salary: {
    floor: number | null;
    target: number | null;
    currency: "GBP" | "EUR" | "USD";
    drop_hidden_salary: boolean;
  };
  // --- The three dimension filters (job type / seniority / job function) ---
  //
  // All three share the {accepted, include_unknown} shape already used by
  // company_size and working_model. `accepted: []` means "no filter" — identical to
  // ticking every box — so a fresh search never silently narrows.
  //
  // ⚠️ include_unknown DEFAULTS TO TRUE, DELIBERATELY. Not every job states its
  // seniority, and not every source gives us one: Reed and Adzuna supply NOTHING on
  // any of these three dimensions. classify.ts derives what it honestly can from the
  // title and JD and returns null when the signal genuinely isn't there. Defaulting
  // include_unknown to FALSE would mean the moment a user ticks "Full-time", every
  // job we couldn't classify vanishes with no explanation — the same silent-drop
  // failure as the title filter that binned every "Supply Chain Analyst" for a
  // fortnight. The user can still turn it off; the run stats report exactly how many
  // each filter dropped (filter_drops), so it is never invisible.
  //
  // NOTE: `seniority` was previously `string[]` and was DEAD — declared on the type
  // and read by nothing. Old saved searches still hold an array in this slot, so the
  // pipeline reads it through readDimensionFilter(), which tolerates both shapes.
  job_type: DimensionFilter<JobType>;
  seniority: DimensionFilter<Seniority>;
  job_function: DimensionFilter<JobFunction>;

  industries_include: string[];
  industries_exclude: string[];
  // Company-size filter — explicit, additive to AI (never replaced by AI
  // inference). Empty accepted list is treated as "no filter" — same behaviour
  // as ticking all five buckets. Enrichment layer maps every posting to one
  // of the buckets before this filter runs.
  company_size: {
    accepted: FilterableSizeBucket[];
    include_unknown: boolean;   // postings without enrichment yet
  };
  // Hide postings whose employer looks like a recruitment agency (matched by
  // Companies House SIC 78* OR a curated agency name pattern). Default off
  // because plenty of users are happy to see recruiter-posted roles.
  hide_recruiters: boolean;
  // Explicit role types the user is hunting for, e.g. ["supply chain analyst",
  // "procurement analyst", "buyer"]. A job passes the title-relevance filter
  // if its title matches the CORE NOUN of ANY entry here. Empty = fall back
  // to core-noun of `keywords`/search-name.
  target_titles: string[];
  keywords: string;
  extra: string | null;
  // Populated by the AI parser on save when the user has written a
  // description. Structured intent used by the pipeline in addition to
  // heuristic extraction. See lib/job-search/ai-parse.ts.
  ai_parsed?: AIParsedCriteria | null;
}

/**
 * A multi-select filter over one classified dimension.
 * `accepted: []` = no filter (same as everything ticked).
 */
export interface DimensionFilter<T extends string> {
  accepted: T[];
  include_unknown: boolean;
}

/**
 * Read a dimension filter out of stored criteria, tolerating the legacy shape.
 *
 * `criteria.seniority` used to be a bare `string[]` (and was never read by
 * anything). Searches saved before this change still have an ARRAY sitting in that
 * slot, and `(["senior"]).accepted` is `undefined` — which would quietly become "no
 * filter" and, worse, `include_unknown: undefined` → falsy → a filter that drops
 * every unclassified job. Reading it through here makes the old shape mean exactly
 * what it always meant: nothing.
 */
export function readDimensionFilter<T extends string>(
  raw: DimensionFilter<T> | T[] | null | undefined
): { accepted: Set<T>; includeUnknown: boolean } {
  if (Array.isArray(raw) || !raw) {
    return { accepted: new Set<T>(), includeUnknown: true };
  }
  return {
    accepted: new Set(raw.accepted ?? []),
    includeUnknown: raw.include_unknown ?? true,
  };
}

// Re-exported so callers configuring these filters don't need to reach into
// classify.ts for the value sets.
export type { JobType, Seniority, JobFunction } from "./classify";
export { JOB_TYPES, SENIORITIES, JOB_FUNCTIONS } from "./classify";

export interface AIParsedCriteria {
  role_types: string[];
  seniority: "entry" | "graduate" | "junior" | "mid" | "senior" | "lead" | "director" | null;
  industries_avoid: string[];
  must_haves: string[];
  deal_breakers: string[];
  working_model: "remote" | "hybrid" | "office" | null;
  location_hint: string | null;
  salary_floor: number | null;
  salary_target: number | null;
  summary: string;
}

// Per-criterion importance (persisted as JSONB on job_searches.weights).
// 0 = ignore, 0.5 = prefer, 1.0 = essential (hard filter).
export interface CriteriaWeights {
  location: number;
  working_model: number;
  salary: number;
  seniority: number;
  industries: number;
  keywords: number;
}

export const DEFAULT_CRITERIA: SearchCriteria = {
  location: {
    postcode: null,
    filter_mode: "distance",
    max_distance_miles: 25,
    max_commute_minutes: null,
    commute_mode: "car",
    willing_to_relocate: false,
    accepted_regions: [],
    fallback_radius_miles: 25,
  },
  working_model: {
    accepted: ["remote", "hybrid", "office"],
    max_office_days: null,
    include_unknown: true,
  },
  salary: {
    floor: null,
    target: null,
    currency: "GBP",
    drop_hidden_salary: false,
  },
  // Empty `accepted` = no filter. A brand-new search must never silently narrow the
  // corpus before the user has asked for anything.
  job_type: { accepted: [], include_unknown: true },
  seniority: { accepted: [], include_unknown: true },
  job_function: { accepted: [], include_unknown: true },
  industries_include: [],
  industries_exclude: [],
  company_size: {
    accepted: [...SIZE_BUCKET_ORDER],   // all five buckets accepted by default
    include_unknown: true,               // don't drop postings while enrichment catches up
  },
  hide_recruiters: false,
  target_titles: [],
  keywords: "",
  extra: null,
};

export const DEFAULT_WEIGHTS: CriteriaWeights = {
  location: 1.0,
  working_model: 1.0,
  salary: 1.0,
  seniority: 0.5,
  industries: 0.5,
  keywords: 1.0,
};

export const DEFAULT_RANKING_WEIGHTS = {
  match_to_search: 0.4,
  match_to_user: 0.3,
  quality: 0.2,
  career_fit: 0.1,
};
