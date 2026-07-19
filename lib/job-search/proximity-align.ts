// Proximity / exact-town alignment — the selection signal that keeps a search for
// a NAMED CITY from being filled by within-radius neighbouring towns while the
// city itself (and the nearest towns) sit lower.
//
// The defect this fixes (SEARCH_QUALITY_BASELINE_2026-07-19, #7): every Sheffield
// teacher result was Chesterfield / Rotherham / Doncaster / Barnsley / Wakefield —
// all technically ≤25 miles, but reading as "not my city"; the one genuine
// Sheffield role sat at #9. Same shape on Glasgow nursing. Nothing in the composite
// distinguished a job in the exact town from one at the edge of the radius: distance
// was computed and DISPLAYED, but never RANKED on.
//
// The fix is one bounded, EXPLAINED bonus that rewards closeness. It is applied
// post-blend at full strength (the same place the base-title and remote bonuses
// ride) and, critically, is a NO-OP for any search that isn't anchored to a place:
//
//   • nationwide / willing-to-relocate / remote search  -> no origin, isNationwide
//     is true, adjustment = 0. A remote or "anywhere" search must never be reordered
//     by distance to a postcode the user explicitly said doesn't matter.
//   • a job with no resolvable distance (pure-remote, country-only, or an
//     unresolved location a trusted-radius source vouched for) -> adjustment = 0.
//     Null distance is "cannot speak", never "far away": the job keeps its composite
//     and simply doesn't get the proximity lift, rather than being pushed down.
//
// Because the bonus SCALES with the search's own radius, it only ever reorders jobs
// that already passed the distance filter — it floats the nearest of them up, and
// cannot pull anything past the role-precision or meaning-match signals: a genuinely
// better-matched role a few miles further out still wins (see the magnitude note).

// Peer of the base-title exact bonus (10) and the remote-confirmed bonus (10): big
// enough that, among a cluster of equally-relevant roles spread across a user's
// radius, the exact town and its nearest neighbours float above the far edge —
// small enough that a materially better role a few miles further out still wins on
// the other axes. Full strength at distance 0, decaying linearly to 0 at the radius.
const PROXIMITY_MAX = 10;

export interface ProximityAlignment {
  /** Points added to the composite. 0 for a nationwide/remote search or an
   *  unplaceable job; up to PROXIMITY_MAX for a job in the exact searched town. */
  adjustment: number;
  /** Whether this SEARCH enforces proximity at all (anchored to a place + radius).
   *  False for nationwide / remote — the whole signal is a no-op then. */
  applies: boolean;
  /** The job's distance from the user in miles, or null when it has no usable place. */
  distance_miles: number | null;
  /** The bonus this job earned (== adjustment). Kept as its own field to mirror the
   *  shape of the other selection signals in ranking_explanation. */
  proximity_bonus: number;
}

const NOOP: ProximityAlignment = {
  adjustment: 0,
  applies: false,
  distance_miles: null,
  proximity_bonus: 0,
};

/**
 * Score one job's proximity to the searched location. Pure and cheap (arithmetic
 * only, no I/O) so it runs per-candidate at ranking time.
 *
 * @param distanceMiles  the job's distance from the user (distanceMiles(origin, loc)),
 *                       or null when the job has no usable place.
 * @param radiusMiles    the radius the search is filtering to, used to scale the
 *                       bonus so it is proportional to what "near" means for THIS
 *                       search. Null (no radius) makes the signal a no-op.
 * @param isNationwide   true for a willing-to-relocate / "anywhere" / remote search,
 *                       where distance to a postcode is meaningless — a hard no-op.
 */
export function proximityAlignment(input: {
  distanceMiles: number | null;
  radiusMiles: number | null;
  isNationwide: boolean;
}): ProximityAlignment {
  const { distanceMiles, radiusMiles, isNationwide } = input;

  // A search with no place anchor never reorders on distance.
  if (isNationwide || !radiusMiles || radiusMiles <= 0) return NOOP;

  // The search IS proximity-anchored. A job we couldn't place gets no lift (null is
  // "cannot speak", not "far") but the signal still "applies" to the search, so the
  // card can honestly say results are ranked by closeness.
  if (distanceMiles === null || !Number.isFinite(distanceMiles)) {
    return { adjustment: 0, applies: true, distance_miles: null, proximity_bonus: 0 };
  }

  const closeness = Math.max(0, Math.min(1, 1 - distanceMiles / radiusMiles));
  // One decimal place: enough to keep towns a couple of miles apart distinct within a
  // typical radius (each mile ≈ PROXIMITY_MAX/radius points), without pretending to a
  // precision the gazetteer's ~3dp coordinates don't have.
  const bonus = Math.round(PROXIMITY_MAX * closeness * 10) / 10;
  return { adjustment: bonus, applies: true, distance_miles: distanceMiles, proximity_bonus: bonus };
}
