// Seniority-alignment + base-title precision — the selection signal that keeps a
// search for the PLAIN requested role from being buried under senior/specialist
// variants of it.
//
// The defect this fixes (SEARCH_QUALITY_BASELINE_2026-07-19, #2): "Marketing
// Manager" returned *Senior Procurement Category Manager - Marketing* at #1, then
// three *Senior Product Marketing Manager*s; "Data Analyst" returned Senior/Lead/
// Product Analyst variants; "Graduate Software Engineer" returned Senior/Staff/Lead
// engineers above the one trainee role. The semantic axis rewards JD similarity,
// which a "Senior X" JD has in abundance, and nothing pulled the plain title up.
//
// Two pure signals, applied as an EXPLAINED bonus after the semantic blend (the
// same place the must-have bonus rides), never as a filter — an over-senior job
// is demoted, not removed:
//
//   1. Seniority penalty — a job MORE senior than the level the user asked for
//      loses points proportional to how far above. "Unless the user asked senior":
//      the asked level is read from what the user actually searched (keywords /
//      the experience-level filter / the least-senior target chip), so a search
//      that IS for a senior/lead/director role penalises nothing at that level.
//
//   2. Base-title bonus — a job whose title, once seniority words are stripped,
//      IS the requested base role gets the full bonus; one that is the base role
//      plus a specialiser ("Product Marketing Manager" for "Marketing Manager")
//      gets a smaller bonus. This is what floats the exact plain title to the top
//      and keeps a specialist variant just beneath it rather than above it.
//
// Both reuse the SAME seniority classifier the rest of the pipeline classifies and
// displays jobs with (classify.ts) and the SAME stemmer/seniority-marker set the
// title filter uses (text.ts / title-match.ts), so the ranking seniority can never
// disagree with the one shown on the card.

import { SENIORITIES, classifySeniority, type Seniority } from "./classify";
import { SENIORITY_MARKERS } from "./title-match";
import { stemWord, titleContainsStem, TITLE_STOP } from "./text";
import { readDimensionFilter, type SearchCriteria } from "./types";

// --- Weights. Peers of MUST_HAVE_BONUS (3 each / 9 max): big enough to reorder a
//     cluster of near-tied composites, small enough that a genuinely better match
//     on the other axes still wins. Applied post-blend at full strength. ---
const BASE_EXACT_BONUS = 10;      // title == requested base role (seniority-stripped)
const BASE_SUPERSET_BONUS = 4;    // base role + a specialiser word
const OVER_PENALTY_PER_LEVEL = 6; // per seniority level above what was asked
const OVER_LEVELS_CAP = 3;        // cap the penalty at 3 levels (-18)

const SENIORITY_INDEX: Record<Seniority, number> = Object.fromEntries(
  SENIORITIES.map((s, i) => [s, i])
) as Record<Seniority, number>;

// A role with no seniority word ("Marketing Manager", "Data Analyst") is a real
// anchor, not "unknown": it sits at MID. Both an unmarked ASK and an unmarked JOB
// resolve here, so base-vs-base is a zero-gap match and a "Senior X" job is +1.
const BASE_INDEX = SENIORITIES.indexOf("mid");

// The AI parser uses a slightly coarser vocabulary than the classifier.
const AI_SENIORITY_MAP: Record<string, Seniority> = {
  entry: "entry",
  graduate: "entry",
  junior: "junior",
  mid: "mid",
  senior: "senior",
  lead: "lead",
  director: "director",
};

/** Seniority level of a free-text role phrase as an index, or null if unmarked. */
function levelIndexOf(text: string): number | null {
  const s = classifySeniority(text, "");
  return s ? SENIORITY_INDEX[s] : null;
}

/** Content words of a title/phrase, seniority words and stopwords stripped. */
function contentTokens(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !TITLE_STOP.has(w) && !SENIORITY_MARKERS.has(w));
}

const SPLIT_ROLES = /[,/\n]+|\s+and\s+/gi;
const IS_LIST = /[,/\n]|\band\b/i;

/**
 * The seniority level the user ASKED for, as an index, or null when there is no
 * signal at all (in which case nothing is penalised — never penalise on no
 * information). Priority: an explicit experience-level filter (they ticked exact
 * boxes) → the level of the keywords they searched (unmarked = MID, a real "I want
 * the plain role" anchor) → the least-senior target chip → the AI-parsed hint.
 */
