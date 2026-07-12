/**
 * Proof that lib/geo actually keeps foreign jobs out of a UK radius search.
 *
 *   npx tsx scripts/verify-geo.ts
 *
 * Exits NON-ZERO on any failure. Hits postcodes.io for real (the long-tail path
 * is the half most likely to rot silently), so it needs a network connection.
 *
 * Every case below is a real string pulled off a live ATS board on 2026-07-12,
 * or one of the genuine ambiguities that will otherwise silently drop or admit
 * real jobs ("Birmingham, AL", "Dublin", "London, United Kingdom").
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// .env.local is optional here: with it, the Supabase geo_cache path is exercised;
// without it, lib/geo must still work off the in-process cache alone. Either way
// the assertions below must pass — that is the point of the guard in geocode.ts.
function loadEnvLocal() {
  try {
    const raw = readFileSync(resolve(process.cwd(), ".env.local"), "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const eq = t.indexOf("=");
      if (eq === -1) continue;
      const k = t.slice(0, eq).trim();
      let v = t.slice(eq + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (!process.env[k]) process.env[k] = v;
    }
  } catch {
    console.log("(no .env.local — running with the in-process cache only)\n");
  }
}
loadEnvLocal();

import {
  distanceMiles,
  geocodeUk,
  resolveJobLocation,
  resolveOrigin,
  warmCache,
  type JobLocation,
} from "@/lib/geo";

let failures = 0;

function ok(label: string, detail = "") {
  console.log(`  PASS  ${label}${detail ? `  ${detail}` : ""}`);
}
function bad(label: string, detail: string) {
  failures++;
  console.log(`  FAIL  ${label}  ${detail}`);
}
function check(label: string, cond: boolean, detail: string) {
  if (cond) ok(label, detail);
  else bad(label, detail);
}

function summarise(loc: JobLocation): string {
  const names = loc.places.map((p) => `${p.name}(${p.country},${p.source})`).join(" + ") || "-";
  const flags = [
    loc.is_remote ? "remote" : "",
    loc.is_foreign ? "FOREIGN" : "",
    loc.is_country_only ? "country-only" : "",
    loc.is_unresolved ? "unresolved" : "",
  ].filter(Boolean).join(",") || "none";
  return `places=[${names}] flags=[${flags}]`;
}

async function main() {
  console.log("=== 1. Multi-location strings (a missed candidate hides a real job)\n");

  const monzo = await resolveJobLocation("Cardiff, London or Remote (UK)");
  const monzoNames = monzo.places.map((p) => p.name).sort();
  check(
    '"Cardiff, London or Remote (UK)" -> Cardiff + London, remote, not foreign',
    monzo.places.length === 2 &&
      monzoNames[0] === "Cardiff" &&
      monzoNames[1] === "London" &&
      monzo.places.every((p) => p.country === "GB") &&
      monzo.is_remote &&
      !monzo.is_foreign,
    summarise(monzo)
  );

  const monzo2 = await resolveJobLocation("London; Remote (UK)");
  check(
    '"London; Remote (UK)" -> London, remote',
    monzo2.places.length === 1 &&
      monzo2.places[0].name === "London" &&
      monzo2.is_remote &&
      !monzo2.is_foreign,
    summarise(monzo2)
  );

  const oneLondon = await resolveJobLocation("London, United Kingdom");
  check(
    '"London, United Kingdom" -> ONE place (comma tail is a qualifier, not a 2nd place)',
    oneLondon.places.length === 1 && oneLondon.places[0].name === "London" && !oneLondon.is_foreign,
    summarise(oneLondon)
  );

  console.log("\n=== 2. Foreign detection (the safety-critical half)\n");

  const foreignCases: string[] = [
    "Palo Alto, CA",
    "Seoul, South Korea",
    "US - Gaithersburg - MD",
    "Dublin",                      // Ireland is NOT the UK
    "Vilnius, Lithuania",
    "Washington, D.C.",
    "Amsterdam, Noord-Holland, Netherlands",
    "New York City",
    "Munich",
    "Barcelona",
    "Austin",
    "Seattle",
    "Paris",
    "Berlin",
    "Singapore",
    "Remote (US)",
    "US Remote",
    "Remote - Americas",
    "Newcastle, NSW",
    "London, ON",
    "Cambridge, MA",
    "Dublin, OH",
  ];
  for (const raw of foreignCases) {
    const loc = await resolveJobLocation(raw);
    check(
      `"${raw}" -> is_foreign, 0 places`,
      loc.is_foreign && loc.places.length === 0,
      summarise(loc)
    );
  }

  console.log("\n=== 3. THE ORDERING TEST — a foreign qualifier must beat the UK gazetteer\n");

  const bhamUk = await resolveJobLocation("Birmingham");
  const p = bhamUk.places[0];
  check(
    '"Birmingham" (bare) -> GB ~52.48,-1.90',
    !!p && p.country === "GB" && Math.abs(p.lat - 52.48) < 0.1 && Math.abs(p.lng + 1.9) < 0.1,
    summarise(bhamUk)
  );

  const bhamAl = await resolveJobLocation("Birmingham, AL");
  check(
    '"Birmingham, AL" -> is_foreign  <-- if this fails, Alabama is inside "within 25 miles of Birmingham"',
    bhamAl.is_foreign && bhamAl.places.length === 0,
    summarise(bhamAl)
  );
  const bhamAlabama = await resolveJobLocation("Birmingham, Alabama");
  check('"Birmingham, Alabama" -> is_foreign', bhamAlabama.is_foreign, summarise(bhamAlabama));

  console.log("\n=== 4. UK places, including the ones that look foreign\n");

  const belfast = await resolveJobLocation("Belfast");
  check(
    '"Belfast" -> GB (Northern Ireland IS the UK)',
    belfast.places.length === 1 && belfast.places[0].country === "GB" && !belfast.is_foreign,
    summarise(belfast)
  );

  const bangor = await resolveJobLocation("Bangor, Co. Down");
  check(
    '"Bangor, Co. Down" -> GB (the "Co" tail must NOT be read as Colombia)',
    bangor.places.length === 1 && bangor.places[0].country === "GB" && !bangor.is_foreign,
    summarise(bangor)
  );

  const solihull = await resolveJobLocation("Solihull");
  check(
    '"Solihull" -> resolves (gazetteer or postcodes.io)',
    solihull.places.length === 1 && solihull.places[0].country === "GB",
    summarise(solihull)
  );

  // A town deliberately NOT in the gazetteer: proves the postcodes.io long-tail
  // path is alive. If this one fails, the gazetteer is carrying the whole test
  // and the API fallback could be broken without anyone noticing.
  const bicester = await resolveJobLocation("Bicester");
  check(
    '"Bicester" (NOT in the gazetteer) -> resolved via postcodes.io',
    bicester.places.length === 1 && bicester.places[0].source === "postcodes.io",
    summarise(bicester)
  );

  for (const [raw, expected] of [
    ["Greater London", "London"],
    ["City of London", "London"],
    ["Newcastle", "Newcastle upon Tyne"],
    ["Stoke-on-Trent", "Stoke-on-Trent"],
    ["Derry", "Londonderry"],
  ] as const) {
    const loc = await resolveJobLocation(raw);
    check(
      `alias "${raw}" -> ${expected}`,
      loc.places.length === 1 && loc.places[0].name === expected,
      summarise(loc)
    );
  }

  const solihullQualified = await resolveJobLocation("Solihull, West Midlands");
  check(
    '"Solihull, West Midlands" -> ONE place (county tail is a qualifier)',
    solihullQualified.places.length === 1 && solihullQualified.places[0].name === "Solihull",
    summarise(solihullQualified)
  );

  console.log("\n=== 5. Country-only and remote\n");

  const uk = await resolveJobLocation("UK");
  check(
    '"UK" -> is_country_only, no places, NOT foreign, NOT unresolved',
    uk.is_country_only && uk.places.length === 0 && !uk.is_foreign && !uk.is_unresolved,
    summarise(uk)
  );

  const england = await resolveJobLocation("England");
  check('"England" -> is_country_only', england.is_country_only && !england.is_foreign, summarise(england));

  const ukRemote = await resolveJobLocation("UK Remote");
  check(
    '"UK Remote" -> remote AND country-only (GB)',
    ukRemote.is_remote && ukRemote.is_country_only && !ukRemote.is_foreign,
    summarise(ukRemote)
  );

  const bareRemote = await resolveJobLocation("Remote");
  check(
    '"Remote" (bare) -> is_remote, unresolved, not foreign, no places',
    bareRemote.is_remote && bareRemote.is_unresolved && !bareRemote.is_foreign && bareRemote.places.length === 0,
    summarise(bareRemote)
  );

  const europe = await resolveJobLocation("Europe");
  check(
    '"Europe" -> NOT foreign (the UK is in Europe) but no place either',
    !europe.is_foreign && europe.places.length === 0,
    summarise(europe)
  );

  console.log("\n=== 6. Provider hints (SmartRecruiters ships coordinates)\n");

  const hinted = await resolveJobLocation("Some Office", { lat: 51.5, lng: -0.12, countryHint: "GB" });
  check(
    "provider lat/lng inside the UK -> a place",
    hinted.places.length === 1 && hinted.places[0].source === "provider",
    summarise(hinted)
  );
  const hintedForeign = await resolveJobLocation("HQ", { lat: 37.44, lng: -122.14, countryHint: "US" });
  check(
    "provider lat/lng in Palo Alto -> is_foreign",
    hintedForeign.is_foreign && hintedForeign.places.length === 0,
    summarise(hintedForeign)
  );

  console.log("\n=== 7. Distance\n");

  const origin = await resolveOrigin("B1 1AA");
  check(
    'resolveOrigin("B1 1AA") -> ~52.48,-1.90',
    !!origin && Math.abs(origin.lat - 52.48) < 0.1 && Math.abs(origin.lng + 1.9) < 0.1,
    origin ? `${origin.lat.toFixed(4)},${origin.lng.toFixed(4)}` : "null"
  );

  if (origin) {
    const dSolihull = distanceMiles(origin, solihull);
    check(
      "Birmingham(B1) -> Solihull is 6-8 miles",
      dSolihull !== null && dSolihull >= 6 && dSolihull <= 8,
      `${dSolihull?.toFixed(2)} mi`
    );

    const london = await resolveJobLocation("London");
    const dLondon = distanceMiles(origin, london);
    check(
      "Birmingham(B1) -> London is 100-105 miles",
      dLondon !== null && dLondon >= 100 && dLondon <= 105,
      `${dLondon?.toFixed(2)} mi`
    );

    // The multi-place rule: nearest option wins.
    // Cardiff is ~88mi from Birmingham, London ~101mi. The MINIMUM must win, or a
    // job in "Cardiff or London" is judged by whichever place happened to parse first.
    const dMonzo = distanceMiles(origin, monzo);
    check(
      '"Cardiff, London or Remote (UK)" from Birmingham -> the NEAREST option (Cardiff ~88mi, not London ~101mi)',
      dMonzo !== null && dMonzo > 85 && dMonzo < 90,
      `${dMonzo?.toFixed(2)} mi`
    );

    check(
      "distanceMiles(pure remote) -> null (null is NOT zero — the caller decides)",
      distanceMiles(origin, bareRemote) === null,
      "null"
    );

    // What the whole module is FOR: a 25-mile Birmingham search must not admit
    // Palo Alto, and MUST admit Solihull.
    const paloAlto = await resolveJobLocation("Palo Alto, CA");
    const within25 = (l: JobLocation) => {
      if (l.is_foreign) return false;
      const d = distanceMiles(origin, l);
      return d !== null && d <= 25;
    };
    check("END-TO-END: Palo Alto is NOT within 25 miles of Birmingham", !within25(paloAlto), "dropped");
    check("END-TO-END: Solihull IS within 25 miles of Birmingham", within25(solihull), "kept");
    check("END-TO-END: London is NOT within 25 miles of Birmingham", !within25(london), "dropped");
  }

  console.log("\n=== 8. warmCache (batched, concurrency 5) + never-throws contract\n");

  // None of these are in the gazetteer, so every one is a real postcodes.io call.
  const warm = [
    "Nantwich", "Sevenoaks", "Rugeley", "Halesowen", "Wokingham",
    "Dorking", "Skipton", "Alnwick", "Llandudno", "Kirkwall",
  ];
  const junk = ["Totally Not A Place 12345", "TBD", "Global"];

  const t0 = Date.now();
  await warmCache([...warm, ...junk]);
  const warmMs = Date.now() - t0;

  // Prove it actually RESOLVED them, not just that it returned.
  const warmed = await Promise.all(warm.map((q) => geocodeUk(q)));
  const resolvedCount = warmed.filter((w) => w && w.country === "GB").length;
  check(
    `warmCache resolved all ${warm.length} long-tail towns (concurrency 5)`,
    resolvedCount === warm.length,
    `${resolvedCount}/${warm.length} in ${warmMs} ms`
  );

  const junkResults = await Promise.all(junk.map((q) => geocodeUk(q)));
  check(
    "warmCache cached the 3 unresolvable strings as MISSES (not re-queried forever)",
    junkResults.every((j) => j === null),
    JSON.stringify(junkResults)
  );

  // The second pass must be served from the in-process cache: no network at all.
  const t1 = Date.now();
  await Promise.all([...warm, ...junk].map((q) => geocodeUk(q)));
  const cachedMs = Date.now() - t1;
  check(
    "second pass is served from cache (< 20 ms for 13 queries)",
    cachedMs < 20,
    `${cachedMs} ms`
  );

  for (const nasty of ["", "   ", "???", "🌍", "Remote / Anywhere / Global / TBD"]) {
    try {
      const loc = await resolveJobLocation(nasty);
      ok(`never throws on ${JSON.stringify(nasty)}`, summarise(loc));
    } catch (e) {
      bad(`never throws on ${JSON.stringify(nasty)}`, String(e));
    }
  }
  try {
    const loc = await resolveJobLocation(null);
    ok("never throws on null", summarise(loc));
  } catch (e) {
    bad("never throws on null", String(e));
  }

  console.log("");
  if (failures > 0) {
    console.log(`${failures} FAILURE(S).`);
    process.exit(1);
  }
  console.log("ALL CHECKS PASSED.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
