// Canonical job identity — cross-source dedupe.
//
// THE PROBLEM
// -----------
// Before ATS-direct, every job arrived from exactly one aggregator, and the
// existing `dedupe_hash` (company|title|jd[:500]) was enough.
//
// Now the SAME role arrives up to three ways: the employer posts it on their
// Greenhouse board, Reed scrapes it, Adzuna scrapes it. Those three records have
// different source ids, different URLs, and — fatally for `dedupe_hash` — DIFFERENT
// JD TEXT, because each aggregator reformats the description and bolts its own
// boilerplate on. So `dedupe_hash` sees three distinct jobs and the user's
// shortlist fills with triplicates.
//
// A canonical identity has to survive that. It can only use what all three
// sources agree on: WHO is hiring, WHAT the role is, and WHERE it is.
//
//     canonical_key = normalised_company | title_token_set | place
//
// TITLE_TOKEN_SET, not the title string. Sources word titles differently:
//   Reed        "Supply Chain Analyst"
//   ATS         "Analyst, Supply Chain"
//   Adzuna      "Supply Chain Analyst - Birmingham"
// Sorting the stemmed content words collapses all three to `analyst|chain|supply`.
//
// WHAT WE DELIBERATELY DO *NOT* STRIP
// -----------------------------------
// Seniority. "Senior Data Analyst" and "Junior Data Analyst" are genuinely
// different jobs and must never merge. (The TITLE FILTER in pipeline.ts does strip
// seniority — different job, different rule. Don't unify them.)
//
// KNOWN, ACCEPTED IMPRECISION
// ---------------------------
// Two genuinely distinct openings with the same title, company and town — say two
// separate "Software Engineer" reqs in London — collapse to one shortlist row. That
// is the right trade for a job seeker (they'd apply once anyway), and in practice
// ATS titles disambiguate themselves ("Software Engineer, Payments"). Under-merging
// is the worse failure: it shows the user the same job three times and destroys
// trust in the whole product.

import { createHash } from "crypto";
import { stemWord, TITLE_STOP } from "./text";
import { normaliseCompanyName } from "@/lib/enrichment/normalise-company";
import { isAtsSource, type SourceType } from "./types";

/** Requisition ids: "R-256224", "REF97395W", "#11026", "(JR12345)". Pure noise. */
const REQ_ID = /\b(?:req|ref|jr|r)[-_ ]?\d{3,}[a-z]?\b|#\d{3,}\b|\b[a-z]{1,3}-\d{4,}\b/gi;

/**
 * Trailing qualifiers that describe the ARRANGEMENT, not the role. Sources bolt
 * these onto titles inconsistently — Reed loves "- Hybrid", ATS boards don't —
 * so they must not affect identity.
 */
const ARRANGEMENT_WORDS = new Set([
  "remote", "hybrid", "onsite", "on", "site", "wfh", "homebased", "home", "based",
  "permanent", "perm", "contract", "temporary", "temp", "fixed", "term", "ftc",
  "fulltime", "parttime", "full", "part", "time", "maternity", "cover", "month",
  "months", "interim", "freelance", "urgent", "new", "immediate", "start",
]);

function stripDiacritics(s: string): string {
  return s.normalize("NFKD").replace(/[̀-ͯ]/g, "");
}

/**
 * Generic corporate descriptors, stripped from the END of a company name only.
 *
 * THE PROBLEM THIS SOLVES is the whole reason cross-source dedupe exists: the
 * aggregators write a company's formal name and the employer's own ATS writes the
 * brand.
 *     Reed        "Monzo Bank Ltd"
 *     Adzuna      "Monzo Bank"
 *     Greenhouse  "Monzo"
 * normaliseCompanyName() peels "Ltd" but not "Bank", so the ATS copy hashed
 * differently from the other two and the duplicate sailed straight through — the
 * exact failure the feature was built to prevent.
 *
 * TRAILING-ONLY, and never to nothing. Stripping these words anywhere in the name
 * would fuse genuinely different companies; peeling them off the tail does not:
 *     "Lloyds Bank" and "Lloyds Banking Group"  → both "lloyds"     (right: same bank)
 *     "Virgin Money" vs "Virgin Media"          → stay distinct     ("money"/"media"
 *                                                  are not descriptors, so nothing is peeled)
 */
