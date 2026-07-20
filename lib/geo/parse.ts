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
import { geocodeUk, ukPostcodeNear } from "./geocode";

export interface JobLocation {
  raw: string;
  /** A posting may legitimately have SEVERAL. Empty for remote-only/foreign/unknown. */
  places: ResolvedPlace[];
  is_remote: boolean;
  /** True when we positively identified a NON-UK location and no UK one. */
  is_foreign: boolean;
  /**
   * True when the ONLY location signal is a GLOBAL-remote qualifier — "Distributed",
   * "Anywhere", "Worldwide", "Global" — and no UK place (or UK country/region)
   * resolved. This is remote, but remote-GLOBAL, not remote-UK: a Cloudflare
   * Washington-DC role labelled "Distributed" must not pass as within-25-miles of
   * Birmingham just because is_remote short-circuits the distance check
   * (SEARCH_QUALITY_BASELINE #4 — "treat Distributed/global strings as non-UK unless
   * a UK place resolves"). The moment ANY UK place or "UK"/"England" qualifier
   * resolves, this is false. The CALLER decides: a place-anchored (distance) search
   * drops it; a nationwide search is unaffected.
   */
  is_global_remote: boolean;
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
 * GLOBAL-remote qualifiers: strings that advertise "work from anywhere on Earth",
 * not "work from home in the UK". A UK-remote role says "Remote (UK)", "UK home-based"
 * — those resolve a UK country qualifier and are NEVER global. These are the ones
 * that carry no UK anchor at all, so absent a resolved UK place they must be treated
 * as non-UK (SEARCH_QUALITY_BASELINE #4). "Remote"/"WFH"/"Home-based" on their own
 * are deliberately NOT here — those are the ordinary (UK-context) remote roles.
 */
const GLOBAL_REMOTE_RE =
  /\b(?:distributed|anywhere|worldwide|global(?:ly)?|international)\b/i;

/** Does this text advertise a GLOBAL-remote (work-from-anywhere) role? */
export function isGlobalRemoteText(text: string): boolean {
  return GLOBAL_REMOTE_RE.test(text);
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

/**
 * A trailing SITE-TYPE descriptor: the employer naming the *building*, not the town.
 *
 * 🔴 THIS SILENTLY DELETED REAL UK JOBS. Measured on the live corpus (2026-07-14),
 * these strings resolved to NOTHING and the postings were invisible to every
 * location search ever run:
 *
 *     "Glasgow Campus"                     Barclays   36 jobs
 *     "Cambridge Office, United Kingdom"   Darktrace   9 jobs
 *     "London Office, United Kingdom"      Darktrace   8 jobs
 *
 * 53 jobs — more than SEVEN TIMES the entire first-party supply we had in
 * Birmingham. The gazetteer knows "Glasgow" perfectly well; it had simply never
 * been shown it, because the hiring manager wrote the name of the campus.
 *
 * ⚠️ STRIPPING IS NOT A LICENCE TO CLAIM THE PLACE. "Qingdao Site" and "Kuwait -
 * Main Office" strip down to foreign cities, and must stay foreign. So the caller
 * re-runs the FULL classification on the stripped fragment (UK gazetteer *and*
 * foreign-city list) rather than assuming what is left is British.
 *
 * Deliberately NOT in this list: "House". "Douglas Villiers House" is a building,
 * but plenty of genuine UK settlements end in -house, and a wrong town is worse
 * than an unresolved one.
 */
const SITE_DESCRIPTOR_RE =
  /[\s,-]+(?:main\s+|the\s+)?(?:campus|offices?|site|hq|head\s*office|headquarters|business\s+park|industrial\s+estate|science\s+park|technology\s+park|depot|distribution\s+cent(?:re|er)|fulfilment\s+cent(?:re|er)|warehouse|plant|factory|works|store|branch)$/i;

/**
 * What is left after stripping must still be a plausible PLACE NAME, not a filler
 * word the descriptor was leaning on.
 *
 * 🔴 THIS GUARD IS NOT THEORETICAL — it caught a live regression the moment the
 * strip was written. "Kuwait - Main Office" splits to ["Kuwait", "Main Office"];
 * stripping "Office" leaves "Main", and the gazetteer MATCHED it. A Kuwaiti job
 * was resolved to a UK place — a foreign job admitted into a UK search, which is
 * the single worst outcome this whole module exists to prevent, introduced by the
 * very change meant to improve coverage.
 *
 * The rule that stops it: a descriptor may only be stripped off a name that can
 * stand on its own.
 */
const FILLER_REMAINDERS = new Set([
  "main", "the", "our", "any", "all", "this", "new", "old", "head", "home",
  "global", "regional", "central", "corporate", "national", "local", "other",
  "various", "multiple", "hybrid", "flexible", "primary", "secondary", "north",
  "south", "east", "west",
]);

/** "Glasgow Campus" -> "Glasgow". Returns null when there was nothing safe to strip. */
function stripSiteDescriptor(s: string): string | null {
  const out = s.replace(SITE_DESCRIPTOR_RE, "").trim();
  if (!out || out === s.trim()) return null;
  // A one-word remainder that is a filler word is not a town — refuse.
  if (FILLER_REMAINDERS.has(normalise(out))) return null;
  return out;
}

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

    // Nothing claimed the fragment as written. It may be a BUILDING, not a town —
    // "Glasgow Campus", "Cambridge Office". Strip the site descriptor and ask
    // again, running the SAME two checks in the SAME order, so a stripped foreign
    // city ("Qingdao Site") still lands as foreign and never as a UK place.
    const bare = stripSiteDescriptor(p);
    if (bare) {
      const bareUk = lookupUkPlace(bare);
      if (bareUk) {
        places.push(bareUk);
        continue;
      }
      const bareForeign = foreignCityOf(bare);
      if (bareForeign) {
        foreignCity ??= bareForeign;
        continue;
      }
    }

    // Hand the geocoder the stripped form when we have one: postcodes.io can find
    // "Watford Croxley Green", it cannot find "Watford Croxley Green Business Park".
    unknown.push(bare ?? p);
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
    is_global_remote: false,
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

    // ── THE RAW STRING HAS A VETO ────────────────────────────────────────────
    // If the location the employer actually wrote is positively FOREIGN, no
    // provider candidate may rescue it.
    //
    // Workday writes "{COUNTRY} - {City} - {State}", and the adapter expands that
    // into candidates so UK jobs ("UK - Cambridge") can geocode. But the expansion
    // also emits a bare "Cambridge" for "US - Cambridge - MA" — and the UK
    // gazetteer matches it happily. Result: AstraZeneca's Massachusetts jobs were
    // filed as Cambridge, GB. Same for "US - Wilmington - DE" (there is a Wilmington
    // in Kent) and Waltham.
    //
    // The candidates are a CONVENIENCE for geocoding; the raw string is the TRUTH
    // about which country the job is in. Truth wins.
    if (rawStr) {
      const rawSegs = splitSegments(rawStr);
      let rawForeign = false;
      let rawUkPlaces = 0;
      for (const seg of rawSegs) {
        const r = classifySegment(seg);
        if (r.foreign) rawForeign = true;
        rawUkPlaces += r.places.length;
      }
      if (rawForeign && rawUkPlaces === 0) {
        return {
          raw: rawStr,
          places: [],
          is_remote: isRemote,
          is_foreign: true,
          is_global_remote: false,
          is_unresolved: false,
          is_country_only: false,
        };
      }
    }

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

    // Provider country hint. Read BEFORE the coordinates, because an explicit
    // country code from the provider must OVERRULE the bounding box.
    const hint = hints?.countryHint ? hints.countryHint.trim().toUpperCase() : null;
    const hintIsUk = hint === "GB" || hint === "UK";
    const hintIsForeign = !!hint && !hintIsUk;
    if (hint) {
      if (hintIsUk) countryOnly = true;
      else foreignHits++;
    }

    // Provider-supplied coordinates (SmartRecruiters). Cheapest, most reliable
    // signal we get — but it still has to be checked against the UK, because a
    // provider will hand us Seoul's coordinates just as readily as London's.
    //
    // ⚠️ A UK BOUNDING BOX IS NOT THE UK. Ireland sits entirely inside the UK's
    // lat/lng envelope (Dublin is 53.35, -6.26), as do parts of France. So the box
    // alone happily admitted Primark's Dublin jobs — country_code "IE" and all —
    // straight into a UK corpus. When the provider has TOLD us the country, believe
    // it: an explicit ISO code beats a rectangle.
    // ⚠️ AND A BBOX HIT ALONE IS STILL NOT THE UK — the case the country-code fix
    // cannot reach is coordinates with NO code at all. Boots' JSON-LD writes "-"
    // in addressCountry, and its Drogheda (Republic of Ireland) store sits inside
    // the UK envelope; a bbox cannot separate it from Lisburn 40km north, which
    // IS the UK. When nothing but the rectangle vouches for the point, ask the
    // postcode network (ukPostcodeNear): Lisburn answers BT27, Drogheda answers
    // nothing. Cached, so a warm corpus costs zero calls.
    const lat = hints?.lat;
    const lng = hints?.lng;
    let coordsForeign = false;
    let coordsPlace: ResolvedPlace | null = null;
    if (typeof lat === "number" && typeof lng === "number" && Number.isFinite(lat) && Number.isFinite(lng)) {
      if (hintIsForeign) {
        foreignHits++;
      } else if (!isInUkBbox({ lat, lng })) {
        foreignHits++;
      } else if (hintIsUk || (await ukPostcodeNear(lat, lng))) {
        coordsPlace = {
          name: rawStr || "Provider coordinates",
          country: "GB",
          lat,
          lng,
          source: "provider",
        };
      } else {
        // Inside the rectangle, no UK postcode within 2km: Ireland (or Calais).
        // The coordinates are the TRUTH about where this job is — so they also
        // VETO any gazetteer text match (see below): "Bray" the string matches
        // Bray in Berkshire, but these coords say Bray, Co. Wicklow.
        coordsForeign = true;
        foreignHits++;
      }
    }

    // Long tail -> postcodes.io (cached, negatives included). Only worth doing
    // for fragments nothing else claimed.
    const toGeocode = Array.from(new Set(unknownQueue.map((q) => q.trim()).filter(Boolean)));
    for (const q of toGeocode) {
      const hit = await geocodeUk(q);
      if (hit) places.push(hit);
    }

    // The coords place goes LAST: its name is the raw string ("Dalkeith, High
    // Street"), so any place with a real TOWN name — gazetteer or geocoder —
    // should win places[0], which is what job cards display and what the town
    // histogram counts. The coords still vouch for the job either way.
    if (coordsPlace) places.push(coordsPlace);

    // Dedupe places by canonical name.
    const byName = new Map<string, ResolvedPlace>();
    for (const p of places) {
      const key = normalise(p.name);
      if (!byName.has(key)) byName.set(key, p);
    }
    let finalPlaces = Array.from(byName.values());

    // 🔴 AN EXPLICIT PROVIDER COUNTRY CODE IS AUTHORITATIVE. IT BEATS THE GAZETTEER.
    //
    // `is_foreign` used to require `finalPlaces.length === 0`, which meant that the
    // moment the UK gazetteer matched ANY town in the string, a provider explicitly
    // telling us "United States of America" was silently discarded.
    //
    // Barclays' Workday board writes US locations with NO country prefix — just
    // "Wilmington, 125 South West Street" (their Delaware HQ) and "Building
    // 400-Whippany Campus" (New Jersey). There is a real Wilmington in Kent, so the
    // gazetteer matched it, outvoted the country code, and filed Barclays' AMERICAN
    // jobs into a UK corpus as country_code=GB. Whippany isn't a UK village, so that
    // one got dropped correctly — which is exactly why the bug looked like nothing:
    // it leaked only through towns that happen to exist in both countries.
    //
    // This is the same lesson already learned for Primark's Dublin jobs ("an explicit
    // provider country code must BEAT the bbox") — but that fix was applied ONLY to
    // the coordinate path. The gazetteer path had the identical hole. A signal that
    // is authoritative is authoritative everywhere, not just where we first got bitten.
    if (hintIsForeign || coordsForeign) {
      finalPlaces = [];
    }

    const is_foreign = hintIsForeign || coordsForeign || (finalPlaces.length === 0 && foreignHits > 0);
    const is_country_only = finalPlaces.length === 0 && !is_foreign && countryOnly;
    const is_unresolved = finalPlaces.length === 0 && !is_foreign && !is_country_only;
    // GLOBAL-remote with NO UK anchor (no UK place, not "UK"/"England", not foreign):
    // "Distributed" / "Anywhere" / "Worldwide" / "Global". Non-UK unless a UK place
    // resolved — see the interface doc and SEARCH_QUALITY_BASELINE #4.
    const is_global_remote =
      finalPlaces.length === 0 &&
      !is_foreign &&
      !is_country_only &&
      inputs.some((i) => isGlobalRemoteText(i));

    return {
      raw: rawStr,
      places: finalPlaces,
      is_remote: isRemote,
      is_foreign,
      is_global_remote,
      is_country_only,
      is_unresolved,
    };
  } catch {
    // Belt and braces: the public API never throws.
    return unresolved(rawStr, hints?.isRemote === true || isRemoteText(rawStr));
  }
}
