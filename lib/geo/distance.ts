// Straight-line distance. Miles, because every UK job board — and every user —
// thinks in miles ("within 25 miles").

import type { GeoPoint } from "./gazetteer";
import type { JobLocation } from "./parse";

/** Mean Earth radius in miles. */
const EARTH_RADIUS_MILES = 3958.8;

const toRad = (deg: number): number => (deg * Math.PI) / 180;

/**
 * Great-circle ("as the crow flies") distance between two points, in miles.
 *
 * Deliberately NOT a travel-time estimate. A 25-mile radius filter is a coarse
 * supply filter; commute-time modelling is a separate, later concern
 * (SearchCriteria.location.commute_mode). Haversine costs nothing and is exact
 * enough that a 3dp gazetteer coordinate is the dominant error term.
 */
export function haversineMiles(a: GeoPoint, b: GeoPoint): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;

  return 2 * EARTH_RADIUS_MILES * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Distance from the user to a job, in miles.
 *
 * Returns the MINIMUM over all of the job's places: a role advertised as
 * "Cardiff, London or Remote (UK)" is as close as its NEAREST option — it is a
 * real, applicable job for a London user AND for a Cardiff user.
 *
 * Returns null when the job has no usable place (pure remote, country-only,
 * foreign, unresolved). Null is NOT "far away" and NOT "nearby" — it means the
 * distance filter cannot speak, and the CALLER must decide using the flags on
 * JobLocation (is_remote / is_country_only / is_foreign / is_unresolved) plus
 * whether the source has a trusted server-side radius (see
 * hasTrustedRadius() in lib/job-search/types.ts). Treating null as 0 would let
 * every unresolvable ATS posting on Earth into a 25-mile search.
 */
export function distanceMiles(origin: GeoPoint, loc: JobLocation): number | null {
  if (!loc.places.length) return null;
  let best = Infinity;
  for (const p of loc.places) {
    const d = haversineMiles(origin, p);
    if (d < best) best = d;
  }
  return Number.isFinite(best) ? best : null;
}