function resolveAskedIndex(criteria: SearchCriteria): number | null {
  const filter = readDimensionFilter(criteria.seniority);
  if (filter.accepted.size) {
    let max = -1;
    for (const s of filter.accepted) max = Math.max(max, SENIORITY_INDEX[s as Seniority] ?? -1);
    if (max >= 0) return max; // penalise only ABOVE the highest level they accept
  }

  const kw = (criteria.keywords ?? "").trim();
  if (kw && !IS_LIST.test(kw)) return levelIndexOf(kw) ?? BASE_INDEX;

  const roles = (criteria.target_titles?.length
    ? criteria.target_titles
    : kw.split(SPLIT_ROLES)
  )
    .map((t) => t.trim())
    .filter(Boolean);
  if (roles.length) {
    let min = Infinity;
    for (const r of roles) min = Math.min(min, levelIndexOf(r) ?? BASE_INDEX);
    if (Number.isFinite(min)) return min;
  }

  const ai = criteria.ai_parsed?.seniority;
  if (ai && AI_SENIORITY_MAP[ai]) return SENIORITY_INDEX[AI_SENIORITY_MAP[ai]];

  return null;
}

/**
 * The single BASE role phrase the bonus rewards an exact match to. The keywords
 * the user searched when they are one role (what the judge anchors on); otherwise
 * the least-senior of the target chips / split keywords — the base of the set.
 */
function resolveBasePhrase(criteria: SearchCriteria): string {
  const kw = (criteria.keywords ?? "").trim();
  if (kw && !IS_LIST.test(kw)) return kw;

  const roles = (criteria.target_titles?.length
    ? criteria.target_titles
    : kw.split(SPLIT_ROLES)
  )
    .map((t) => t.trim())
    .filter(Boolean);
  if (!roles.length) return "";

  let best = roles[0];
  let bestIdx = levelIndexOf(roles[0]) ?? BASE_INDEX;
  for (const r of roles.slice(1)) {
    const idx = levelIndexOf(r) ?? BASE_INDEX;
    if (idx < bestIdx) {
      best = r;
      bestIdx = idx;
    }
  }
  return best;
}

export interface SeniorityAlignment {
  /** Net points added to the composite (base_title_bonus + seniority_penalty). */
  adjustment: number;
  base_title_bonus: number;
  /** <= 0. */
  seniority_penalty: number;
  base_title_match: "exact" | "superset" | "none";
  asked_index: number | null;
  job_index: number;
}

/**
 * Score one job's alignment to the requested seniority + base title. Pure and
 * cheap (regex + token work, no I/O) so it runs per-candidate at ranking time.
 */
export function seniorityAlignment(
  title: string,
  jdText: string,
  criteria: SearchCriteria
): SeniorityAlignment {
  const askedIndex = resolveAskedIndex(criteria);

  // ---- 1. Seniority-over penalty ----
  const jobLevel = classifySeniority(title, jdText ?? "");
  const jobIndex = jobLevel ? SENIORITY_INDEX[jobLevel] : BASE_INDEX;
  let penalty = 0;
  if (askedIndex !== null && jobIndex > askedIndex) {
    const gap = Math.min(jobIndex - askedIndex, OVER_LEVELS_CAP);
    penalty = -gap * OVER_PENALTY_PER_LEVEL;
  }

  // ---- 2. Base-title exact / near-exact bonus ----
  let bonus = 0;
  let baseMatch: SeniorityAlignment["base_title_match"] = "none";
  const baseWords = contentTokens(resolveBasePhrase(criteria));
  if (baseWords.length) {
    const tl = title.toLowerCase();
    const allBasePresent = baseWords.every((w) => titleContainsStem(tl, w));
    if (allBasePresent) {
      const baseStems = new Set(baseWords.map(stemWord));
      const jobStems = contentTokens(title).map(stemWord);
      const hasSpecialiser = jobStems.some((s) => !baseStems.has(s));
      if (hasSpecialiser) {
        bonus = BASE_SUPERSET_BONUS;
        baseMatch = "superset";
      } else {
        bonus = BASE_EXACT_BONUS;
        baseMatch = "exact";
      }
    }
  }

  return {
    adjustment: bonus + penalty,
    base_title_bonus: bonus,
    seniority_penalty: penalty,
    base_title_match: baseMatch,
    asked_index: askedIndex,
    job_index: jobIndex,
  };
}
