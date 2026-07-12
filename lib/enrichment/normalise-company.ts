// Company name normalisation.
//
// The pipeline sees company strings like:
//   "TESCO STORES LIMITED"
//   "Tesco Plc (UK)"
//   "M&S"
//   "Client of Hays Recruitment"
//   "Deloitte LLP"
//   "Confidential"
//   ""
//
// The normalised form is what we look up in `company_enrichment.normalised_name`.
// Rules chosen so real-world variants collapse to the same key without
// destroying the discriminating signal:
//   1. Lowercase
//   2. Strip trailing legal suffix (ltd, limited, plc, llp, llc, inc, corp,
//      gmbh, pty, bv, nv, ag, kg, oy, oyj, ab, as, sarl, sa)
//   3. Strip trailing geo/qualifier parenthetical
//   4. Strip trailing "group", "holdings" (very common noise on parent-cos)
//   5. Replace "&" with " and "
//   6. Strip non-alphanumeric except spaces
//   7. Collapse whitespace, trim
//
// Recruiter prefixes ("Client of X", "via Y", "on behalf of Z") are unwrapped
// to the underlying company where possible, else fall through to the recruiter
// name (which the recruiter-detect layer will flag).

const LEGAL_SUFFIXES = [
  "limited", "ltd", "plc", "llp", "llc", "inc", "corporation", "corp",
  "gmbh", "pty", "bv", "nv", "ag", "kg", "oy", "oyj", "ab", "as",
  "sarl", "s\\.a\\.r\\.l", "sa", "s\\.a", "kk", "co",
];

const GEO_PARENS = [
  "uk", "united kingdom", "gb", "ireland", "eu", "europe", "emea",
  "london", "international", "worldwide", "global", "usa", "us",
];

const TRAILING_NOISE = [
  "group", "holdings", "holding", "the", "co",
];

const UNMATCHABLE_PATTERNS = [
  /^confidential$/i,
  /^private$/i,
  /^undisclosed$/i,
  /^recruiter$/i,
  /^client of\b/i,
  /^n\/?a$/i,
  /^tbc$/i,
  /^unknown$/i,
];

// "Client of Hays" / "via Michael Page" / "posted on behalf of X" —
// unwrap to the underlying company name where the pattern gives us one.
// Otherwise return the whole string (we'll normalise it as-is and probably
// flag as recruiter downstream).
function unwrapAgencyPrefix(raw: string): string {
  const s = raw.trim();
  // "on behalf of ACME" / "on behalf of ACME Ltd"
  const behalf = s.match(/on\s+behalf\s+of\s+(.+)$/i);
  if (behalf) return behalf[1];
  // "via ACME" (drop the recruiter, keep whatever comes after — often empty)
  // — safest to leave as-is because "via ACME" usually IS the recruiter listing
  // (there's no underlying employer disclosed).
  return s;
}

/**
 * Normalise a company name to its lookup key.
 * Returns empty string when the name is clearly unmatchable
 * (confidential / recruiter placeholder / empty).
 */
export function normaliseCompanyName(raw: string | null | undefined): string {
  if (!raw) return "";
  const unwrapped = unwrapAgencyPrefix(raw);

  let s = unwrapped
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[‘’“”]/g, "")     // smart quotes
    .replace(/[.,]/g, " ");                          // punctuation to space

  // Strip trailing geo/qualifier parentheticals: "(UK)" / "(EMEA)" / "(2019)"
  s = s.replace(new RegExp(`\\s*\\((?:${GEO_PARENS.join("|")}|\\d+)\\)\\s*$`, "gi"), " ");
  // Also strip stray parentheses content generally (division names etc.)
  s = s.replace(/\s*\([^)]*\)\s*/g, " ");

  // Strip trailing legal suffixes (may appear repeatedly: "Foo Ltd Limited")
  const legalRe = new RegExp(`\\s+(?:${LEGAL_SUFFIXES.join("|")})\\.?\\s*$`, "i");
  for (let i = 0; i < 3; i++) {
    const next = s.replace(legalRe, "");
    if (next === s) break;
    s = next;
  }

  // Collapse to alphanumeric + space, then noise-word stripping.
  s = s.replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

  // Peel trailing noise words ("group", "holdings", "the")
  const noiseSet = new Set(TRAILING_NOISE);
  const words = s.split(" ");
  while (words.length > 1 && noiseSet.has(words[words.length - 1])) words.pop();
  // "The Tesco" -> "tesco"
  if (words.length > 1 && words[0] === "the") words.shift();

  const out = words.join(" ").trim();
  return out;
}

/**
 * True when the normalised name is a placeholder we should never query CH for.
 * Saves API calls + keeps the enrichment table tidy.
 */
export function isUnmatchableName(rawOrNormalised: string): boolean {
  if (!rawOrNormalised) return true;
  const s = rawOrNormalised.trim();
  if (!s) return true;
  if (s.length < 2) return true;
  return UNMATCHABLE_PATTERNS.some((p) => p.test(s));
}
