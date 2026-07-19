/**
 * scripts/verify-selection-signals.ts — pure-unit proof for the two selection
 * signals added for SEARCH_QUALITY_BASELINE_2026-07-19 #5 (recruiter catch) and
 * #7 (proximity / exact-town). The repo has no unit-test runner, so — as with the
 * audit scoreboard — the proof is a runnable script that exits non-zero on any
 * failed assertion. Fast (no I/O, no keys): `npx tsx scripts/verify-selection-signals.ts`.
 */
import { detectRecruiter } from "../lib/enrichment/recruiter-detect";
import { proximityAlignment } from "../lib/job-search/proximity-align";

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    console.log(`  ✅ ${name}`);
  } else {
    failures++;
    console.log(`  ❌ ${name}${detail ? "  — " + detail : ""}`);
  }
}

// ---------------------------------------------------------------- #5 recruiter ----
// Agencies observed in live shortlist data (audit-results-latest.json) or named in
// the brief — every one MUST flag now.
const SHOULD_FLAG = [
  "Academics", "Academics ", "GSL Education", "GSL Education - Wakefield",
  "Teaching Personnel", "Newcross Healthcare", "Nurse Seekers",
  "High Profile Resourcing Ltd", "Avon Search & Selection Ltd",
  "National Skills Agency", "Search Consultancy", "Sanctuary Personnel",
  "Staffline", "Prospero Teaching", "ITOL Recruit", "Hays Education",
  "PK Education", "TeacherActive", "Trust Education Limited", "Simply Education",
  "Reeson Education", "Aspire People", "Career Teachers",
];
// Real employers — care-home operators, maintenance firms, training providers,
// direct employers. NONE may flag (never demote a real employer on a name coincidence).
const SHOULD_NOT_FLAG = [
  "Care Concern Group", "Hallmark Care Homes LTD", "Meallmore", "MEARS GROUP PLC",
  "Ian Williams", "Care UK", "Bluebird Care", "IT Career Switch",
  "IT Online Learning", "OneForma", "Lightfoot", "Attention Seekers",
  "Bacardi", "Deliveroo", "Spotify", "Marie Curie", "NFU Mutual", "Culina Group",
  "Search Laboratory", "Reed", "Reed.co.uk", "Accenture", "Deloitte",
  // Academy trusts / schools are EMPLOYERS — the "Trust Education" pattern and the
  // "education agency" pattern must never sweep these in.
  "Oasis Community Learning", "United Learning Trust", "Harris Federation",
  "The Priory Learning Trust", "Ark Schools", "Girls' Day School Trust",
];

console.log("#5 recruiter detection");
for (const c of SHOULD_FLAG) {
  const r = detectRecruiter(null, c);
  check(`flags "${c}"`, r.is_recruiter, `got is_recruiter=false`);
}
for (const c of SHOULD_NOT_FLAG) {
  const r = detectRecruiter(null, c);
  check(`does NOT flag "${c}"`, !r.is_recruiter, `false-positive via ${r.reason}`);
}
// SIC path unchanged: a placement-agency SIC still flags even with a clean name.
check("SIC 78200 still flags", detectRecruiter(["78200"], "Anytown Care Homes").is_recruiter);

// -------------------------------------------------------------- #7 proximity ----
console.log("\n#7 proximity / exact-town");
const R = 25;

// No-op guards: a nationwide / remote search never reorders on distance.
const nw = proximityAlignment({ distanceMiles: 0, radiusMiles: R, isNationwide: true });
check("nationwide search is a hard no-op", nw.adjustment === 0 && nw.applies === false);
const noRadius = proximityAlignment({ distanceMiles: 5, radiusMiles: null, isNationwide: false });
check("no radius is a no-op", noRadius.adjustment === 0 && noRadius.applies === false);
const zeroRadius = proximityAlignment({ distanceMiles: 5, radiusMiles: 0, isNationwide: false });
check("zero radius is a no-op", zeroRadius.adjustment === 0 && zeroRadius.applies === false);

// Unplaceable job on an anchored search: the search applies, the job gets no lift
// (null distance is "cannot speak", never a penalty).
const nullDist = proximityAlignment({ distanceMiles: null, radiusMiles: R, isNationwide: false });
check("null distance → applies but 0 bonus", nullDist.applies === true && nullDist.adjustment === 0);

// Exact town = full bonus; edge / beyond radius = 0; never negative.
const exact = proximityAlignment({ distanceMiles: 0, radiusMiles: R, isNationwide: false });
check("distance 0 → full bonus (10)", exact.adjustment === 10, `got ${exact.adjustment}`);
const atEdge = proximityAlignment({ distanceMiles: R, radiusMiles: R, isNationwide: false });
check("distance == radius → 0 bonus", atEdge.adjustment === 0, `got ${atEdge.adjustment}`);
const beyond = proximityAlignment({ distanceMiles: 40, radiusMiles: R, isNationwide: false });
check("distance > radius → clamped to 0 (never negative)", beyond.adjustment === 0, `got ${beyond.adjustment}`);

// Strictly monotonic decreasing with distance — the whole point: exact/nearest town
// floats above within-radius neighbours. Mirrors the Sheffield teacher spread.
const spread = [0, 6, 10, 13, 18, 23].map((d) =>
  proximityAlignment({ distanceMiles: d, radiusMiles: R, isNationwide: false }).adjustment
);
let monotonic = true;
for (let i = 1; i < spread.length; i++) if (!(spread[i] < spread[i - 1])) monotonic = false;
check("nearer town always scores strictly higher", monotonic, `bonuses=${JSON.stringify(spread)}`);
console.log(`     Sheffield-shape bonuses (0/6/10/13/18/23 mi @ r=25): ${JSON.stringify(spread)}`);

console.log(`\n${failures === 0 ? "✅ ALL SELECTION-SIGNAL ASSERTIONS PASSED" : "❌ " + failures + " ASSERTION(S) FAILED"}`);
process.exit(failures === 0 ? 0 : 1);
