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
 * PART delimiters for a job TITLE. An employer bolts a department tag onto a role
 * with a comma, a slash, brackets, or a SPACED dash ("Category Manager - Marketing"),
 * and that tag is NOT a qualifier of the role noun — it is a different segment. We
 * split on those so a qualifier is only credited to the noun it actually sits with.
 * A BARE hyphen is deliberately kept (never "front-end" → "front"+"end", never
 * "Stoke-on-Trent" shredded); only a dash with whitespace on a side is a separator.
 */
const TITLE_PART_SPLIT = /[,/()|;:]|\s[-–—]|[-–—]\s|\n/;

/** A title split into parts, each a list of word tokens (lower-cased). */
function titleTokenParts(titleLower: string): string[][] {
  return titleLower
    .split(TITLE_PART_SPLIT)
    .map((p) => p.split(/[^a-z0-9]+/).filter(Boolean))
    .filter((toks) => toks.length > 0);
}

/** One title TOKEN vs one ask WORD, stem-compared (same primitive as titleContainsStem). */
function tokenMatchesWord(token: string, word: string): boolean {
  return token === word || stemWord(token) === stemWord(word);
}

/**
 * True if a job title is relevant to one target chip. The rule:
 *   1. Full-phrase substring match → accept.
 *   2. Strip seniority markers.
 *   3. One content word left: title must contain it (stem-matched).
 *   4. Two+ left: the LAST is the role noun, the rest are qualifiers. The role noun
 *      must appear AND a qualifier must genuinely MODIFY it — not merely appear
 *      somewhere in the string. Precision (SEARCH_QUALITY_BASELINE #4): the old
 *      "role-noun + any-qualifier-anywhere" rule let "Category Manager - Marketing"
 *      and "Digital Trading Manager" pass a Marketing-Manager search. Now:
 *        • ONE qualifier  → it must sit in the SAME PART as the role noun. Kills the
 *          detached department-tag case ("… Manager - Marketing") while still
 *          keeping an inserted modifier ("Software Development Engineer" for
 *          "Software Engineer" — software and engineer share the part).
 *        • TWO+ qualifiers → at least one must be ADJACENT to the role noun (its own
 *          modifier: immediately before, or immediately after when the noun leads
 *          the part). Kills "Digital Trading Manager" (only the peripheral "digital"
 *          matched; the noun's own modifier "trading" is off-target) while still
 *          accepting "Construction Manager" and "Site Manager" for a
 *          "Construction Site Manager" chip.
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
  // The role noun must appear at all — the cheapest reject.
  if (!titleContainsStem(t, roleNoun)) return false;

  const singleQualifier = qualifiers.length === 1;
  for (const toks of titleTokenParts(t)) {
    for (let i = 0; i < toks.length; i++) {
      if (!tokenMatchesWord(toks[i], roleNoun)) continue;
      if (singleQualifier) {
        // Same-part: the one qualifier must accompany the noun in this segment.
        if (toks.some((tk) => tokenMatchesWord(tk, qualifiers[0]))) return true;
      } else {
        // Adjacency: the noun's own modifier must be one of the chip's qualifiers.
        const before = i > 0 ? toks[i - 1] : null;
        const after = i === 0 && toks.length > 1 ? toks[1] : null;
        if (before && qualifiers.some((q) => tokenMatchesWord(before, q))) return true;
        if (after && qualifiers.some((q) => tokenMatchesWord(after, q))) return true;
      }
    }
  }
  return false;
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
