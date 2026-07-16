// The universal job reader: schema.org JobPosting JSON-LD.
//
// WHY THIS EXISTS
// ---------------
// The six native adapters cover the ATSs London scaleups use. The UK's regional
// and enterprise employers sit on Oracle Recruiting Cloud, Phenom, Eploy,
// SuccessFactors, custom WordPress sites — dozens of vendors, each of which
// would need its own adapter. But nearly every one of them embeds machine-
// readable schema.org JobPosting JSON-LD in its public job pages, because that
// is how Google for Jobs indexes them. LinkedIn and Indeed don't create jobs,
// they syndicate them; the JSON-LD on the employer's own page IS the original.
// One crawler that reads it covers every vendor at once — the last rung of the
// discovery ladder, used only when no supported ATS embed is found.
//
// HOW A BOARD IS ADDRESSED
// ------------------------
// token = the careers site URL (the listing entry point). Job pages are found
// via, in order: the site's sitemaps (robots.txt declarations first), then
// anchor links on the listing page, then anchor links on the PLAYWRIGHT-RENDERED
// listing page — many careers sites inject their job list with JavaScript
// (boots.jobs renders its links client-side even though every DETAIL page is
// perfectly static). Boards that need rendering carry renderMode="playwright"
// and are only pulled where a browser exists (the offline script, not Vercel).
//
// THE TRUST RULES (every one of these guards a trap that was live somewhere)
// --------------------------------------------------------------------------
// 1. MORE THAN ONE DISTINCT hiringOrganization ⇒ NOT AN EMPLOYER'S SITE.
//    A jobs board's pages carry many employers' JobPostings. Crawling reed.co.uk
//    once harvested Howden Joinery's board and filed it under "Reed" — recruiter-
//    branded first-party supply, the exact inversion of the moat. An employer's
//    careers site names ONE org (possibly with cosmetic variants: "Boots" /
//    "Boots UK Ltd"). Anything else ⇒ refuse the entire pull.
// 2. ENUMERATED > 0 BUT PARSED = 0 IS AN ERROR, NEVER "no jobs matched".
//    A crawler that finds 300 job URLs and extracts nothing is broken (site
//    redesign, blocking, markup change) — returning [] would be the Adzuna
//    failure mode: a dead source indistinguishable from an empty market.
// 3. The JSON-LD is EMPLOYER-AUTHORED FREE TEXT. Locations pass through lib/geo
//    downstream (site-descriptor strip + foreign veto); addressCountry is handed
//    over as country_hint, which BEATS the gazetteer everywhere. Junk
//    placeholders ("-", "n/a") are stripped here so they never reach geo.
// 4. robots.txt is respected: declared sitemaps are used, disallowed paths are
//    not fetched, and the whole pull is rate-limited per domain.

import type { AtsBoard, AtsProbeResult, AtsPullResult } from "../types";
import type { RawJob } from "@/lib/job-search/types";
import { normaliseCompanyName } from "@/lib/enrichment/normalise-company";
import { withBrowser } from "../render";
import {
  type AtsProviderImpl,
  type AtsPullOptions,
  budgetDeadline,
  canonEmploymentType,
  decodeThenHtmlToText,
  errMsg,
  jobCap,
  mapWithConcurrency,
  mergeCandidates,
  parseLooseUtc,
  safeIso,
  toIso2,
} from "./_util";

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/**
 * One JSON-LD job = one page fetch (an N+1 against the employer's own webserver,
 * not a vendor API built for polling). 3 concurrent + a per-request delay is a
 * politer rate than we use against Workday. The cost is wall clock, which the
 * budget already bounds.
 */
const JSONLD_DETAIL_CONCURRENCY = 3;
const POLITE_DELAY_MS = 150;

/**
 * Hard page-fetch caps per pull. A 3,000-page employer at 3 concurrent polite
 * fetches would eat the entire ingest run; cap and flag `truncated` instead —
 * assertNoSilentTruncation() makes that loud. Rendered pages are ~10× the cost
 * of static ones, so their cap is far lower.
 */
// 1500 clears every ALL-UK board seen so far with room (Boots 1,100, Care UK
// 720, Next 633). Genuinely global boards (Aramark 6,884) still get cut — but
// with UK-first ordering the cut tail is the least-UK part, and `truncated` is
// only flagged when UK-LOOKING pages were left unfetched (see listJobs).
const MAX_STATIC_PAGES = 1500;
const MAX_RENDERED_PAGES = 120;

/** Sitemap fetches per pull (index + children). */
const MAX_SITEMAP_FETCHES = 15;

const UA_HEADER =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36 HuntHQ/1.0 (+https://hunthq.app)";

// ---------------------------------------------------------------------------
// HTTP (text, not JSON — this provider reads HTML and XML)
// ---------------------------------------------------------------------------

async function httpText(
  url: string,
  timeoutMs = 20_000
): Promise<{ status: number; text: string; finalUrl: string } | null> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "follow",
      headers: { "user-agent": UA_HEADER, accept: "text/html,application/xhtml+xml,application/xml,text/xml,text/plain" },
      cache: "no-store",
    });
    return { status: res.status, text: await res.text(), finalUrl: res.url || url };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// robots.txt — sitemaps + disallow rules
