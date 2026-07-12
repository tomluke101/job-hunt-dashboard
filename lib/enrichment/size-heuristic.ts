// Size-bucket derivation — strict, employee-count-only.
//
// The single input that decides a bucket is the actual employee count. If we
// don't know the count, the bucket is `unknown` — never inferred from
// accounts-filing category, officer roster size, entity age, or entity type.
//
// Reasoning: heuristic proxies are consistently wrong on real UK job data.
// Draper Tools files `full` accounts and is 100+ years old with 7 active
// officers → old heuristic bucketed it as `enterprise`. Actual headcount is
// ~350, which is `mid`. Aldi Stores files paper accounts → old heuristic
// used officer counts to guess enterprise (correct by luck) but no
// verifiable number was returned. Wrong data is worse than no data.
//
// Employee counts arrive from two sources upstream, in preference order:
//   1. iXBRL parsed from Companies House accounts filings (real, cited)
//   2. Claude Haiku 4.5 answering from training knowledge, but only when it
//      reports "high" confidence (rejects everything softer to avoid
//      hallucinated numbers reaching the size filter).
//
// Both sources arrive as an integer or null. The heuristic below does nothing
// but bucket the integer.

import type { SizeBucket, SizeConfidence } from "./types";

export interface SizeInputs {
  employeeCount: number | null;
  companyStatus: string | null;    // 'active' / 'dissolved' / ...
  // Retained for the row payload (still stored in DB, still shown to the
  // user in the debug page and job-card tooltip) but no longer influences
  // bucket assignment. Set from CH data; may be undefined when unknown.
  activeOfficers?: number | null;
  totalOfficers?: number | null;
  ageYears?: number | null;
  companyType?: string | null;
  accountsType?: string | null;
}

/**
 * Bucket thresholds match Tom's punch-list category labels exactly:
 *   startup     1-20
 *   small       21-100
 *   mid         101-500
 *   large       501-5000
 *   enterprise  5000+
 *   unknown     no employee count available OR company not currently trading
 */
function bucketFromCount(count: number): SizeBucket {
  if (count <= 20) return "startup";
  if (count <= 100) return "small";
  if (count <= 500) return "mid";
  if (count <= 5000) return "large";
  return "enterprise";
}

export function deriveSize(inp: SizeInputs): { bucket: SizeBucket; confidence: SizeConfidence } {
  // Not currently trading → we don't claim a size.
  if (inp.companyStatus && inp.companyStatus !== "active") {
    return { bucket: "unknown", confidence: "low" };
  }
  const emp = inp.employeeCount;
  if (emp === null || !Number.isFinite(emp) || emp <= 0) {
    return { bucket: "unknown", confidence: "low" };
  }
  return { bucket: bucketFromCount(emp), confidence: "high" };
}

export function ageInYears(dateOfCreation: string | null | undefined): number | null {
  if (!dateOfCreation) return null;
  const d = new Date(dateOfCreation);
  if (Number.isNaN(d.getTime())) return null;
  const ms = Date.now() - d.getTime();
  return ms / (365.25 * 24 * 3600 * 1000);
}

// ---- Legacy export retained for backward compatibility ----
// `accountsSizeRank` was used by the entity-picker in the match scorer to
// prefer larger operating entities among ambiguous candidates. Keep the
// export so the match scorer keeps compiling; the ranking still applies at
// the entity-picking layer, not the size-bucket layer.
export const ACCOUNTS_SIZE_RANK: Record<string, number> = {
  group: 6,
  full: 6,
  medium: 4,
  small: 3,
  "total-exemption-full": 3,
  "total-exemption-small": 3,
  "unaudited-abridged": 3,
  abridged: 3,
  "partial-exemption": 3,
  "audit-exemption-subsidiary": 3,
  "filing-exemption-subsidiary": 3,
  "micro-entity": 2,
  dormant: 0,
};

export function accountsSizeRank(accountsType: string | null | undefined): number {
  const t = (accountsType ?? "").toLowerCase().trim();
  if (!t) return 1;
  return ACCOUNTS_SIZE_RANK[t] ?? 1;
}