const COMPANY_DESCRIPTORS = new Set([
  "bank", "banking", "group", "holdings", "holding", "plc",
  "uk", "gb", "ireland", "international", "global", "worldwide", "europe", "emea",
  "technologies", "technology", "solutions", "services", "systems",
  "company", "co", "corporation", "enterprises", "industries", "partners",
]);

/**
 * The company component of a job's identity. Deterministic per-record — it must be,
 * because canonical_key is PERSISTED and the cross-search "already decided" gate
 * looks jobs up by it. A key that depended on which records happened to share a run
 * would change between runs and silently un-block jobs the user already rejected.
 */
export function companyIdentity(raw: string): string {
  const words = normaliseCompanyName(raw).split(" ").filter(Boolean);
  while (words.length > 1 && COMPANY_DESCRIPTORS.has(words[words.length - 1])) {
    words.pop();
  }
  return words.join(" ");
}

/**
 * Reduce a job title to its identity token set.
 *
 * `locationRaw` is passed in for a specific reason: it lets us kill a trailing
 * location suffix WITHOUT needing a gazetteer. If the tail of the title also
 * appears in the job's own location field ("Supply Chain Analyst - Birmingham"
 * where location_raw is "Birmingham"), it's a location suffix, not part of the
 * role. That trick generalises to any town on earth for free.
 */
export function titleIdentityTokens(title: string, locationRaw?: string | null): string[] {
  let t = stripDiacritics(title || "").toLowerCase();

  // Drop parenthesised/bracketed asides: "(Remote)", "(12 month FTC)", "(R-256224)".
  t = t.replace(/[([{][^)\]}]*[)\]}]/g, " ");
  t = t.replace(REQ_ID, " ");

  // Drop a trailing segment after " - " / " | " / " – " when it's an arrangement
  // word or echoes the job's own location. Bounded to the LAST segment so we
  // never eat a real role ("Head of Supply Chain - Europe" keeps the head/supply/chain).
  const locWords = new Set(
    stripDiacritics(locationRaw || "")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2)
  );
  const segments = t.split(/\s+[-–|]\s+/);
  if (segments.length > 1) {
    const tail = segments[segments.length - 1].trim();
    const tailWords = tail.split(/\s+/).filter(Boolean);
    const droppable =
      tailWords.length > 0 &&
      tailWords.length <= 4 &&
      tailWords.every((w) => ARRANGEMENT_WORDS.has(w) || locWords.has(w) || /^\d+$/.test(w));
    if (droppable) t = segments.slice(0, -1).join(" ");
  }

  const words = t
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .filter((w) => !TITLE_STOP.has(w))
    .filter((w) => !ARRANGEMENT_WORDS.has(w))
    .filter((w) => w.length > 1)
    .map(stemWord);

  // SORTED + de-duplicated: "Analyst, Supply Chain" === "Supply Chain Analyst".
  return Array.from(new Set(words)).sort();
}

/**
 * The place component of identity. Town-level, because sources disagree below
 * that ("London" vs "London, Greater London" vs "EC2A 4BX") but agree on the town.
 * Remote roles key on "remote" — the same remote job listed by three sources is
 * one job.
 */
export function placeIdentity(opts: {
  placeName?: string | null;
  isRemote?: boolean | null;
  locationRaw?: string | null;
}): string {
  if (opts.placeName) return stripDiacritics(opts.placeName).toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (opts.isRemote) return "remote";
  const raw = stripDiacritics(opts.locationRaw || "").toLowerCase();
  if (/\bremote\b|work from home|\bwfh\b/.test(raw)) return "remote";
  // No usable place: key on empty. Two records with no location and the same
  // company+title are still almost certainly the same job.
  return "";
}

