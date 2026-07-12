// lib/geo — the location engine. THE thing that makes ATS-direct ingest safe.
//
// Reed and Adzuna radius-search server-side, so the pipeline never needed a
// post-pull distance filter — it trusted the source. ATS boards (Greenhouse,
// Lever, Ashby, Workday) hand back the employer's ENTIRE GLOBAL board with no
// filtering of any kind. Wire one in without this module and a Birmingham user
// asking for "within 25 miles" gets Palo Alto and Seoul.
//
// USAGE (ingest worker)
//   const origin = await resolveOrigin(criteria.location.postcode);   // once
//   await warmCache(jobs.map(j => j.location_raw ?? ""));             // batched, 5 at a time
//   for (const job of jobs) {
//     const loc = await resolveJobLocation(job.location_raw, {
//       candidates: job.location_candidates,
//       countryHint: job.country_hint,
//       isRemote: job.is_remote,
//       lat: job.lat, lng: job.lng,
//     });
//     if (loc.is_foreign) continue;                       // Seoul. Drop it.
//     const miles = origin ? distanceMiles(origin, loc) : null;
//     ...
//   }
//
// THE CALLER OWNS THE POLICY, NOT THIS MODULE. distanceMiles() returns null for
// a job with no usable place — remote, country-only ("UK"), or unresolved. Null
// is not zero. What to do with each case depends on the search:
//
//   is_foreign         DROP. Always. It is positively not in the UK.
//   is_remote          keep if the user accepts remote (working_model).
//   is_country_only    a nationwide search accepts it; a 25-mile search must NOT
//                      (unless is_remote) — "UK" is 600 miles long.
//   is_unresolved      for an ATS source: DROP (the board vouched for nothing).
//                      for Reed/Adzuna: KEEP — those sources already applied
//                      their own radius filter. See hasTrustedRadius() in
//                      lib/job-search/types.ts.
//
// No npm dependencies. No API keys. Geocoding falls back to postcodes.io (free,
// keyless) and caches both hits AND misses, in-process and in Supabase
// (geo_cache — see supabase-geo-cache-schema.sql). Nothing here throws.

export type { GeoPoint, ResolvedPlace } from "./gazetteer";
export type { JobLocation, JobLocationHints } from "./parse";

export { resolveJobLocation, isRemoteText, splitSegments } from "./parse";
export { resolveOrigin, geocodeUk, warmCache, clearMemoryCache } from "./geocode";
export { distanceMiles, haversineMiles } from "./distance";

// Escape hatches for callers that want the raw data (and for tests).
export {
  lookupUkPlace,
  foreignQualifierOf,
  foreignCityOf,
  isUkCountryTerm,
  isUkRegionQualifier,
  isInUkBbox,
  normalise,
  UK_PLACES,
} from "./gazetteer";
