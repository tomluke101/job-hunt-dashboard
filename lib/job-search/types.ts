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

// User-facing search criteria (persisted as JSONB on job_searches.criteria).
export interface SearchCriteria {
  location: {
    postcode: string | null;
    max_commute_minutes: number | null;
    commute_mode: "car" | "public_transport";
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
  // Explicit role types the user is hunting for, e.g. ["supply chain analyst",
  // "procurement analyst", "buyer"]. A job passes the title-relevance filter
  // if its title matches the CORE NOUN of ANY entry here. Empty = fall back
  // to core-noun of `keywords`/search-name.
  target_titles: string[];
  keywords: string;
  extra: string | null;
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
