// UK postcode → place name.
//
// Reed accepts a raw postcode as its location and does the radius search
// server-side. Adzuna does NOT: given `where=B1 1AA` it returns ZERO results —
// for any query at all, including a bare "analyst" — with no error, no warning,
// just count: 0. Give it `where=Birmingham` and the same query returns 337.
//
// That is why Adzuna contributed nothing from the day it was wired up: the
// pipeline passes the user's postcode to every source, so Adzuna silently
// answered "no jobs" to every search while Reed carried the whole pull.
//
// We resolve the postcode to its admin district (the town/city Adzuna wants)
// via postcodes.io — free, no key, no quota worth worrying about at our volume.
//
// Resolution failure is NOT silent. The pipeline applies no post-pull distance
// filter (it trusts each source's radius search), so quietly dropping `where`
// would return nationwide jobs to someone who asked for "within 25 miles". A
// source that can't place the user must say so and return nothing.

const CACHE = new Map<string, string | null>();

// e.g. "B1 1AA", "SW1A 1AA", "M1 1AE" — a full unit postcode.
const FULL_POSTCODE = /^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/i;
// e.g. "B1", "SW1A", "M1" — the outward half only.
const OUTCODE = /^[A-Z]{1,2}\d[A-Z\d]?$/i;

function outwardOf(postcode: string): string {
  return postcode.trim().split(/\s+/)[0];
}

/** True if the string looks like a UK postcode (full or outward-only). */
export function looksLikePostcode(s: string): boolean {
  const t = s.trim();
  return FULL_POSTCODE.test(t) || OUTCODE.test(t);
}

async function fetchJson(url: string): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Resolve a UK postcode to the town/city name a job board will understand.
 *
 * Anything that doesn't look like a postcode is passed straight back — users
 * are allowed to type "Birmingham" or "Greater Manchester" directly.
 *
 * Returns null when a postcode-shaped input can't be resolved, so the caller
 * can fail loudly rather than search the wrong area.
 */
export async function resolvePlaceName(location: string): Promise<string | null> {
  const raw = location?.trim();
  if (!raw) return null;
  if (!looksLikePostcode(raw)) return raw; // already a place name

  const key = raw.toUpperCase().replace(/\s+/g, " ");
  const cached = CACHE.get(key);
  if (cached !== undefined) return cached;

  let place: string | null = null;

  // Full postcode first — most precise district.
  if (FULL_POSTCODE.test(raw)) {
    const d = await fetchJson(`https://api.postcodes.io/postcodes/${encodeURIComponent(raw)}`);
    const result = d?.result as { admin_district?: string } | undefined;
    if (typeof result?.admin_district === "string") place = result.admin_district;
  }

  // Fall back to the outward code. This also covers a mistyped or retired unit
  // postcode: "B1 1AA" 404s, but outcode "B1" still resolves to Birmingham.
  if (!place) {
    const outward = outwardOf(raw);
    if (OUTCODE.test(outward)) {
      const d = await fetchJson(`https://api.postcodes.io/outcodes/${encodeURIComponent(outward)}`);
      // The outcodes endpoint returns admin_district as an ARRAY — an outward
      // code can straddle several districts. The first is the primary.
      const result = d?.result as { admin_district?: string[] } | undefined;
      const districts = result?.admin_district;
      if (Array.isArray(districts) && typeof districts[0] === "string") place = districts[0];
    }
  }

  CACHE.set(key, place);
  return place;
}