export interface CanonicalInput {
  company: string;
  title: string;
  location_raw?: string | null;
  /** Resolved town, if the geo layer got one. Much stronger than the raw string. */
  place_name?: string | null;
  is_remote?: boolean | null;
}

/** Stable 16-hex identity for a posting, shared across every source that carries it. */
export function canonicalKey(input: CanonicalInput): string {
  const company = companyIdentity(input.company);
  const title = titleIdentityTokens(input.title, input.location_raw).join(" ");
  const place = placeIdentity({
    placeName: input.place_name,
    isRemote: input.is_remote,
    locationRaw: input.location_raw,
  });

  // An empty company or title would collapse unrelated jobs into one bucket —
  // far worse than failing to dedupe. Fall back to a per-record unique key so
  // such a record can only ever match itself.
  if (!company || !title) {
    return createHash("sha256")
      .update(`nokey|${input.company}|${input.title}|${input.location_raw ?? ""}`)
      .digest("hex")
      .slice(0, 16);
  }

  return createHash("sha256").update(`${company}|${title}|${place}`).digest("hex").slice(0, 16);
}

// ---------------------------------------------------------------------------
// Which copy of a duplicated job wins?
// ---------------------------------------------------------------------------

/**
 * Preference score for a record. Higher wins.
 *
 * ATS-direct always beats an aggregator, and it isn't close: it's the employer's
 * own posting, so the URL applies directly (no Reed redirect wall), the JD is the
 * real one rather than an agency's rewrite, and the company is the actual employer
 * rather than "Client of Hays". Beyond that we prefer records that carry more
 * usable signal — a real salary, a fuller JD, a known post date.
 */
export function sourcePreference(rec: {
  source: SourceType;
  salary_min: number | null;
  salary_max: number | null;
  jd_text: string;
  posted_at: string | null;
}): number {
  let score = 0;
  if (isAtsSource(rec.source)) score += 1000;
  else if (rec.source === "adzuna") score += 200; // higher title precision than Reed in practice
  else if (rec.source === "reed") score += 100;

  if (rec.salary_min || rec.salary_max) score += 40;
  score += Math.min(30, Math.floor((rec.jd_text?.length ?? 0) / 200));
  if (rec.posted_at) score += 10;
  return score;
}

export interface DedupedGroup<T> {
  /** The record we show the user. */
  winner: T;
  /** Every other source carrying the same job — provenance, shown as "also on Reed". */
  also_seen_on: SourceType[];
  duplicates_merged: number;
}

/**
 * Collapse records that are the same real-world job.
 *
 * `keyOf` must return the canonical key; `recOf` extracts the fields the
 * preference scorer needs.
 */
export function dedupeByCanonicalKey<T>(
  records: T[],
  keyOf: (r: T) => string,
  recOf: (r: T) => {
    source: SourceType;
    salary_min: number | null;
    salary_max: number | null;
    jd_text: string;
    posted_at: string | null;
  }
): DedupedGroup<T>[] {
  const groups = new Map<string, T[]>();
  for (const r of records) {
    const k = keyOf(r);
    const g = groups.get(k);
    if (g) g.push(r);
    else groups.set(k, [r]);
  }

  const out: DedupedGroup<T>[] = [];
  for (const group of groups.values()) {
    let winner = group[0];
    let best = sourcePreference(recOf(winner));
    for (let i = 1; i < group.length; i++) {
      const s = sourcePreference(recOf(group[i]));
      if (s > best) {
        best = s;
        winner = group[i];
      }
    }
    const winnerSource = recOf(winner).source;
    const also = Array.from(
      new Set(group.map((r) => recOf(r).source).filter((s) => s !== winnerSource))
    );
    out.push({ winner, also_seen_on: also, duplicates_merged: group.length - 1 });
  }
  return out;
}