// ---------------------------------------------------------------------------

interface RobotsInfo {
  sitemaps: string[];
  /** Disallow path prefixes that apply to us (`*` group; `*` wildcards supported). */
  disallows: string[];
}

async function fetchRobots(origin: string): Promise<RobotsInfo> {
  const info: RobotsInfo = { sitemaps: [], disallows: [] };
  const res = await httpText(`${origin}/robots.txt`, 8_000);
  if (!res || res.status !== 200) return info;

  // Sitemap: lines are global (not group-scoped) per the spec.
  for (const m of res.text.matchAll(/^\s*sitemap:\s*(\S+)/gim)) info.sitemaps.push(m[1]);

  // Collect Disallow rules from every group whose user-agent matches us (`*` or
  // anything naming hunthq). Group = ua lines followed by rule lines.
  let applies = false;
  for (const line of res.text.split(/\r?\n/)) {
    const ua = line.match(/^\s*user-agent:\s*(.+?)\s*$/i);
    if (ua) {
      const agent = ua[1].toLowerCase();
      applies = agent === "*" || agent.includes("hunthq");
      continue;
    }
    if (!applies) continue;
    const dis = line.match(/^\s*disallow:\s*(\S*)\s*$/i);
    if (dis && dis[1]) info.disallows.push(dis[1]);
  }
  return info;
}

