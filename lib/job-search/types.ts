// Canonical Job Search types. Shared by adapters, pipeline, actions, UI.
// See project_hunthq_job_search_plan_2026_07_01.md for the design.

export type SourceType =
  | "reed"
  | "adzuna"
  | "greenhouse"
  | "lever"
  | "ashby"
  | "apify_linkedin"
  | "apify_indeed"
  | "agent";

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
  seniority: string[];
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
  seniority: [],
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
