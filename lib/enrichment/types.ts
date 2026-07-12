// Companies House enrichment — shared types.
// See project_hunthq_job_search_plan_2026_07_01.md + reference_api_keys_hunthq.md.

export type SizeBucket =
  | "startup"       // 1-20 headcount (rough)
  | "small"         // 21-100
  | "mid"           // 101-500
  | "large"         // 501-5000
  | "enterprise"    // 5000+
  | "unknown";      // no data / dissolved / unmatched

export type SizeConfidence = "high" | "medium" | "low";

export type EnrichmentStatus =
  | "pending"       // row exists, enrichment not yet attempted
  | "matched"       // one clean Companies House hit
  | "ambiguous"     // multiple candidates within tie threshold; top-3 stored in `candidates`
  | "unmatched"     // CH returned nothing useful; row exists so we don't re-query
  | "error";        // network / 5xx / parsing error; retry on next run

// Companies House REST API response shapes (subset of fields we consume).
export interface CHSearchCandidate {
  company_number: string;
  title: string;
  company_status?: string;      // active / dissolved / liquidation / ...
  company_type?: string;        // ltd / plc / llp / ...
  date_of_creation?: string;    // YYYY-MM-DD
  address?: Record<string, unknown>;
  description?: string;
}

export interface CHCompanyProfile {
  company_number: string;
  company_name: string;
  company_status: string;
  type: string;
  date_of_creation?: string;
  sic_codes?: string[];
  accounts?: {
    next_due?: string;
    last_accounts?: {
      made_up_to?: string;
      // Statutory accounts category — the ground-truth size signal.
      // See UK Companies Act thresholds:
      //   micro-entity  turnover <= £632k / balance <= £316k / <= 10 employees
      //   small         turnover <= £10.2m / balance <= £5.1m / <= 50 employees
      //   medium        turnover <= £36m / balance <= £18m / <= 250 employees
      //   full / group  exceeds medium thresholds (250+ employees minimum)
      //   dormant       not trading
      type?: string;
    };
  };
  registered_office_address?: Record<string, unknown>;
}

export interface CHOfficersSummary {
  total_results?: number;
  active_count?: number;
  inactive_count?: number;
  resigned_count?: number;
}

// A row from the `company_enrichment` Supabase table.
export interface EnrichmentRow {
  id: string;
  normalised_name: string;
  raw_names: string[];

  ch_company_number: string | null;
  ch_company_name: string | null;
  ch_company_status: string | null;
  ch_company_type: string | null;
  ch_date_of_creation: string | null;
  ch_sic_codes: string[];
  ch_officers_active_count: number | null;
  ch_officers_total_count: number | null;
  ch_accounts_next_due: string | null;
  ch_accounts_last_made_up_to: string | null;
  ch_accounts_type: string | null;
  ch_employee_count: number | null;
  ch_employee_count_period_end: string | null;
  ch_employee_count_source_url: string | null;
  ch_employee_count_status: string | null;
  // Where the employee count came from: 'xbrl' (parsed from a Companies House
  // accounts filing) or 'llm-haiku' (high-confidence model answer). Null when
  // we have no count. `reasoning` carries the source URL for xbrl, the model's
  // one-line justification for llm-haiku, or the decline reason when the model
  // wasn't confident enough to trust.
  ch_employee_count_source: string | null;
  ch_employee_count_reasoning: string | null;
  ch_registered_address: Record<string, unknown> | null;

  size_bucket: SizeBucket | null;
  size_confidence: SizeConfidence | null;
  // How the band was decided: 'xbrl' (real filed headcount), 'llm-band'
  // (brand-level model answer, used when no filing discloses a count), or
  // 'llm-band-override' (a filing existed but disagreed with the brand by 2+
  // bands, meaning Companies House matched the wrong entity). Null = unknown.
  size_source: string | null;
  size_reasoning: string | null;
  is_likely_recruiter: boolean;
  recruiter_reason: string | null;

  enrichment_status: EnrichmentStatus;
  enrichment_error: string | null;
  candidates: unknown[] | null;

  first_enriched_at: string | null;
  last_refreshed_at: string | null;
  refresh_count: number;

  created_at: string;
  updated_at: string;
}

// The subset the pipeline / UI actually needs (id + status + derived signals).
export type EnrichmentAttachment = Pick<
  EnrichmentRow,
  "id" | "enrichment_status" | "size_bucket" | "size_confidence" |
  "is_likely_recruiter" | "recruiter_reason" | "ch_sic_codes" |
  "ch_company_number" | "ch_company_name"
>;
