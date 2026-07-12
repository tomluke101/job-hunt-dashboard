// Pick the best Companies House candidate for a normalised search input.
//
// Ambiguity is a real risk: "Tesco" matches 3+ Tesco entities in CH; "Innovative
// Software Solutions" matches ~100. The scorer:
//   - Prefers exact normalised name matches
//   - Prefers active companies over dissolved
//   - Rewards startswith / substring matches on a sliding scale
//   - Flags AMBIGUOUS when the top two candidates are within threshold, so
//     the enrichment row keeps the top-3 in `candidates` JSONB for later.

import type { CHSearchCandidate } from "./types";
import { normaliseCompanyName } from "./normalise-company";

const STATUS_BONUS: Record<string, number> = {
  active: 20,
  dissolved: -25,
  liquidation: -15,
  "converted-closed": -25,
  "receiver-action": -10,
};

const AMBIGUITY_THRESHOLD = 12;   // if top1 - top2 <= this, mark ambiguous
const MIN_ACCEPT_SCORE = 40;      // below this, no candidate is good enough

export type MatchOutcome =
  | { type: "matched"; winner: CHSearchCandidate; score: number }
  | { type: "ambiguous"; candidates: CHSearchCandidate[] }
  | { type: "unmatched" };

function scoreCandidate(target: string, cand: CHSearchCandidate): number {
  const candNorm = normaliseCompanyName(cand.title);
  if (!candNorm) return 0;

  let s = 0;
  if (candNorm === target) s += 100;
  else if (candNorm.startsWith(target + " ")) s += 65;
  else if (candNorm.endsWith(" " + target)) s += 55;
  else if (candNorm.includes(" " + target + " ")) s += 45;
  else if (candNorm.includes(target)) s += 35;
  else if (target.includes(candNorm)) s += 30;
  else {
    // No overlap on the normalised names → very unlikely to be the same entity.
    return 0;
  }

  s += STATUS_BONUS[cand.company_status ?? ""] ?? 0;

  // Age bonus — older companies are less likely to be shells.
  if (cand.date_of_creation) {
    const ageYears = (Date.now() - new Date(cand.date_of_creation).getTime()) / (365.25 * 86400_000);
    if (ageYears > 15) s += 6;
    else if (ageYears > 5) s += 3;
  }

  return s;
}

/**
 * Rank all CH search candidates by name-match confidence, best-first.
 * Used by the service layer to walk top-N candidates and prefer the one
 * that turns out to be an operating entity after profile fetch (dormant
 * holding companies rank high on exact name but shouldn't win).
 */
export function rankCandidatesByName(
  normalisedTarget: string,
  candidates: CHSearchCandidate[]
): CHSearchCandidate[] {
  return candidates
    .map((c) => ({ c, s: scoreCandidate(normalisedTarget, c) }))
    .filter((x) => x.s >= MIN_ACCEPT_SCORE)
    .sort((a, b) => b.s - a.s)
    .map((x) => x.c);
}

export function pickBestMatch(
  normalisedTarget: string,
  candidates: CHSearchCandidate[]
): MatchOutcome {
  if (!candidates.length) return { type: "unmatched" };

  const scored = candidates
    .map((c) => ({ c, s: scoreCandidate(normalisedTarget, c) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s);

  if (!scored.length || scored[0].s < MIN_ACCEPT_SCORE) {
    return { type: "unmatched" };
  }

  if (scored.length > 1 && scored[0].s - scored[1].s <= AMBIGUITY_THRESHOLD) {
    // Ambiguous — keep top 3 so a future disambiguation step can revisit.
    return { type: "ambiguous", candidates: scored.slice(0, 3).map((x) => x.c) };
  }

  return { type: "matched", winner: scored[0].c, score: scored[0].s };
}
