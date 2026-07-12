// Shared text utilities for job matching.
//
// Extracted from pipeline.ts because the cross-source dedupe layer needs the
// SAME stemmer the title filter uses. Two stemmers that disagree would mean a
// job could pass the title filter under one spelling and fail dedupe under
// another — the sort of drift that produces duplicate shortlist rows nobody can
// explain.

/**
 * Light stemmer for job-title matching. Strips common English plural and gerund
 * suffixes so "Analysts" ~ "Analyst", "Buyers" ~ "Buyer", "Managing" ~ "Manage".
 * Short words are left alone.
 *
 * See feedback_input_tolerance_saas — every match is case-insensitive and
 * stem-normalised, otherwise a real user typing a plural gets zero results.
 */
export function stemWord(w: string): string {
  const s = w.toLowerCase();
  if (s.length < 5) return s;
  if (s.endsWith("ies") && s.length > 5) return s.slice(0, -3) + "y";
  if (s.endsWith("sses")) return s.slice(0, -2);
  if (s.endsWith("s") && !s.endsWith("ss") && !s.endsWith("us") && !s.endsWith("is")) return s.slice(0, -1);
  if (s.endsWith("ing") && s.length > 6) return s.slice(0, -3);
  if (s.endsWith("ed") && s.length > 5) return s.slice(0, -2);
  return s;
}

/** Stopwords for TITLE handling. Deliberately short — never strip content words
 *  we discriminate on (analyst, driver, engineer...). */
export const TITLE_STOP = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "for", "with", "on", "at", "by", "from", "-",
]);

/** Does the title contain `word` (or its stem)? Both sides are stem-compared. */
export function titleContainsStem(titleLower: string, word: string): boolean {
  const wordStem = stemWord(word);
  if (new RegExp(`\\b${escapeRe(word)}\\b`, "i").test(titleLower)) return true;
  for (const t of titleLower.split(/[^a-z0-9]+/)) {
    if (t && stemWord(t) === wordStem) return true;
  }
  return false;
}

export function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