/** Simple prefix match with `*` wildcards and `$` end-anchor — covers real robots files. */
export function robotsAllows(disallows: string[], path: string): boolean {
  for (const rule of disallows) {
    const anchored = rule.endsWith("$");
    const body = anchored ? rule.slice(0, -1) : rule;
    const rx = new RegExp(
      "^" + body.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^]*") + (anchored ? "$" : "")
    );
    if (rx.test(path)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// URL discipline
// ---------------------------------------------------------------------------

/**
 * "careers.aldirecruitment.co.uk" and "www.aldirecruitment.co.uk" are the same
 * employer; "www.boots.jobs" and "reed.co.uk" are not. Registrable domain ≈ the
 * last two labels, or three for the .co.uk-style public suffixes.
 */
export function registrableDomain(host: string): string {
  const labels = host.toLowerCase().split(".");
  const twoLevel = /^(co|org|ac|gov|net|sch|nhs|police|ltd|plc|me)\.uk$|^(com|org|net|co)\.[a-z]{2}$/;
  const tail = labels.slice(-2).join(".");
  return twoLevel.test(tail) ? labels.slice(-3).join(".") : tail;
}

/**
 * Does this URL look like a job DETAIL page? Two shapes cover what's in the
 * wild: a path segment (boots.jobs/jobs/277615br-…) and a query id
 * (eploy's vacancy-details.aspx?id=…).
 */
const JOB_PATH_RE =
  /\/(?:jobs?|vacanc(?:y|ies)|positions?|opportunit(?:y|ies)|openings?|roles?)\/[^/?#]*[a-z0-9][^/?#]*\/?$/i;
const JOB_QUERY_RE = /(?:vacancy|job|position|posting|requisition|req|advert)[-_]?(?:id|ref|no)?=[a-z0-9]/i;

/** Pages that live under job-ish paths but are obviously editorial, not postings. */
const NOISE_RE =
  /\/(?:blog|news|stor(?:y|ies)|article|advice|event|categor(?:y|ies)|tag|page|author|benefits|faq|about|team|search|filter|apply-process|login|register)(?:[/?#-]|$)/i;

export function looksLikeJobDetailUrl(url: string): boolean {
  if (NOISE_RE.test(url)) return false;
  try {
    const u = new URL(url);
    return JOB_PATH_RE.test(u.pathname) || JOB_QUERY_RE.test(u.search);
  } catch {
    return false;
  }
}

function normaliseUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    return u.toString();
  } catch {
    return url;
  }
}

// ---------------------------------------------------------------------------
// JSON-LD extraction
// ---------------------------------------------------------------------------

type JsonLdNode = Record<string, unknown>;

function isJobPostingNode(n: unknown): n is JsonLdNode {
  if (!n || typeof n !== "object" || Array.isArray(n)) return false;
  const t = (n as JsonLdNode)["@type"];
  return t === "JobPosting" || (Array.isArray(t) && t.includes("JobPosting"));
}

/** Walk a parsed JSON-LD value and collect every JobPosting node, however nested. */
function collectJobPostings(value: unknown, out: JsonLdNode[], depth = 0): void {
  if (depth > 6 || !value) return;
  if (Array.isArray(value)) {
    for (const v of value) collectJobPostings(v, out, depth + 1);
    return;
  }
  if (typeof value !== "object") return;
  const node = value as JsonLdNode;
  if (isJobPostingNode(node)) {
    out.push(node);
    return; // a JobPosting doesn't nest further JobPostings
  }
  // @graph, mainEntity, itemListElement — the usual wrappers.
  for (const key of ["@graph", "mainEntity", "itemListElement", "item"]) {
    if (node[key]) collectJobPostings(node[key], out, depth + 1);
  }
}

/** Every JobPosting in a page's <script type="application/ld+json"> blocks. */
export function parseJobPostings(html: string): JsonLdNode[] {
  const out: JsonLdNode[] = [];
  const re = /<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    const raw = m[1].replace(/^\s*<!\[CDATA\[/, "").replace(/\]\]>\s*$/, "").trim();
    if (!raw || !raw.includes("JobPosting")) continue;
    try {
      collectJobPostings(JSON.parse(raw), out);
    } catch {
      // Employer-authored JSON is routinely broken (trailing commas, raw
      // newlines in strings). One salvage attempt: strip control chars inside
      // strings — the observed failure mode — then give up quietly.
      try {
        collectJobPostings(JSON.parse(raw.replace(/[\u0000-\u001f]+/g, " ")), out);
      } catch {
        /* not parseable — the per-pull "parsed 0 of N" assertion surfaces it */
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// JobPosting → RawJob
// ---------------------------------------------------------------------------

function asString(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** "-", "n/a", "." — placeholder junk employers put in required fields. */
function realText(v: unknown): string | null {
  const s = asString(v);
  if (!s) return null;
  if (/^[-–—.,/\\]+$/.test(s) || /^n\/?a$/i.test(s)) return null;
  return s;
}

function orgName(v: unknown): string | null {
  if (typeof v === "string") return realText(v);
  if (v && typeof v === "object") return realText((v as JsonLdNode).name);
  return null;
}

interface PlaceBits {
  parts: string[];
  country: string | null;
  lat: number | null;
  lng: number | null;
}

function readPlace(v: unknown): PlaceBits | null {
  if (!v || typeof v !== "object") {
    const s = realText(v);
    return s ? { parts: [s], country: null, lat: null, lng: null } : null;
  }
  const place = v as JsonLdNode;
  const addr = (place.address ?? place) as JsonLdNode;
  const addrObj = typeof addr === "object" && addr ? addr : ({} as JsonLdNode);

  const locality = realText(addrObj.addressLocality);
  const region = realText(addrObj.addressRegion);
  const street = realText(addrObj.streetAddress);
  const country =
    toIso2(
      typeof addrObj.addressCountry === "object" && addrObj.addressCountry
        ? (addrObj.addressCountry as JsonLdNode).name
        : addrObj.addressCountry
    ) ?? null;

  const geo = place.geo as JsonLdNode | undefined;
  const lat = geo ? Number(geo.latitude) : NaN;
  const lng = geo ? Number(geo.longitude) : NaN;

  // Locality is the real signal; street is the fallback (Boots writes
  // "Lisburn, Sprucefield Shopping Centre" in streetAddress and "-" in
  // locality — lib/geo's site-descriptor strip handles the tail).
  const parts = [locality, region].filter((s): s is string => !!s);
  if (!parts.length && street) parts.push(street);

  if (!parts.length && !country && !Number.isFinite(lat)) return null;
  return {
    parts,
    country,
    lat: Number.isFinite(lat) ? lat : null,
    lng: Number.isFinite(lng) ? lng : null,
  };
}

function readSalary(jp: JsonLdNode): { min: number | null; max: number | null; currency: string | null } | null {
  const base = jp.baseSalary as JsonLdNode | undefined;
  if (!base || typeof base !== "object") return null;
  const currency = asString(base.currency) ?? asString((base.value as JsonLdNode | undefined)?.currency);
  const value = base.value;
  let min: number | null = null;
  let max: number | null = null;
  let unit: string | null = null;
  if (typeof value === "number") {
    min = max = value;
  } else if (value && typeof value === "object") {
    const qv = value as JsonLdNode;
    unit = asString(qv.unitText);
    const v = Number(qv.value);
    const lo = Number(qv.minValue);
    const hi = Number(qv.maxValue);
    if (Number.isFinite(lo)) min = lo;
    if (Number.isFinite(hi)) max = hi;
    if (min === null && max === null && Number.isFinite(v)) min = max = v;
  }
  if (min === null && max === null) return null;
  // Only an ANNUAL figure is a salary our ranking can compare. Day/hour rates
  // are left to parseSalaryFromText downstream, which knows how to report a
  // period without annualising it. A missing unit on a small number is a rate,
  // not a salary — a £12 "salary" would sort below every recruiter ad.
  const annual = unit ? /year|annum|annual/i.test(unit) : (min ?? max ?? 0) > 5000;
  if (!annual) return null;
  // Employers write "46769.76"; job_postings stores whole pounds (integer
  // columns) — an unrounded value fails the entire upsert chunk. Seen live on
  // Victrex, 2026-07-16.
  return {
    min: min === null ? null : Math.round(min),
    max: max === null ? null : Math.round(max),
    currency,
  };
}

function readEmploymentType(jp: JsonLdNode): string | null {
  const v = jp.employmentType;
  const first = Array.isArray(v) ? v.find((x) => typeof x === "string") : v;
  return canonEmploymentType(first);
}

function isRemote(jp: JsonLdNode): boolean | null {
  const t = jp.jobLocationType;
  const types = Array.isArray(t) ? t : [t];
  if (types.some((x) => typeof x === "string" && /telecommute|remote/i.test(x))) return true;
  return null;
}

function identifierOf(jp: JsonLdNode, pageUrl: string): string {
  const id = jp.identifier;
  const fromId =
    (typeof id === "object" && id ? asString((id as JsonLdNode).value) : asString(id)) ?? null;
  if (fromId) return fromId;
  try {
    const u = new URL(pageUrl);
    return (u.pathname + u.search).slice(0, 300);
  } catch {
    return pageUrl.slice(0, 300);
  }
}

export function jobPostingToRawJob(board: AtsBoard, pageUrl: string, jp: JsonLdNode): RawJob | null {
  const title = decodeThenHtmlToText(asString(jp.title) ?? "").replace(/\s+/g, " ").trim();
  if (!title) return null;

  const host = (() => {
    try {
      return new URL(pageUrl).hostname.toLowerCase();
    } catch {
      return "jsonld";
    }
  })();

  const places: PlaceBits[] = [];
  const rawLoc = jp.jobLocation;
  for (const l of Array.isArray(rawLoc) ? rawLoc : [rawLoc]) {
    const p = readPlace(l);
    if (p) places.push(p);
  }

  const locationRaw = places[0]?.parts.join(", ") || null;
  const candidates = mergeCandidates(places.map((p) => p.parts.join(", ")), places.flatMap((p) => p.parts));
  // One explicit country across every listed place is a hint; disagreeing
  // countries mean a multi-country posting and no single hint is honest.
  const countries = [...new Set(places.map((p) => p.country).filter(Boolean))];
  const withGeo = places.find((p) => p.lat !== null);

  const salary = readSalary(jp);
  const descriptionHtml = asString(jp.description);

  return {
    source: "jsonld",
    source_id: `${host}:${identifierOf(jp, pageUrl)}`,
    source_url: asString(jp.url) ?? pageUrl,
    company: orgName(jp.hiringOrganization) ?? board.companyName ?? "",
    title,
    location_raw: locationRaw,
    jd_text: decodeThenHtmlToText(descriptionHtml),
    jd_html: descriptionHtml,
    posted_at: parseLooseUtc(asString(jp.datePosted)) ?? safeIso(asString(jp.datePosted)),
    expires_at: parseLooseUtc(asString(jp.validThrough)) ?? safeIso(asString(jp.validThrough)),
    salary_min: salary?.min ?? null,
    salary_max: salary?.max ?? null,
    salary_currency: salary?.currency ?? null,
    department: null,
    employment_type: readEmploymentType(jp),
    seniority_hint: null, // JobPosting has no seniority field; the classifier derives it
    job_function: asString(jp.occupationalCategory),
    is_remote: isRemote(jp),
    location_candidates: candidates,
    country_hint: countries.length === 1 ? countries[0] : null,
    lat: withGeo?.lat ?? null,
    lng: withGeo?.lng ?? null,
    raw: jp,
  };
}

// ---------------------------------------------------------------------------
// Job URL enumeration: sitemaps → static listing → rendered listing
// ---------------------------------------------------------------------------

function xmlLocs(xml: string): string[] {
  return [...xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)].map((m) => m[1].trim());
}

async function urlsFromSitemaps(
  origin: string,
  robots: RobotsInfo,
  siteDomain: string,
  deadline: number
): Promise<string[]> {
  const queue = robots.sitemaps.length
    ? [...robots.sitemaps]
    : [`${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`];
  const seen = new Set<string>();
  const found = new Set<string>();
  let fetches = 0;

  while (queue.length && fetches < MAX_SITEMAP_FETCHES && Date.now() < deadline) {
    const sm = queue.shift()!;
    if (seen.has(sm)) continue;
    seen.add(sm);
    const res = await httpText(sm, 15_000);
    fetches++;
    if (!res || res.status !== 200) continue;

    const locs = xmlLocs(res.text);
    if (/<sitemapindex/i.test(res.text)) {
      // A child called jobs-sitemap.xml IS the job list; walk those first.
      const jobish = locs.filter((u) => /job|vacanc|position|career/i.test(u));
      queue.unshift(...(jobish.length ? jobish : locs).slice(0, 10));
      continue;
    }
    for (const u of locs) {
      try {
        if (registrableDomain(new URL(u).hostname) !== siteDomain) continue;
      } catch {
        continue;
      }
      if (looksLikeJobDetailUrl(u)) found.add(normaliseUrl(u));
    }
  }
  return [...found];
}

function urlsFromHtml(html: string, baseUrl: string, siteDomain: string): string[] {
  const found = new Set<string>();
  for (const m of html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)) {
    let abs: string;
    try {
      abs = new URL(m[1], baseUrl).toString();
    } catch {
      continue;
    }
    try {
      if (registrableDomain(new URL(abs).hostname) !== siteDomain) continue;
    } catch {
      continue;
    }
    if (looksLikeJobDetailUrl(abs)) found.add(normaliseUrl(abs));
  }
  return [...found];
}

/**
 * UK-looking URLs first. A global employer's jobs sitemap (FedEx: 3,500 URLs,
 * Aramark: 6,900) is mostly foreign, and the page cap takes the FIRST N — an
 * arbitrary, mostly-US slice whose jobs geo then throws away. Employers that
 * localise their URLs (/en-gb/, /united-kingdom/, "-london-") float to the
 * front so the capped crawl spends its budget where the UK jobs are. Purely an
 * ordering: nothing is excluded, and non-localised sites are unaffected.
 */
const UK_URL_HINT =
  /[/-](?:uk|gb|en-gb|gbr|united-kingdom|great-britain|england|scotland|wales|northern-ireland|london|manchester|birmingham|glasgow|leeds|edinburgh|bristol|cardiff|belfast)(?:[/-]|\.|$)/i;

export function ukFirst(urls: string[]): string[] {
  return [...urls].sort((a, b) => Number(UK_URL_HINT.test(b)) - Number(UK_URL_HINT.test(a)));
}

export interface EnumeratedJobs {
  urls: string[];
  /** Which rung produced them — recorded so a supply drop can be diagnosed. */
  via: "sitemap" | "listing" | "rendered-listing" | "none";
  /** True when we had to render — the board must be marked renderMode=playwright. */
  neededRendering: boolean;
}

export async function enumerateJobUrls(
  board: AtsBoard,
  deadline: number,
  allowRendering: boolean
): Promise<EnumeratedJobs | { error: string }> {
  let entry: URL;
  try {
    entry = new URL(board.token);
  } catch {
    return { error: `jsonld: token is not a URL: "${board.token}"` };
  }
  const origin = entry.origin;
  const siteDomain = registrableDomain(entry.hostname);
  const robots = await fetchRobots(origin);

  if (!robotsAllows(robots.disallows, entry.pathname)) {
    return { error: `jsonld: robots.txt disallows ${entry.pathname} — refusing to crawl` };
  }

  // Rung 1: sitemaps. The employer publishes these FOR crawlers; best source.
  const fromSitemap = (await urlsFromSitemaps(origin, robots, siteDomain, deadline)).filter((u) =>
    robotsAllows(robots.disallows, new URL(u).pathname)
  );
  if (fromSitemap.length) return { urls: ukFirst(fromSitemap), via: "sitemap", neededRendering: false };

  // Rung 2: anchors on the static listing page.
  const listing = await httpText(board.token);
  if (listing && listing.status === 200) {
    const fromListing = urlsFromHtml(listing.text, listing.finalUrl, siteDomain).filter((u) =>
      robotsAllows(robots.disallows, new URL(u).pathname)
    );
    if (fromListing.length) return { urls: ukFirst(fromListing), via: "listing", neededRendering: false };
  }

  // Rung 3: the rendered listing page — the JS-injected job list.
  if (allowRendering) {
    const rendered = await withBrowser(async (render) => {
      const page = await render(board.token, "href");
      if (!page) return [] as string[];
      return urlsFromHtml(page.html, page.finalUrl, siteDomain);
    });
    const urls = (rendered ?? []).filter((u) => robotsAllows(robots.disallows, new URL(u).pathname));
    if (urls.length) return { urls: ukFirst(urls), via: "rendered-listing", neededRendering: true };
  }

  return { urls: [], via: "none", neededRendering: false };
}

// ---------------------------------------------------------------------------
// The agency refusal
// ---------------------------------------------------------------------------

/**
 * 🔴 AN AGENCY'S SITE PASSES THE MULTI-ORG CHECK. The first live gap sweep
 * (2026-07-16) registered NINE recruitment agencies as "verified" jsonld boards
 * — Ernest Gordon Recruitment (1,100 ads), Lorien, Anson Mccade, 83zero… —
 * because an agency stamps its OWN name into hiringOrganization on every client
 * ad. One org per site, name matches, everything verifies — and the moat's core
 * property (zero recruiters BY CONSTRUCTION) silently inverts.
 *
 * The structural tell is in the AD TEXT, not the markup: the UK Conduct of
 * Employment Agencies Regulations require agencies to state that they act "as
 * an Employment Agency / Employment Business" in the advert, and the trade
 * boilerplate ("on behalf of our client…") is near-universal in the rest. An
 * employer describing its own vacancy has no reason to utter any of it.
 */
const AGENCY_AD_RE =
  /acting as an? employment (?:agency|business)|employment (?:agency|business) (?:for|in relation to)|on behalf of (?:our|a|my) client|\b(?:our|my) client (?:is|are) (?:seeking|looking|recruiting|hiring)|\brec(?:ruitment)? consultancy\b/i;

/** True when the sampled ads read like an agency's book, not an employer's board. */
export function looksLikeAgencyAds(jdTexts: string[]): boolean {
  const sampled = jdTexts.filter((t) => t && t.length > 100).slice(0, 8);
  if (!sampled.length) return false;
  const hits = sampled.filter((t) => AGENCY_AD_RE.test(t)).length;
  // One ad mentioning a client could be an employer quoting a project; half the
  // sample carrying agency boilerplate cannot be.
  return hits >= Math.max(2, Math.ceil(sampled.length / 2)) || (sampled.length === 1 && hits === 1);
}

// ---------------------------------------------------------------------------
// The multi-org refusal
// ---------------------------------------------------------------------------

/**
 * Does `org` cover every word of the `expected` company name? Same superset
 * rule as discovery's namesMatch (not imported — that would be a cycle):
 * "FedEx" is covered by "FedEx Office"; "Next" by "Next"; "Reed" is NOT
 * covered by "Howden Joinery".
 */
function orgCoversExpected(expected: string | null | undefined, org: string): boolean {
  if (!expected) return false;
  const a = normaliseCompanyName(expected);
  const b = normaliseCompanyName(org);
  if (!a || !b) return false;
  const askedWords = a.split(" ").filter(Boolean);
  const orgWords = new Set(b.split(" ").filter(Boolean));
  return askedWords.length > 0 && askedWords.every((w) => orgWords.has(w));
}

/**
 * A small org set where the expected employer is PRESENT is a BRAND FAMILY,
 * not a jobs board. Next plc's careers site posts as "Next", "Joules" and
 * "Victoria's Secret" — all Next Group brands, all genuinely first-party;
 * FedEx posts as "FedEx Office" / "FedEx Logistics" / "Federal Express". Both
 * were wrongly refused on the first full ingest (2026-07-16). The distinction
 * from Reed's site (the trap this rule guards): a jobs board carries MANY orgs
 * and the site owner's name is a recruiter's, screened separately by the
 * agency gates. A family is small AND contains the employer we registered.
 */
export function isBrandFamily(orgs: string[], expected: string | null | undefined): boolean {
  return (
    orgs.length > 1 &&
    orgs.length <= 6 &&
    orgs.some((o) => orgCoversExpected(expected, o) || orgCoversExpected(o, expected ?? ""))
  );
}

/**
 * Distinct hiring organisations after merging cosmetic variants ("Boots" /
 * "Boots UK Limited" are one org: every word of the shorter appears in the
 * longer). >1 after merging ⇒ this is a jobs BOARD, not an employer.
 */
export function distinctOrgs(names: string[]): string[] {
  const normed = [...new Set(names.map((n) => normaliseCompanyName(n)).filter(Boolean))];
  const merged: string[] = [];
  for (const n of normed.sort((a, b) => a.length - b.length)) {
    const words = n.split(" ").filter(Boolean);
    const subsumed = merged.some((m) => {
      const mWords = new Set(m.split(" "));
      const nWords = new Set(words);
      return words.every((w) => mWords.has(w)) || [...mWords].every((w) => nWords.has(w));
    });
    if (!subsumed) merged.push(n);
  }
  return merged;
}

// ---------------------------------------------------------------------------
// The provider
// ---------------------------------------------------------------------------

async function politePause(): Promise<void> {
  await new Promise((r) => setTimeout(r, POLITE_DELAY_MS));
}

// ---------------------------------------------------------------------------
// Discovery-facing probe
// ---------------------------------------------------------------------------

export interface JsonLdSiteProbe {
  jobCount: number;
  /** Distinct hiring orgs found in the sample (board-authored, never an echo). */
  orgNames: string[];
  /**
   * What the PULL will need. "playwright" when either the job-link enumeration
   * or the detail pages themselves only work rendered — recorded on the board
   * so the Vercel cron knows to skip it.
   */
  renderMode: "static" | "playwright";
  /**
   * Plain-text JDs of the sampled postings. Discovery's agency gates read these
   * — the ad TEXT is where an agency betrays itself when its name and SIC code
   * don't (83zero files as an IT consultancy; its ads say "we're partnered
   * with a leading global…").
   */
  sampleJds: string[];
}

/**
 * Can this careers site be read as JobPosting JSON-LD, and how?
 *
 * Tries the cheap shape first (static sitemap/listing + static details), and
 * escalates to rendering only where the static rung came up empty AND a browser
 * exists. Samples up to 3 detail pages so a multi-employer jobs board can be
 * refused at DISCOVERY time rather than registered and then refused on every
 * pull forever.
 */
export async function probeJsonLdSite(
  careersUrl: string,
  allowRendering: boolean,
  /** The employer we expect — lets a small brand family (Next/Joules) pass. */
  expectedCompany?: string | null
): Promise<JsonLdSiteProbe | { error: string } | null> {
  const deadline = Date.now() + 90_000;
  const board: AtsBoard = { provider: "jsonld", token: careersUrl };

  // Enumerate statically; escalate to a rendered listing only if that fails.
  let enumerated = await enumerateJobUrls(board, deadline, false);
  if ("error" in enumerated) return { error: enumerated.error };
  let renderMode: "static" | "playwright" = "static";
  if (!enumerated.urls.length && allowRendering) {
    enumerated = await enumerateJobUrls(board, deadline, true);
    if ("error" in enumerated) return { error: enumerated.error };
    if (enumerated.neededRendering) renderMode = "playwright";
  }
  if (!enumerated.urls.length) return null;

  // Sample up to 3 detail pages, static first.
  const sample = enumerated.urls.slice(0, 3);
  let postings: JsonLdNode[] = [];
  for (const url of sample) {
    const res = await httpText(url);
    await politePause();
    if (res && res.status === 200) postings.push(...parseJobPostings(res.text));
  }
  if (!postings.length && allowRendering) {
    const rendered = await withBrowser(async (render) => {
      const acc: JsonLdNode[] = [];
      for (const url of sample.slice(0, 2)) {
        const page = await render(url, "JobPosting");
        if (page) acc.push(...parseJobPostings(page.html));
      }
      return acc;
    });
    if (rendered?.length) {
      postings = rendered;
      renderMode = "playwright";
    }
  }
  if (!postings.length) return null;

  const orgs = distinctOrgs(
    postings.map((p) => orgName(p.hiringOrganization)).filter((s): s is string => !!s)
  );
  if (orgs.length > 1 && !isBrandFamily(orgs, expectedCompany)) {
    return {
      error:
        `jsonld: ${orgs.length} distinct hiring orgs in a 3-page sample of ${careersUrl} ` +
        `(${orgs.slice(0, 4).join("; ")}) — a jobs board, not an employer. Refused.`,
    };
  }

  // An agency stamps ONE org (itself) on every client ad, so the org check
  // passes — the UK Conduct-Regs boilerplate in the ad text is what refuses it.
  const sampleJds = postings.map((p) => decodeThenHtmlToText(asString(p.description) ?? ""));
  if (looksLikeAgencyAds(sampleJds)) {
    return {
      error:
        `jsonld: sampled ads on ${careersUrl} carry recruitment-agency boilerplate — ` +
        `an agency's book, not an employer's board. Refused.`,
    };
  }

  return {
    jobCount: enumerated.urls.length,
    orgNames: postings.map((p) => orgName(p.hiringOrganization)).filter((s): s is string => !!s),
    renderMode,
    sampleJds,
  };
}

export const jsonldProvider: AtsProviderImpl = {
  id: "jsonld",

  async listJobs(board: AtsBoard, opts?: AtsPullOptions): Promise<AtsPullResult> {
    try {
      const deadline = budgetDeadline(opts);
      const allowRendering = board.renderMode === "playwright";

      const enumerated = await enumerateJobUrls(board, deadline, allowRendering);
      if ("error" in enumerated) return { jobs: [], error: enumerated.error };

      if (!enumerated.urls.length) {
        // A listing page we can read that links to no jobs is a legitimate
        // empty board — the employer isn't hiring. (If the page itself was
        // unreachable, enumerateJobUrls already returned an error above for
        // robots; a network failure lands here too, and "empty" keeps the
        // board polled rather than killed. Discovery would not have
        // registered a board that never showed a job.)
        return { jobs: [], boardCompanyName: board.companyName ?? null };
      }

      const cap = Math.min(
        jobCap(opts),
        enumerated.neededRendering ? MAX_RENDERED_PAGES : MAX_STATIC_PAGES
      );
      const urls = enumerated.urls.slice(0, cap);
      const truncatedByEnum = enumerated.urls.length > cap;

      // Detail pages are usually static even when the LISTING is JS-rendered
      // (boots.jobs). So always try static first; only fall back to rendering
      // details if a sample proves the static fetch carries no JSON-LD.
      const fetchDetailStatic = async (url: string): Promise<JsonLdNode[]> => {
        const res = await httpText(url);
        await politePause();
        if (!res || res.status !== 200) return [];
        return parseJobPostings(res.text).map((jp) => ({ ...jp, __pageUrl: url }));
      };

      // Sample 3 pages to decide the fetch mode — cheap, and it prevents
      // rendering 120 pages when static would have worked (or statically
      // fetching 600 that all come back empty).
      const sample = urls.slice(0, 3);
      const sampleResults = await Promise.all(sample.map(fetchDetailStatic));
      const staticWorks = sampleResults.some((r) => r.length > 0);

      let postings: JsonLdNode[] = sampleResults.flat();
      let timedOut = false;
      // How far down the (UK-first) list we actually got before any clock cut.
      let attemptedCount = sample.length;

      if (staticWorks) {
        const rest = urls.slice(sample.length);
        const { results, timedOut: t, attempted } = await mapWithConcurrency(
          rest,
          JSONLD_DETAIL_CONCURRENCY,
          deadline,
          fetchDetailStatic
        );
        timedOut = t;
        attemptedCount += attempted;
        for (const r of results) if (r) postings.push(...r);
      } else if (allowRendering) {
        // Static details are empty — render them (bounded much harder).
        const renderedUrls = urls.slice(0, MAX_RENDERED_PAGES);
        attemptedCount = 0;
        const rendered = await withBrowser(async (render) => {
          const acc: JsonLdNode[] = [];
          for (const url of renderedUrls) {
            if (Date.now() > deadline) {
              timedOut = true;
              break;
            }
            attemptedCount++;
            const page = await render(url, "JobPosting");
            if (page) acc.push(...parseJobPostings(page.html).map((jp) => ({ ...jp, __pageUrl: url })));
          }
          return acc;
        });
        postings = rendered ?? [];
      }

      if (!postings.length) {
        // Rule 2: URLs enumerated, nothing parsed. That is a broken crawler or
        // a blocked one — NEVER "no jobs matched".
        return {
          jobs: [],
          error:
            `jsonld ${board.token}: enumerated ${urls.length} job URLs (via ${enumerated.via}) ` +
            `but parsed 0 JobPosting blocks — site changed, blocked, or needs rendering`,
        };
      }

      // Rule 1: one employer per careers site — where a small BRAND FAMILY that
      // contains the registered employer counts as one (Next/Joules, FedEx
      // Office/Logistics). Anything bigger or stranger is a jobs board.
      const orgs = distinctOrgs(
        postings.map((p) => orgName(p.hiringOrganization)).filter((s): s is string => !!s)
      );
      if (orgs.length > 1 && !isBrandFamily(orgs, board.companyName)) {
        return {
          jobs: [],
          error:
            `jsonld ${board.token}: ${orgs.length} distinct hiring orgs on one site ` +
            `(${orgs.slice(0, 4).join("; ")}) — this is a jobs BOARD, not an employer. Refusing all of it.`,
        };
      }

      // Rule 1b: one org is NOT enough — an agency stamps its own name on every
      // client ad. The ad TEXT betrays it (UK Conduct Regs boilerplate).
      const sampleJds = postings
        .slice(0, 8)
        .map((p) => decodeThenHtmlToText(asString(p.description) ?? ""));
      if (looksLikeAgencyAds(sampleJds)) {
        return {
          jobs: [],
          error:
            `jsonld ${board.token}: sampled ads carry recruitment-agency boilerplate ` +
            `("acting as an employment agency…") — an agency's book, not an employer's board. Refused.`,
        };
      }

      const jobs: RawJob[] = [];
      const seenIds = new Set<string>();
      for (const p of postings) {
        const raw = jobPostingToRawJob(board, (p.__pageUrl as string) ?? board.token, p);
        if (!raw) continue;
        if (seenIds.has(raw.source_id)) continue; // one URL can repeat a posting
        seenIds.add(raw.source_id);
        jobs.push(raw);
      }

      // BOARD-AUTHORED name only. jobPostingToRawJob falls back to
      // board.companyName when the JSON-LD names no org — returning THAT here
      // would make discovery's namesMatch() compare the company against itself,
      // the exact circular check that let lever/bloom masquerade as Bloom & Wild.
      // In a brand family, prefer the org that IS the registered employer
      // ("Next", not whichever brand happened to post first).
      const allOrgNames = postings
        .map((p) => orgName(p.hiringOrganization))
        .filter((s): s is string => !!s);
      const boardOrg =
        allOrgNames.find((o) => orgCoversExpected(board.companyName, o)) ?? allOrgNames[0] ?? null;

      // TRUNCATION, FOR A UK PRODUCT. `urls` is UK-first ordered, so what
      // matters is whether any UK-LOOKING page went unfetched. Aramark's global
      // sitemap has 6,884 URLs; cutting its non-UK tail loses nothing a UK
      // search could ever have shown, and flagging it "partial" every night
      // would train everyone to ignore the flag that mattered on AstraZeneca.
      // Honest limitation: a UK job whose URL carries no locale hint can still
      // sit in the cut tail of a GLOBAL board — invisible until we page across
      // runs. All-UK boards are unaffected (they fit inside the 1,500 cap).
      const ukHintedCount = enumerated.urls.filter((u) => UK_URL_HINT.test(u)).length;
      const ukCutByCap = truncatedByEnum && ukHintedCount > cap;
      const ukCutByClock = timedOut && attemptedCount < Math.min(ukHintedCount, urls.length);
      const truncatedForUk = ukHintedCount > 0
        ? ukCutByCap || ukCutByClock
        : truncatedByEnum || timedOut; // no UK hints anywhere → keep the blunt flag

      return {
        jobs,
        boardCompanyName: boardOrg,
        truncated: truncatedForUk,
      };
    } catch (e) {
      return { jobs: [], error: `jsonld ${board.token}: ${errMsg(e)}` };
    }
  },

  async probe(board: AtsBoard): Promise<AtsProbeResult> {
    try {
      const site = await probeJsonLdSite(board.token, board.renderMode === "playwright", board.companyName);
      if (!site) return { exists: false, jobCount: 0 };
      if ("error" in site) return { exists: false, jobCount: 0, error: site.error };
      return { exists: true, jobCount: site.jobCount, boardCompanyName: site.orgNames[0] ?? null };
    } catch (e) {
      return { exists: false, jobCount: 0, error: errMsg(e) };
    }
  },

  // A jsonld board cannot be recognised from a URL shape (any URL might be a
  // careers page) and its token cannot be guessed from a company name. Both
  // rungs are structurally disabled; discovery reaches jsonld ONLY through the
  // dedicated last-rung crawl in lib/ats/discover.ts.
  detect(): AtsBoard | null {
    return null;
  },

  candidateTokens(): string[] {
    return [];
  },
};
