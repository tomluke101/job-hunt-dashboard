// Remote-intent enforcement — the selection signal that keeps a search for a
// REMOTE role from filling up with office jobs scattered across the UK.
//
// The defect this fixes (SEARCH_QUALITY_BASELINE_2026-07-19, #3): "Head of
// Finance / remote" returned Wokingham, Liverpool, Westminster and London
// office roles at on-target 0%; "Data Analyst / remote" surfaced Manchester,
// Leicester and Northampton office-based roles the judge marked "not remote".
//
// The mechanism of the leak: the pipeline's working_model hard filter already
// drops a job whose model is a KNOWN non-accepted value (office/hybrid). But a
// town-anchored office role whose JD never literally says "office-based" is
// classified "unknown" (see detectWorkingModel in normalise.ts), and
// include_unknown — which defaults TRUE so honest gaps aren't silently deleted —
// waves it straight through. So a "remote" search fills with office roles that
// were never positively office, just never positively remote either.
//
// Two pieces, split the same way the codebase already splits working_model:
//
//   1. wantsRemote() — the intent detector. TRUE only when the user accepts
//      remote AND has de-selected office. The default search accepts all three
//      models, so a plain London/Leeds search is completely untouched; the
//      enforcement fires only once the user has actually said "not office".
//
//   2. isRemoteEligible() — used as the gate that decides whether an
//      unknown-model job keeps its include_unknown pass (pipeline.ts), AND as
//      the trigger for the ranking bonus below. A job is remote-eligible when
//      something POSITIVELY marks it remote and it is not positively non-UK.
//
// remoteAlignment() is the ranking half (the hard filter lives in pipeline.ts):
// a bounded, EXPLAINED bonus that floats a confirmed-remote job above a
// same-composite hybrid or merely-ambiguous one. Pure — never a filter.

import { isRemoteText, type JobLocation } from "@/lib/geo";
import type { NormalisedJob } from "./normalise";
import type { SearchCriteria } from "./types";

/**
 * Does this search express REMOTE intent? TRUE when the user accepts remote work
 * and has de-selected office-based.
 *
 * The default search accepts all three models (remote + hybrid + office) — that
 * is NOT remote intent, and this returns false, so a plain distance search is
 * never affected. Only once the user removes "Office-based" (leaving remote, or
 * remote + hybrid) do we read it as "I want to work from home" and enforce it.
 * That mirrors exactly what the editor writes: picking the Remote chip sets
 * accepted = ["remote"]; un-ticking Office gives ["remote","hybrid"].
 */
export function wantsRemote(criteria: SearchCriteria): boolean {
  const accepted = criteria.working_model?.accepted ?? [];
  return accepted.includes("remote") && !accepted.includes("office");
}

/**
 * Is this job POSITIVELY remote? Used two ways in a remote-intent search: as the
 * gate that decides whether an unknown-working-model job keeps its
 * include_unknown pass (a town-anchored office role fails it), and as the trigger
 * for the ranking bonus that floats confirmed-remote jobs to the top.
 *
 * A positively non-UK role (loc.is_foreign) is never remote-eligible for a UK
 * search — "Remote (US)" and an Apeldoorn HQ are both wrong answers to a UK
 * remote search. Beyond that, ANY of: the geo layer flagged the location remote
 * (home-based / wfh / distributed / anywhere), the JD-derived working model is
 * remote, the provider flagged it remote, or the raw location/title carries a
 * remote token. Generous on purpose — the point is to strip office roles, not to
 * demand a specific phrasing and accidentally drop a genuine remote job.
 */
export function isRemoteEligible(job: NormalisedJob, loc: JobLocation | undefined): boolean {
  if (loc?.is_foreign) return false;
  if (loc?.is_remote === true) return true;
  if (job.working_model === "remote") return true;
  if (job.is_remote === true) return true;
  return isRemoteText(`${job.location_raw ?? ""} ${job.title ?? ""}`);
}

// Peer of the base-title exact bonus (10) and the must-have bonus (3 each / 9
// max): big enough to float a confirmed-remote job above a same-composite hybrid
// or ambiguous one, small enough that a much better match on the other axes still
// wins. Applied post-blend at full strength, like the other selection nudges.
const REMOTE_CONFIRMED_BONUS = 10;

export interface RemoteAlignment {
  /** Points added to the composite (0 unless the search wants remote). */
  adjustment: number;
  /** Whether the search asked for remote at all — the bonus only applies if so. */
  wants: boolean;
  /** Whether this job is positively remote (isRemoteEligible). */
  confirmed: boolean;
  remote_bonus: number;
}

/**
 * Ranking half of the remote-intent fix. Pure and cheap (flag + regex work, no
 * I/O) so it runs per-candidate at ranking time. No effect at all unless the
 * search expresses remote intent — for every other search this returns a zero
 * adjustment and changes nothing.
 */
export function remoteAlignment(
  job: NormalisedJob,
  loc: JobLocation | undefined,
  criteria: SearchCriteria
): RemoteAlignment {
  if (!wantsRemote(criteria)) {
    return { adjustment: 0, wants: false, confirmed: false, remote_bonus: 0 };
  }
  const confirmed = isRemoteEligible(job, loc);
  const bonus = confirmed ? REMOTE_CONFIRMED_BONUS : 0;
  return { adjustment: bonus, wants: true, confirmed, remote_bonus: bonus };
}
