// Parse a job's location string(s) into resolved places + remote/foreign flags.
//
// THE SHAPE OF THE PROBLEM
// ------------------------
// An ATS location field is free text written by a hiring manager, not a schema.
// Real strings pulled live on 2026-07-12:
//   Monzo/Greenhouse    "Cardiff, London or Remote (UK)"   "London; Remote (UK)"
//   Palantir/Lever      "Palo Alto, CA"   "Seoul, South Korea"   "Washington, D.C."
//   Synthesia/Ashby     "UK Remote"   "Europe"   "Munich"
//   AstraZeneca/Workday "US - Gaithersburg - MD"
//
// TWO RULES DRIVE EVERY DECISION BELOW
//
// 1. A MISSED CANDIDATE HIDES A REAL JOB; a spare candidate costs nothing.
//    "Cardiff, London or Remote (UK)" must yield BOTH Cardiff AND London.
//    Collapsing it to one place silently hides the role from the other user.
//    So we are generous: split aggressively, try every fragment, union the hits.
//
// 2. A MISSED FOREIGN QUALIFIER ADMITS PALO ALTO INTO A BIRMINGHAM SEARCH.
//    So foreign detection is checked FIRST and wins outright.

import {
  foreignCityOf,
  foreignQualifierOf,
  isInUkBbox,
  isUkCountryTerm,
  isUkRegionQualifier,
  lookupUkPlace,
  normalise,
  type ResolvedPlace,
} from "./gazetteer";
import { geocodeUk } from "./geocode";

