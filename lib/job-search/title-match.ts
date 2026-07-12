// Title-relevance filter. Extracted from pipeline.ts because the ATS corpus query
// must apply the IDENTICAL rule — a second implementation would inevitably drift,
// and then the same job would pass the filter when it came from Reed and fail it
// when it came from the employer's own board.

import { stemWord, titleContainsStem, TITLE_STOP } from "./text";

/**
 * Words that mark SENIORITY, not role type. Stripped from the chip during title
 * matching, so a "Senior Data Analyst" chip still matches "Data Analyst" — but
 * "Head of Marketing" keeps Head, because there Head IS the role.
 *
 * NOTE the deliberate asymmetry with canonical.ts, which does NOT strip seniority:
 * for FILTERING, a user asking for "Senior Analyst" should still see "Analyst"
 * roles; for IDENTITY, a Senior and a Junior Analyst are different jobs and must
 * never merge. Same words, opposite treatment, both correct.
 */
export const SENIORITY_MARKERS = new Set([
  "junior", "senior", "entry", "mid", "graduate", "intern", "trainee",
  "apprentice", "experienced", "level", "principal", "staff",
]);

export interface TargetTitle {
  phrase: string;
  words: string[];
}

/** Parse the user's chips / keyword string into matchable targets. */
export function buildTargets(raw: string[]): TargetTitle[] {
  return raw
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean)
    .map((phrase) => ({
      phrase,
      words: phrase.split(/\s+/).filter((w) => w.length > 2 && !TITLE_STOP.has(w)),
    }));
}

/**
 * True if a job title is relevant to one target chip. The rule:
 *   1. Full-phrase substring match → accept.
 *   2. Strip seniority markers.
 *   3. One content word left: title must contain it (stem-matched).
 *   4. Two+ left: the LAST is the role noun, the rest are qualifiers. The title
 *      must contain the role noun AND at least one qualifier. This is what stops
 *      a "Construction Site Manager" chip matching "Marketing Manager" via a bare
 *      "manager", while still accepting "Site Manager" and "Construction Manager".
 *   5. Pure-seniority chip ("Senior") → match any of its words.
 */
export function titleRelevantOne(title: string, phrase: string, askWords: string[]): boolean {
  const t = title.toLowerCase();
  if (phrase && t.includes(phrase)) return true;
  if (!askWords.length) return true;

  const contentWords = askWords.filter((w) => !SENIORITY_MARKERS.has(w));
  if (contentWords.length === 0) return askWords.some((w) => titleContainsStem(t, w));
  if (contentWords.length === 1) return titleContainsStem(t, contentWords[0]);

  const roleNoun = contentWords[contentWords.length - 1];
  const qualifiers = contentWords.slice(0, -1);
  if (!titleContainsStem(t, roleNoun)) return false;
  return qualifiers.some((q) => titleContainsStem(t, q));
}

/** True if the title matches ANY of the user's target chips (multi-role search). */
export function titleRelevantAny(title: string, targets: TargetTitle[]): boolean {
  return targets.some((t) => titleRelevantOne(title, t.phrase, t.words));
}

/**
 * The ROLE NOUNS across all targets — used as a cheap SQL prefilter against the
 * corpus (`title ilike '%analyst%'`, trigram-indexed) before the full rule above
 * runs in JS. Narrowing in SQL first is what keeps a corpus query fast as the
 * corpus grows into the hundreds of thousands.
 */
export function roleNouns(targets: TargetTitle[]): string[] {
  const nouns = new Set<string>();
  for (const t of targets) {
    const content = t.words.filter((w) => !SENIORITY_MARKERS.has(w));
    const noun = content.length ? content[content.length - 1] : t.words[t.words.length - 1];
    if (!noun) continue;
    // Stem, then drop a trailing char so the ILIKE also catches plurals and
    // simple inflections ("analyst" → "analys%" → Analyst, Analysts, Analysis).
    const stem = stemWord(noun);
    nouns.add(stem.length > 4 ? stem.slice(0, -1) : stem);
  }
  return [...nouns];
}
