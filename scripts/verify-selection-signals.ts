/**
 * scripts/verify-selection-signals.ts — pure-unit proof for the selection signals
 * added for SEARCH_QUALITY_BASELINE_2026-07-19: #5 (recruiter catch), #7 (proximity
 * / exact-town), and #4 (multi-word title precision + "Distributed"/global location
 * treated as non-UK). The repo has no unit-test runner, so — as with the audit
 * scoreboard — the proof is a runnable script that exits non-zero on any failed
 * assertion. Fast (no keys; #4's geo cases resolve fully offline — no network):
 *   `npx tsx scripts/verify-selection-signals.ts`.
 */
import { detectRecruiter } from "../lib/enrichment/recruiter-detect";
import { proximityAlignment } from "../lib/job-search/proximity-align";
import { titleRelevantOne, titleRelevantAny, buildTargets } from "../lib/job-search/title-match";
import { resolveJobLocation, isGlobalRemoteText } from "../lib/geo";

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

// --------------------------------------------------- #4a multi-word title precision ----
// A qualifier must genuinely MODIFY the role noun — not merely appear in the string.
// [chip, jobTitle, shouldKeep].
console.log("\n#4 title precision — multi-word core-noun matching");
const TITLE_CASES: Array<[string, string, boolean]> = [
  // ── precision: the two documented false positives + their family MUST drop ──
  ["Marketing Manager", "Senior Procurement Category Manager - Marketing", false], // "marketing" is a detached dept tag
  ["Marketing Manager", "Digital Trading Manager", false],                          // a Trading Manager, not a Marketing one
  ["Digital Marketing Manager", "Digital Trading Manager", false],                  // only the peripheral "digital" matched
  ["Construction Site Manager", "Marketing Manager", false],                        // the documented bare-"manager" case
  ["Software Engineer", "Sales Engineer", false],                                   // different discipline
  // ── recall: genuine matches MUST survive ──
  ["Marketing Manager", "Marketing Manager", true],
  ["Marketing Manager", "Senior Marketing Manager", true],
  ["Marketing Manager", "Digital Marketing Manager", true],
  ["Marketing Manager", "Marketing Communications Manager", true],                  // inserted modifier, same part
  ["Software Engineer", "Software Development Engineer", true],                      // inserted modifier, same part
  ["Software Engineer", "Senior Software Engineer", true],
  ["Construction Site Manager", "Construction Manager", true],                      // documented: partial-qualifier match
  ["Construction Site Manager", "Site Manager", true],                              // documented: partial-qualifier match
  ["Digital Marketing Manager", "Marketing Manager", true],
  ["Primary School Teacher", "KS2 Primary Teacher", true],
];
for (const [chip, title, keep] of TITLE_CASES) {
  const [tgt] = buildTargets([chip]);
  const got = titleRelevantOne(title, tgt.phrase, tgt.words);
  check(`${keep ? "keeps" : "drops"} "${title}"  ⟵  "${chip}"`, got === keep, `got ${got}`);
}
// Multi-chip, mirroring the live Marketing/London search (#1) target_titles.
const MKT = buildTargets(["Marketing Manager", "Senior Marketing Manager", "Brand Manager", "Digital Marketing Manager"]);
check('any(): drops "…Category Manager - Marketing"', !titleRelevantAny("Senior Procurement Category Manager - Marketing", MKT));
check('any(): drops "Digital Trading Manager"', !titleRelevantAny("Digital Trading Manager", MKT));
check('any(): keeps "Marketing Manager UK/IE"', titleRelevantAny("Marketing Manager UK/IE", MKT));
check('any(): keeps "Brand Manager"', titleRelevantAny("Brand Manager", MKT));

// -------------------------------- #4b location — global-remote is non-UK unless UK resolves ----
async function geoChecks() {
  console.log('\n#4 location — "Distributed"/global is non-UK unless a UK place resolves');
  // Pure predicate: the global-remote qualifiers, and the ordinary (UK-context) ones that must NOT trip it.
  for (const w of ["Distributed", "Anywhere", "Worldwide", "Global", "International"]) {
    check(`isGlobalRemoteText("${w}")`, isGlobalRemoteText(w));
  }
  for (const w of ["Remote", "WFH", "Home-based", "London", "Remote (UK)"]) {
    check(`NOT global-remote "${w}"`, !isGlobalRemoteText(w));
  }
  // The flag the place-anchored pipeline drops on. All of these resolve OFFLINE
  // (no geocode call): "Distributed"/"Anywhere" strip to empty; "UK" is a qualifier;
  // "London"/"Manchester" are gazetteer hits.
  const LOC_CASES: Array<[string, boolean]> = [
    ["Distributed", true],          // the Cloudflare Washington-DC case
    ["Distributed; Hybrid", true],  // the other Cloudflare case
    ["Remote (UK)", false],         // UK named → country-only, a genuine UK remote role
    ["Anywhere, UK", false],        // "Anywhere" but a UK qualifier resolves → NOT global
    ["London", false],              // a real UK place → NOT global
    ["Manchester", false],
  ];
  for (const [raw, want] of LOC_CASES) {
    const loc = await resolveJobLocation(raw);
    check(
      `resolveJobLocation("${raw}").is_global_remote === ${want}`,
      loc.is_global_remote === want,
      `got ${loc.is_global_remote} (foreign=${loc.is_foreign} countryOnly=${loc.is_country_only} places=${loc.places.length})`
    );
  }
}

geoChecks().then(() => {
  console.log(`\n${failures === 0 ? "✅ ALL SELECTION-SIGNAL ASSERTIONS PASSED" : "❌ " + failures + " ASSERTION(S) FAILED"}`);
  process.exit(failures === 0 ? 0 : 1);
});