export interface JobLocation {
  raw: string;
  /** A posting may legitimately have SEVERAL. Empty for remote-only/foreign/unknown. */
  places: ResolvedPlace[];
  is_remote: boolean;
  /** True when we positively identified a NON-UK location and no UK one. */
  is_foreign: boolean;
  /**
   * True when the posting names the UK but no point in it ("UK", "England",
   * "Remote (UK)"). NOT a place: the UK is 600 miles long, so pinning it to a
   * centroid would let a nationwide posting masquerade as a local one.
   * The CALLER decides: a nationwide search accepts these, a 25-mile search
   * must not — unless the posting is also remote.
   */
  is_country_only: boolean;
  /** True when we could not resolve anything at all. */
  is_unresolved: boolean;
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

const REMOTE_PATTERNS: RegExp[] = [
  /\bremote(ly)?\b/i,
  /\bwork\s+from\s+home\b/i,
  /\bwfh\b/i,
  /\bhome[\s-]?based\b/i,
  /\bdistributed\b/i,
  /\banywhere\b/i,
];

/** Does this text advertise a remote role? */
export function isRemoteText(text: string): boolean {
  return REMOTE_PATTERNS.some((re) => re.test(text));
}

/**
 * Working-model noise that is NOT a place. Stripped from each fragment before
 * we try to resolve it, so "UK Remote" -> "UK" and "London (Hybrid)" -> "London".
 * Order matters inside the alternation: longer phrases first.
 */
const MODIFIER_RE =
  /\b(?:fully\s+remote|remote[\s-]?first|work\s+from\s+home|home[\s-]?based|office[\s-]?based|field[\s-]?based|on[\s-]?site|in[\s-]?office|remotely|remote|hybrid|wfh|distributed|anywhere|flexible)\b/gi;

/**
 * SEGMENT delimiters — fragments that are ALTERNATIVE places.
 * Comma is deliberately NOT here: it is ambiguous ("Cardiff, London" = two
 * places; "London, United Kingdom" = one) and is disambiguated per-part below.
 */
const SEGMENT_SPLIT_RE = /\s*(?:;|\||\/|\r?\n)\s*|\s+or\s+/i;

/**
 * PART delimiters — within one segment. Includes the comma and the spaced dash
 * ("US - Gaithersburg - MD"). NOT the bare hyphen: that would shred
 * "Stoke-on-Trent" and "Weston-super-Mare".
 */
const PART_SPLIT_RE = /\s*(?:[,;|/]|\s-\s|\s–\s|\s—\s|\r?\n)\s*|\s+or\s+/i;

function stripModifiers(s: string): string {
  return s
    .replace(MODIFIER_RE, " ")
    .replace(/\s+/g, " ")
    .trim()
    // A leftover leading/trailing conjunction after stripping ("London or" from
    // "London or Remote"). Never touches an INTERNAL "and" — that would maul
    // "Tyne and Wear".
    .replace(/^(?:or|and)\s+/i, "")
    .replace(/\s+(?:or|and)$/i, "")
    .trim();
}

/** Split a raw location into alternative segments. */
export function splitSegments(raw: string): string[] {
  const out: string[] = [];
  for (const seg of raw.split(SEGMENT_SPLIT_RE)) {
    const t = seg?.trim();
    if (t) out.push(t);
  }
  // Always ALSO consider the WHOLE string. Costs one extra lookup; recovers the
  // cases where our splitting was too eager.
  const whole = raw.trim();
  if (whole && !out.some((s) => normalise(s) === normalise(whole))) out.push(whole);
  return out;
}

/**
 * Split a segment into parts, with parentheses flattened into parts of their own
 * ("Remote (UK)" -> ["Remote", "UK"]), modifiers stripped, empties dropped.
 * ORIGINAL CASE IS PRESERVED — foreignQualifierOf() needs it: a 2-letter code
 * only counts as a US state when it was written in caps (see gazetteer.ts).
 */
function cleanParts(segment: string): string[] {
  const flattened = segment.replace(/[()[\]]/g, ",");
  const parts: string[] = [];
  for (const p of flattened.split(PART_SPLIT_RE)) {
    const cleaned = stripModifiers(p ?? "");
    if (cleaned && /[a-z]/i.test(cleaned)) parts.push(cleaned);
  }
  return parts;
}

// ---------------------------------------------------------------------------
// Segment classification
// ---------------------------------------------------------------------------

interface SegmentResult {
  places: ResolvedPlace[];
  /** ISO-2 of a positively-identified non-UK location. */
  foreign: string | null;
  /** UK named, but only at country/region level. */
  countryOnly: boolean;
  /** Fragments we couldn't classify offline — candidates for postcodes.io. */
  unknown: string[];
}

const EMPTY: SegmentResult = { places: [], foreign: null, countryOnly: false, unknown: [] };

/**
 * ⚠️⚠️ THE ORDER OF THE STEPS BELOW IS LOAD-BEARING. DO NOT "SIMPLIFY" IT. ⚠️⚠️
 *
 * A FOREIGN QUALIFIER IS CHECKED BEFORE THE UK GAZETTEER. Half a dozen of the
 * UK's biggest cities share a name with an American one, and the gazetteer would
 * happily claim them:
 *     "Birmingham, AL"   -> Alabama, NOT the West Midlands
 *     "Cambridge, MA"    -> Massachusetts, NOT Cambridgeshire
 *     "Manchester, NH"   -> New Hampshire
 *     "London, ON"       -> Ontario
 *     "Newcastle, NSW"   -> Australia
 *     "Dublin, OH"       -> Ohio (bare "Dublin" is Ireland — also not the UK)
 * Match the gazetteer first and every one of those becomes a UK job, and a
 * Birmingham user gets Alabama inside their "within 25 miles".
 *
 * Conversely a BARE collision name ("Birmingham", "Cambridge") is UK — the
 * gazetteer is the default and the qualifier is what overrides it. That is why
 * the foreign check looks for QUALIFIERS (states/countries/regions), while the
 * foreign-CITY list (step 4) is consulted only after the UK gazetteer misses.
 */
function classifySegment(segment: string): SegmentResult {
  const parts = cleanParts(segment);
  if (parts.length === 0) return EMPTY;

  // ---- STEP 1. FOREIGN QUALIFIER — BEFORE anything UK. ----------------------
  for (const p of parts) {
    const iso = foreignQualifierOf(p);
    if (iso) return { places: [], foreign: iso, countryOnly: false, unknown: [] };
  }

  // ---- STEP 2. The WHOLE segment as one name. ------------------------------
  // Catches names that contain our own delimiters or that are region-aliases:
  // "Stoke-on-Trent", "Greater London", "West Midlands" -> Birmingham.
  // Must precede step 3, where "West Midlands" would instead be read as a
  // county QUALIFIER and yield nothing.
  const whole = lookupUkPlace(stripModifiers(segment));
  if (whole) return { places: [whole], foreign: null, countryOnly: false, unknown: [] };

  // ---- STEP 3. Part-by-part. -----------------------------------------------
  const places: ResolvedPlace[] = [];
  const unknown: string[] = [];
  let sawUkQualifier = false;
  let foreignCity: string | null = null;

  for (const p of parts) {
    // A UK country term or county is a QUALIFIER, not a second place:
    // "London, United Kingdom" is ONE place; "Solihull, West Midlands" is ONE.
    // (Checked before the gazetteer because some counties are also city
    // aliases — "West Midlands" -> Birmingham. In tail position the county
    // reading must win, or "Solihull, West Midlands" becomes two places.)
    if (isUkCountryTerm(p) || isUkRegionQualifier(p)) {
      sawUkQualifier = true;
      continue;
    }
    const uk = lookupUkPlace(p);
    if (uk) {
      places.push(uk);
      continue;
    }
    const fc = foreignCityOf(p);
    if (fc) {
      foreignCity ??= fc;
      continue;
    }
    unknown.push(p);
  }

  if (places.length > 0) {
    // A UK place was found. Per the contract, is_foreign is false whenever ANY
    // UK place resolved — so a stray foreign city in the same segment is simply
    // dropped, not escalated.
    return { places, foreign: null, countryOnly: false, unknown };
  }

  // ---- STEP 4. No UK place. A known foreign city now settles it. ------------
  if (foreignCity) return { places: [], foreign: foreignCity, countryOnly: false, unknown: [] };

  // ---- STEP 5. UK, but only at country/region level ("UK", "England"). ------
  if (sawUkQualifier && unknown.length === 0) {
    return { places: [], foreign: null, countryOnly: true, unknown: [] };
  }

  // ---- STEP 6. Unknown -> the geocoder gets a go (postcodes.io). ------------
  return { places: [], foreign: null, countryOnly: sawUkQualifier, unknown };
}

// ---------------------------------------------------------------------------
// Public
// ---------------------------------------------------------------------------

export interface JobLocationHints {
  /** Extra location strings the provider gave us (Greenhouse/Ashby often do). */
  candidates?: string[];
  /** ISO-2 where the provider states it outright (Workday, SmartRecruiters). */
  countryHint?: string | null;
  /** The provider explicitly flags the role remote. */
  isRemote?: boolean | null;
  /** SmartRecruiters ships coordinates — no geocoding needed. */
  lat?: number | null;
  lng?: number | null;
}

function unresolved(raw: string, isRemote: boolean): JobLocation {
  return {
    raw,
    places: [],
    is_remote: isRemote,
    is_foreign: false,
    is_country_only: false,
    is_unresolved: true,
  };
}

/**
 * Resolve a job's location string(s) + any structured hints into places/flags.
 * NEVER THROWS — an ingest of 3,000 jobs must not die on one weird string.
 */
export async function resolveJobLocation(
  raw: string | null,
  hints?: JobLocationHints
): Promise<JobLocation> {
  const rawStr = (raw ?? "").trim();

  try {
    const inputs: string[] = [];
    if (rawStr) inputs.push(rawStr);
    for (const c of hints?.candidates ?? []) {
      const t = (c ?? "").trim();
      if (t) inputs.push(t);
    }

    const isRemote =
      hints?.isRemote === true || inputs.some((i) => isRemoteText(i));

    // Dedupe segments across raw + provider candidates.
    const segments: string[] = [];
    const seen = new Set<string>();
    for (const input of inputs) {
      for (const seg of splitSegments(input)) {
        const key = normalise(seg);
        if (key && !seen.has(key)) {
          seen.add(key);
          segments.push(seg);
        }
      }
    }

    const places: ResolvedPlace[] = [];
    const unknownQueue: string[] = [];
    let foreignHits = 0;
    let countryOnly = false;

    for (const seg of segments) {
      const r = classifySegment(seg);
      places.push(...r.places);
      if (r.foreign) foreignHits++;
      if (r.countryOnly) countryOnly = true;
      unknownQueue.push(...r.unknown);
    }

    // Provider-supplied coordinates (SmartRecruiters). Cheapest, most reliable
    // signal we get — but it still has to be checked against the UK, because a
    // provider will hand us Seoul's coordinates just as readily as London's.
    const lat = hints?.lat;
    const lng = hints?.lng;
    if (typeof lat === "number" && typeof lng === "number" && Number.isFinite(lat) && Number.isFinite(lng)) {
      if (isInUkBbox({ lat, lng })) {
        places.push({
          name: rawStr || "Provider coordinates",
          country: (hints?.countryHint ?? "GB").toUpperCase(),
          lat,
          lng,
          source: "provider",
        });
      } else {
        foreignHits++;
      }
    }

    // Provider country hint.
    const hint = hints?.countryHint ? hints.countryHint.trim().toUpperCase() : null;
    if (hint) {
      if (hint === "GB" || hint === "UK") countryOnly = true;
      else foreignHits++;
    }

    // Long tail -> postcodes.io (cached, negatives included). Only worth doing
    // for fragments nothing else claimed.
    const toGeocode = Array.from(new Set(unknownQueue.map((q) => q.trim()).filter(Boolean)));
    for (const q of toGeocode) {
      const hit = await geocodeUk(q);
      if (hit) places.push(hit);
    }

    // Dedupe places by canonical name.
    const byName = new Map<string, ResolvedPlace>();
    for (const p of places) {
      const key = normalise(p.name);
      if (!byName.has(key)) byName.set(key, p);
    }
    const finalPlaces = Array.from(byName.values());

    const is_foreign = finalPlaces.length === 0 && foreignHits > 0;
    const is_country_only = finalPlaces.length === 0 && !is_foreign && countryOnly;
    const is_unresolved = finalPlaces.length === 0 && !is_foreign && !is_country_only;

    return {
      raw: rawStr,
      places: finalPlaces,
      is_remote: isRemote,
      is_foreign,
      is_country_only,
      is_unresolved,
    };
  } catch {
    // Belt and braces: the public API never throws.
    return unresolved(rawStr, hints?.isRemote === true || isRemoteText(rawStr));
  }
}
