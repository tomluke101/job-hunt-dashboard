// ATS discovery: company name → which board, and where.
//
// This is the function that decides whether the moat SCALES. A hand-curated list
// of 100 boards is a demo. To be the best job search in the UK we need thousands,
// and they have to be found automatically.
//
// THREE LADDER RUNGS, cheapest first. We stop at the first rung that resolves.
//
//   1. TOKEN PROBE (free, ~200ms, no key, no crawl)
//      Most boards are just the slugified company name: GoCardless → "gocardless".
//      So GUESS the token and probe the provider's public endpoint. A wrong guess
//      404s; a right one returns jobs. This alone resolves the majority of
//      companies that are on a public ATS at all.
//
//   2. CAREERS-PAGE CRAWL (free, ~1-2s)
//      Fetch the employer's careers page and read the ATS embed straight out of
//      the HTML — every provider's job board links back to itself
//      (boards.greenhouse.io/monzo, jobs.lever.co/palantir, ...). This is exact,
//      not a guess, so it also RESCUES companies whose token isn't their name
//      (Monzo's Greenhouse token could have been "monzobank" and rung 1 would miss).
//
//   3. LLM DOMAIN RESOLUTION (~$0.001, cached forever)
//      Rung 2 needs a careers URL, and Companies House doesn't give us websites.
//      Guess the domain first (foo.com / foo.co.uk); only if that fails ask Haiku
//      "what is the primary website for employer X". Cheap, and cached in
//      company_ats_discovery so we ask once per company ever.
//
// EVERY RESULT IS VERIFIED. Guessing a token is dangerous: probe "apple" on
// Greenhouse and you may hit some unrelated startup called Apple, then silently
// attach their jobs to the wrong employer. So a board is only trusted when the
// name the BOARD reports matches the company we were looking for. Where a provider
// reports no name, the board is stored as `unverified` and its jobs are held back
// until a human or a later signal confirms it. Wrong data is worse than none.

import { getProvider, detectBoard, ATS_PROVIDERS } from "./providers";
import { ENABLED_PROVIDERS, type AtsBoard, type AtsProviderId } from "./types";
import { normaliseCompanyName } from "@/lib/enrichment/normalise-company";
import { probeJsonLdSite } from "./providers/jsonld";
import { renderingAvailable, withBrowser } from "./render";
import { detectRecruiter } from "@/lib/enrichment/recruiter-detect";

export interface DiscoveredBoard extends AtsBoard {
  discovered_via: "token-probe" | "careers-crawl" | "rendered-crawl" | "jsonld-crawl" | "seed" | "manual";
  board_company_name: string | null;
  job_count: number;
  /** verified = the board itself confirms who it belongs to. */
  verified: boolean;
}

export interface DiscoverOptions {
  /** Known careers page. Skips domain guessing entirely. */
  careersUrl?: string | null;
  /**
   * Domains already known to belong to this company (e.g. recorded in a prior
   * discovery attempt's notes). Skips the guess/LLM rung — re-deriving a domain
   * we already resolved is wasted time and wasted Haiku.
   */
  knownDomains?: string[];
  /** Providers to try. Defaults to the verified set. */
  providers?: AtsProviderId[];
  /** Allow the LLM domain-resolution rung. Off by default: it costs money. */
  useLlm?: boolean;
  /** Rung-2/3 cost real time; a bulk seed run may want probe-only. */
  probeOnly?: boolean;
}

// ---------------------------------------------------------------------------
// Name matching — the anti-collision check
// ---------------------------------------------------------------------------

/**
 * Does the name the BOARD reports refer to the company we asked about?
 *
 * THE RULE: the board's name may be a SUPERSET of what we asked for, never a
 * STRICT SUBSET.
 *
 * A real board elaborates its name — we ask for "Monzo", the board calls itself
 * "Monzo Bank". It does not TRUNCATE it. So if the board's name is missing a word
 * that the company's name has, it is a different company.
 *
 * That asymmetry is not academic. A looser containment check (either name may
 * contain the other) passed all of these during verification:
 *   asked "National Grid"  → board "NATIONAL"           (a Canadian PR firm)
 *   asked "Bloom & Wild"   → board "Bloom (Join our…)"  (a shared agency board)
 * Both would have silently attached a stranger's jobs to a real employer — the
 * exact failure this function exists to prevent. Wrong data is worse than none.
 */
export function namesMatch(asked: string, boardSays: string | null | undefined): boolean {
  if (!boardSays) return false;
  const a = normaliseCompanyName(asked);
  const b = normaliseCompanyName(boardSays);
  if (!a || !b) return false;
  if (a === b) return true;

  const askedWords = a.split(" ").filter(Boolean);
  const boardWords = new Set(b.split(" ").filter(Boolean));
  if (askedWords.length === 0) return false;

  // Every word we asked for must appear in the board's name. The board may add
  // words ("Bank", "Group", "UK"); it may not drop any.
  return askedWords.every((w) => boardWords.has(w));
}

/**
 * A token that is only PART of the company's name — typically its first word
 * ("National Grid" → "national", "2 Sisters Food Group" → "2").
 *
 * These find real boards (Monzo Bank's board is genuinely "monzo"), but they are
 * also where every collision came from, because a generic first word is somebody
 * else's whole company name. So they are allowed ONLY when the board independently
 * confirms who it belongs to — see probeProvider.
 */
export function isPartialToken(companyName: string, token: string): boolean {
  const words = normaliseCompanyName(companyName).split(" ").filter(Boolean);
  if (words.length <= 1) return false; // single-word company: the slug IS the name
  const t = token.toLowerCase().replace(/[^a-z0-9]/g, "");
  return !words.every((w) => t.includes(w));
}

// ---------------------------------------------------------------------------
// Rung 1 — token probe
// ---------------------------------------------------------------------------

/**
 * May a board found by GUESSING the token be trusted at all?
 *
 * Greenhouse / Lever / Ashby / SmartRecruiters / Workday tokens are provisioned to
 * paying customers, so `boards/gocardless` really is GoCardless.
 *
 * RECRUITEE IS NOT. Its subdomain namespace is open — anyone can take
 * `<anything>.recruitee.com`, and free trial accounts ship with demo postings. Every
 * single Recruitee board a token-probe found was junk:
 *     ey            → a 3-person firm that calls itself "EY" (not Ernst & Young)
 *     accenture     → a Recruitee demo account ("Senior Marketer (Sample)")
 *     oxfam         → a demo account ("Marketer Senior (Exemple)")
 *     bbc           → "BBC NV", a Dutch company
 *     bp            → "Black Propeller"
 *     marksandspencer → Marks & Spencer GREECE — 17 jobs in Athens
 * Name-matching cannot rescue this: the squatter on `ey` is genuinely called "EY".
 * So Recruitee boards are only ever accepted from a careers-page CRAWL, where the
 * employer's own website links to the board and provenance is not in doubt.
 */
const TOKEN_PROBE_TRUSTED: Record<AtsProviderId, boolean> = {
  greenhouse: true,
  lever: true,
  ashby: true,
  smartrecruiters: true,
  workday: true,
  workable: true,
  recruitee: false,
  // jsonld has no token namespace to probe at all (its candidateTokens() is
  // empty) — the crawl rung below is its only entry point.
  jsonld: false,
};

/** Recruitee/Workable trial boards ship with these. A demo board is not an employer. */
const DEMO_TITLE = /\((sample|exemple|beispiel|voorbeeld|ejemplo|esempio)\)/i;

function looksLikeDemoBoard(titles: string[]): boolean {
  if (!titles.length) return false;
  return titles.some((t) => DEMO_TITLE.test(t));
}

/**
 * Second, provider-independent verification signal: does the board's own JOB
 * CONTENT name the company?
 *
 * Lever and Ashby have no company-name field at all, so a token-probed board can
 * never self-identify — which would quarantine every one of them (Deliveroo,
 * Synthesia, Multiverse, Trainline...) and cost us the coverage that makes this
 * worth building.
 *
 * But an employer's own JD nearly always names them: Synthesia's opens "Synthesia
 * is the world's leading AI video platform". So pull one job and look for every
 * word of the company's name in its title + description. That is a real signal, and
 * it correctly REFUSES the collisions: the "LinkedIn Job Board" board's postings say
 * nothing about 2 Sisters Food Group, and the Craft PR board says nothing about
 * Bloom & Wild.
 *
 * Costs one extra HTTP call, and only for candidates that failed name verification.
 */
async function verifyBySampleText(
  provider: ReturnType<typeof getProvider>,
  board: AtsBoard,
  companyName: string
): Promise<boolean> {
  if (!provider) return false;

  // Only DISTINCTIVE words count. normaliseCompanyName turns "&" into "and", so
  // "Bloom & Wild" yields ["bloom","and","wild"] — and requiring "and" to appear
  // proves nothing whatsoever, since every JD in English contains it.
  const words = normaliseCompanyName(companyName)
    .split(" ")
    .filter((w) => w.length > 3 && !GENERIC_NAME_WORDS.has(w));
  if (!words.length) return false;

  const res = await provider.listJobs(board).catch(() => null);
  if (!res || res.jobs.length === 0) return false;

  // A trial board full of "(Sample)" postings is not an employer's job board.
  if (looksLikeDemoBoard(res.jobs.map((j) => j.title))) return false;

  // Every word must appear in ONE AND THE SAME posting — never spread across
  // several. Concatenating the sample first is a false conjunction: probing
  // "Bloom & Wild" hits lever/bloom, a workplace-design consultancy that posts for
  // multiple clients, where "bloom" appears in one job's JD and "wild" appears in
  // an unrelated one ("building Poppy & Peonies has been a wild adventure"). Joined
  // together those two look like proof; separately they are a coincidence. A real
  // employer names itself inside a SINGLE posting.
  //
  // Also deliberately EXCLUDES j.company: Lever and Ashby have no company field, so
  // their adapters fall back to the name the CALLER passed in. Matching against
  // that verifies the company against itself — the same circular check that let
  // lever/bloom masquerade as Bloom & Wild in the first place. Only board-authored
  // content counts: the job TITLE and the JD TEXT.
  return res.jobs.slice(0, 5).some((j) => {
    const doc = `${j.title} ${j.jd_text.slice(0, 1500)}`.toLowerCase();
    return words.every((w) => doc.includes(w));
  });
}

/** Words that carry no identifying power in a company name. */
const GENERIC_NAME_WORDS = new Set([
  "and", "the", "for", "group", "holdings", "holding", "international", "global",
  "limited", "company", "services", "solutions", "partners", "partnership",
]);

async function probeProvider(
  providerId: AtsProviderId,
  companyName: string
): Promise<DiscoveredBoard | null> {
  const provider = getProvider(providerId);
  if (!provider) return null;

  // Recruitee's namespace is squatter-infested — see TOKEN_PROBE_TRUSTED. Guessing
  // a token there produces confident garbage, so don't guess at all.
  if (!TOKEN_PROBE_TRUSTED[providerId]) return null;

  for (const token of provider.candidateTokens(companyName)) {
    let board: AtsBoard = { provider: providerId, token, companyName };
    if (providerId === "workday") {
      // Workday can't be probed by token alone — a tenant hosts several career
      // sites and the wrong one returns 422, not 404. The provider's probe()
      // walks the common site names itself; see providers/workday.ts.
      board = { provider: "workday", token, companyName, workday: { tenant: token, host: "wd3.myworkdayjobs.com", site: "Careers" } };
    }

    const res = await provider.probe(board).catch(() => null);
    if (!res || !res.exists) continue;

    // Signal 1 (strong): the board names ITSELF, and that name covers every word
    // of the company we asked for.
    const namedItself = namesMatch(companyName, res.boardCompanyName);

    // Signal 2 (weaker): the board's job CONTENT names the company. Needed because
    // Lever and Ashby have no company field at all, so a real Deliveroo or
    // Synthesia board can never self-identify.
    let verified = namedItself;
    if (!verified && res.jobCount > 0 && !isPartialToken(companyName, token)) {
      verified = await verifyBySampleText(provider, board, companyName);
    }

    // A PARTIAL token (typically the company's first word) demands the STRONG
    // signal. Content-matching is not enough for it, because agency and
    // multi-client boards defeat content: probing "Bloom & Wild" hits lever/bloom,
    // a design consultancy posting for several clients, whose jobs mention both
    // "bloom" and "wild" often enough to look convincing. A partial token is only
    // ever accepted when the board actually says whose it is.
    //
    // And when nothing vouches for it, DISCARD rather than store as "unverified" —
    // storing it records the company as FOUND, so we'd never look for its real
    // board again, permanently locking in the collision.
    if (!verified && isPartialToken(companyName, token)) continue;

    // A full-name token that exists but is still unproven (typically an empty
    // board — nothing to read the company's name out of) is a much weaker risk,
    // since the token IS the company's name. Keep it, flagged unverified;
    // registry.ts holds its jobs back from ingest until something confirms it.
    return {
      ...board,
      discovered_via: "token-probe",
      board_company_name: res.boardCompanyName ?? null,
      job_count: res.jobCount,
      verified,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Rung 2 — careers-page crawl
// ---------------------------------------------------------------------------

const CAREERS_PATHS = [
  "/careers", "/jobs", "/careers/jobs", "/about/careers", "/company/careers",
  "/en/careers", "/work-with-us", "/join-us", "/vacancies", "/careers/open-roles",
];

/**
 * Returns the HTML *and the URL we actually ended up on*. The final URL is not a
 * detail: hopin.com/careers 301s to RingCentral's Workday board (RingCentral
 * acquired Hopin), so a crawl that only looks at the HTML happily files
 * RingCentral's entire req list under the company name "Hopin". See crawlCareers().
 */
async function fetchText(
  url: string,
  timeoutMs = 12_000
): Promise<{ html: string; finalUrl: string } | null> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "follow",
      headers: {
        // Some careers pages serve a bot-blocking shell to unknown agents; a
        // normal browser UA gets the real HTML with the ATS embed in it.
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36",
        accept: "text/html,application/xhtml+xml",
      },
    });
    if (!res.ok) return null;
    const ct = res.headers.get("content-type") ?? "";
    if (!ct.includes("html")) return null;
    return { html: await res.text(), finalUrl: res.url || url };
  } catch {
    return null;
  }
}

/** "www.oxfam.org.uk" → "oxfam.org.uk". Enough to compare two hosts for sameness. */
function registrable(host: string): string {
  return host.toLowerCase().replace(/^www\./, "");
}

function hostOf(url: string): string {
  try {
    return registrable(new URL(url).hostname);
  } catch {
    return "";
  }
}

/**
 * Did the careers page land somewhere still belonging to this employer?
 *
 * "Same host" is the WRONG test and rejects most of the FTSE: barclays.co.uk/careers
 * redirects to home.barclays, santander.co.uk to santander.wd3.myworkdayjobs.com.
 * Those are the same organisation on a different domain, and treating them as
 * hijacks held Barclays (1,115 jobs), Santander (918), BP and Shell out of the
 * corpus entirely — the exact UK enterprise supply this rung exists to reach.
 *
 * The real question is whether the landing host still bears the company's NAME:
 *   Barclays → home.barclays               contains "barclays"  ✓ same org
 *   Santander → santander.wd3.myworkday... contains "santander" ✓ same org
 *   Hopin    → ringcentral.wd5.myworkday... no "hopin" anywhere ✗ ACQUIRER
 */
function sameOrg(landedHost: string, sourceDomain: string, companyName: string): boolean {
  if (!landedHost || landedHost === sourceDomain) return true;
  const flat = landedHost.replace(/[^a-z0-9]/g, "");

  const s = slug(companyName); // "barclays", "hopin", "santanderuk"
  if (s.length >= 4 && flat.includes(s)) return true;

  // The domain we started from is itself derived from the company, so its base
  // label is a second usable handle ("santander" from santander.co.uk).
  const base = sourceDomain.split(".")[0].replace(/[^a-z0-9]/g, "");
  if (base.length >= 4 && flat.includes(base)) return true;

  // ...and the reverse: a company whose name is longer than its domain label
  // ("Santander UK" → santander.wd3...). Match either direction.
  if (base.length >= 4 && s.length >= 4 && (s.includes(base) || base.includes(s))) {
    if (flat.includes(base) || flat.includes(s)) return true;
  }
  return false;
}

/** Pull every ATS board URL out of a page's HTML and resolve it to board coords. */
export function detectBoardsInHtml(html: string, companyName: string): AtsBoard[] {
  const found: AtsBoard[] = [];
  const seen = new Set<string>();

  // Grab candidate URLs from href="", plain text, and JS config blobs alike.
  const urls = html.match(/https?:\/\/[^\s"'<>()\\]+/g) ?? [];
  for (const url of urls) {
    for (const providerId of ENABLED_PROVIDERS) {
      const provider = ATS_PROVIDERS[providerId];
      if (!provider) continue;
      const board = provider.detect(url);
      if (!board) continue;
      const key = `${board.provider}|${board.token}|${board.workday?.site ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({ ...board, companyName });
    }
  }
  return found;
}

async function crawlCareers(
  companyName: string,
  careersUrl: string | null,
  domains: string[],
  /**
   * OUT: careers pages that returned HTML but yielded no board — WITH their
   * HTML, so the rungs below (careers-hop, rendered crawl, jsonld) can read
   * them without re-fetching. Re-fetching is not merely slow: a bot-walled site
   * that let one request through may 403 the next.
   */
  reachedPages?: ReachedPage[]
): Promise<DiscoveredBoard | null> {
  const candidates: Array<{ url: string; sourceDomain: string | null }> = [];
  if (careersUrl) candidates.push({ url: careersUrl, sourceDomain: hostOf(careersUrl) || null });
  for (const domain of domains) {
    const base = domain.startsWith("http") ? domain : `https://${domain}`;
    for (const p of CAREERS_PATHS) candidates.push({ url: base + p, sourceDomain: registrable(domain) });
    // The HOMEPAGE, last: it rarely embeds the ATS itself, but its footer is
    // where the "Careers" link to a sibling domain lives (aldi.co.uk →
    // aldirecruitment.co.uk) — the careers-hop rung reads it.
    candidates.push({ url: base, sourceDomain: registrable(domain) });
  }

  for (const { url, sourceDomain } of candidates) {
    const page = await fetchText(url);
    if (!page) continue;
    if (reachedPages && reachedPages.length < 6) {
      reachedPages.push({ url, finalUrl: page.finalUrl, sourceDomain, html: page.html });
    }

    const detected = detectBoardsInHtml(page.html, companyName);

    // 🔴 A JOB BOARD'S PAGE IS FULL OF OTHER EMPLOYERS' ATS BOARDS.
    //
    // detectBoardsInHtml() scrapes every ATS URL out of the HTML. On an employer's
    // careers page there is exactly ONE — theirs. On a recruitment agency's or job
    // board's site there are MANY, because listing other companies' vacancies is the
    // whole business. Crawling reed.co.uk harvested Howden Joinery's Workday board
    // and filed its 155 real jobs under the employer name "Reed"; Pareto and Cedar
    // (both agencies) picked up an AI startup and a US fintech the same way.
    //
    // Recruiter-BRANDED first-party jobs are the exact inversion of what ATS-direct
    // supply is for, so the count itself is the tell: more than one distinct board on
    // a page means this is not an employer's careers page, and nothing on it can be
    // trusted to belong to the company we asked about.
    const distinct = new Set(detected.map((b) => `${b.provider}|${b.token}`));
    if (distinct.size > 1) {
      continue;
    }

    for (const board of detected) {
      const provider = getProvider(board.provider);
      if (!provider) continue;
      const res = await provider.probe(board).catch(() => null);
      if (!res?.exists) continue;

      // A board linked FROM the employer's own careers page is normally
      // self-evidently theirs — that provenance beats any name comparison.
      //
      // EXCEPT when the careers page redirected somewhere else entirely. Acquired
      // companies point their careers URL at the ACQUIRER: hopin.com/careers lands
      // on RingCentral's Workday board. The embed is real, the probe succeeds, and
      // the provenance argument quietly becomes "RingCentral's jobs belong to
      // Hopin". So a cross-domain landing forfeits the auto-verify and the board is
      // held back for a human, rather than silently mislabelling an employer.
      const landedOn = hostOf(page.finalUrl);
      const crossDomain =
        Boolean(sourceDomain) && !sameOrg(landedOn, sourceDomain as string, companyName);

      return {
        ...board,
        discovered_via: "careers-crawl",
        board_company_name: res.boardCompanyName ?? null,
        job_count: res.jobCount,
        verified: !crossDomain,
      };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Rung 2a — the SAME-ORG CAREERS HOP: jobs on a sibling domain
// ---------------------------------------------------------------------------

type ReachedPage = {
  url: string;
  finalUrl: string;
  sourceDomain: string | null;
  /** The HTML we already have — never re-fetch (bot walls are stateful). */
  html: string;
  /** True when this HTML came out of a headless browser (post-JS DOM). */
  rendered?: boolean;
};

const CAREERS_LINK_RE = /career|jobs|vacanc|recruit|join.?us|work.?with|apply/i;

/**
 * Big employers put their JOBS on a different registrable domain and merely LINK
 * it from the marketing site: boots.com → boots.jobs, aldi.co.uk →
 * aldirecruitment.co.uk, lidl.co.uk → careers.lidl.com. The first gap dry-run
 * (2026-07-16) showed this exact shape on most of its misses — the crawl reached
 * boots.com/careers, found no embed, and stopped one click short of an entire
 * careers site.
 *
 * So: follow ONE careers-looking offsite link per reached page — but only when
 * sameOrg() vouches that the target still bears the company's name. That guard
 * is what keeps this from becoming the agency trap: "see our jobs on Reed"
 * points at a host with no "boots" in it and is never followed.
 *
 * Each hop page gets the static embed check here; the caller also feeds the hops
 * into the rendered and jsonld rungs below.
 */
async function followCareersHops(
  companyName: string,
  reached: ReachedPage[]
): Promise<{ board: DiscoveredBoard | null; hops: ReachedPage[] }> {
  const hops: ReachedPage[] = [];
  const seenHosts = new Set<string>();

  for (const r of reached.slice(0, 6)) {
    const srcDom = r.sourceDomain ?? hostOf(r.finalUrl);
    if (!srcDom) continue;

    for (const m of r.html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)) {
      let abs: URL;
      try {
        abs = new URL(m[1], r.finalUrl);
      } catch {
        continue;
      }
      if (abs.protocol !== "https:" && abs.protocol !== "http:") continue;
      const host = registrable(abs.hostname);
      if (host === srcDom || seenHosts.has(host)) continue; // same site / already hopped
      if (!CAREERS_LINK_RE.test(abs.href)) continue; // not a careers link
      // The one rule that matters: the target must still be THIS organisation.
      if (!sameOrg(abs.hostname.toLowerCase(), srcDom, companyName)) continue;
      // An ATS host itself is not a "careers site" hop — detectBoardsInHtml on
      // the source page already handled those links.
      if (detectBoard(abs.toString())) continue;

      seenHosts.add(host);
      const hopUrl = abs.origin + abs.pathname;
      const hopPage = await fetchText(hopUrl);
      if (!hopPage) continue;

      hops.push({ url: hopUrl, finalUrl: hopPage.finalUrl, sourceDomain: srcDom, html: hopPage.html });

      // Static embed check on the hop page, same trust rules as the main crawl.
      const detected = detectBoardsInHtml(hopPage.html, companyName);
      const distinct = new Set(detected.map((b) => `${b.provider}|${b.token}`));
      if (distinct.size > 1) continue;
      for (const board of detected) {
        const provider = getProvider(board.provider);
        if (!provider) continue;
        const res = await provider.probe(board).catch(() => null);
        if (!res?.exists) continue;
        const landedOn = hostOf(hopPage.finalUrl);
        const crossDomain = !sameOrg(landedOn, srcDom, companyName);
        return {
          board: {
            ...board,
            discovered_via: "careers-crawl",
            board_company_name: res.boardCompanyName ?? null,
            job_count: res.jobCount,
            verified: !crossDomain,
          },
          hops,
        };
      }
      if (hops.length >= 3) break;
    }
  }
  return { board: null, hops };
}

// ---------------------------------------------------------------------------
// Rung 2b — RENDERED crawl: the embed a static fetch cannot see
// ---------------------------------------------------------------------------

/**
 * Re-crawl pages we already reached, this time through a headless browser.
 *
 * Why this rung exists: careers.bp.com serves a static shell whose Workday link
 * (`bpinternational.wd3.myworkdayjobs.com`) only materialises in the DOM. The
 * gap census (scripts/.gap.log) put 120 employers in "no recognised fingerprint"
 * for exactly this reason — a JS-rendered page hides its ATS host from a raw
 * HTML fetch. Some of those 120 are on ATSs we ALREADY support, and rendering
 * the page is all it takes to find out. A native adapter is strictly better
 * data than the jsonld scrape, so this rung runs BEFORE jsonld.
 *
 * Same trust rules as the static crawl: >1 distinct board on a page ⇒ jobs
 * board, trust nothing; a cross-domain landing forfeits auto-verification.
 */
async function renderedCrawl(
  companyName: string,
  reached: ReachedPage[]
): Promise<DiscoveredBoard | null> {
  if (!reached.length) return null;
  const result = await withBrowser(async (render) => {
    for (const { url, finalUrl, sourceDomain, html, rendered } of reached.slice(0, 4)) {
      // A page that ALREADY came out of a browser (the bot-wall rescue) needs
      // no second render — read the DOM we have.
      const page = rendered ? { html, finalUrl } : await render(url);
      if (!page) continue;

      const detected = detectBoardsInHtml(page.html, companyName);
      const distinct = new Set(detected.map((b) => `${b.provider}|${b.token}`));
      if (distinct.size > 1) continue; // a jobs board, not an employer's page

      for (const board of detected) {
        const provider = getProvider(board.provider);
        if (!provider) continue;
        const res = await provider.probe(board).catch(() => null);
        if (!res?.exists) continue;

        const landedOn = hostOf(page.finalUrl);
        const crossDomain =
          Boolean(sourceDomain) && !sameOrg(landedOn, sourceDomain as string, companyName);

        return {
          ...board,
          discovered_via: "rendered-crawl" as const,
          board_company_name: res.boardCompanyName ?? null,
          job_count: res.jobCount,
          verified: !crossDomain,
        };
      }
    }
    return null;
  });
  return result ?? null;
}

// ---------------------------------------------------------------------------
// The agency gates for jsonld candidates
// ---------------------------------------------------------------------------

/**
 * 🔴 A RECRUITMENT AGENCY'S CAREERS PAGE PASSES EVERY MARKUP-LEVEL CHECK.
 * It names ONE org (itself) in every JobPosting, its name matches, its domain is
 * its own. The first live sweep registered NINE agencies as verified boards —
 * Ernest Gordon (1,100 client ads), Lorien, 83zero… — recruiter supply wearing
 * the first-party badge, the exact inversion of the moat.
 *
 * No single signal catches them all (measured 2026-07-16):
 *   name patterns   catch "Ernest Gordon RECRUITMENT", miss "83zero"
 *   CH SIC codes    catch Anson Mccade (78109), miss 83zero (filed as 62020 IT
 *                   consultancy) and Certain Advantage (70229 mgmt consultancy)
 *   ad boilerplate  catches the Conduct-Regs line, but these agencies scrub it
 * So the gate is LAYERED, cheapest first, and the last layer is a Haiku read of
 * the ads themselves — "we're partnered with a leading global…" is unmistakable
 * to a language model and invisible to a regex. Discovery-time only (pennies,
 * cached via company_ats_discovery refusals); the nightly pull never pays it.
 */
export async function llmAgencyVerdict(
  companyName: string,
  sampleJds: string[]
): Promise<"AGENCY" | "EMPLOYER" | "UNSURE"> {
  const key = process.env.ANTHROPIC_API_KEY;
  const ads = sampleJds.filter((t) => t && t.length > 80).slice(0, 3);
  if (!key || !ads.length) return "UNSURE";
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 10,
        messages: [
          {
            role: "user",
            content:
              `Company: "${companyName}". Below are excerpts of job ads published on this company's own website.\n\n` +
              ads.map((a, i) => `AD ${i + 1}: ${a.slice(0, 500)}`).join("\n\n") +
              `\n\nIs "${companyName}" a recruitment/staffing agency advertising vacancies AT OTHER employers, ` +
              `or an employer advertising its own staff vacancies? Agencies describe the hiring company in the ` +
              `third person ("our client", "we're partnered with a leading firm", "a business based in…"). ` +
              `Reply with exactly one word: AGENCY, EMPLOYER, or UNSURE.`,
          },
        ],
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return "UNSURE";
    const data = (await res.json()) as { content?: Array<{ text?: string }> };
    const text = (data.content?.[0]?.text ?? "").trim().toUpperCase();
    if (text.startsWith("AGENCY")) return "AGENCY";
    if (text.startsWith("EMPLOYER")) return "EMPLOYER";
    return "UNSURE";
  } catch {
    return "UNSURE";
  }
}

/**
 * All agency gates for a jsonld candidate, cheapest first.
 * "refuse" = do not register at all; "hold" = register unverified (a human
 * decides); "pass" = clean.
 */
export async function agencyGate(
  companyName: string,
  sampleJds: string[]
): Promise<{ verdict: "refuse" | "hold" | "pass"; why: string }> {
  const byName = detectRecruiter(null, companyName);
  if (byName.is_recruiter) return { verdict: "refuse", why: `agency by name (${byName.reason})` };

  // Companies House SIC via the (cached) enrichment row. Import is dynamic so a
  // bare script without enrichment env can still run discovery.
  try {
    const { enrichCompany } = await import("@/lib/enrichment/service");
    const row = await enrichCompany(companyName);
    if (row?.is_likely_recruiter) {
      return { verdict: "refuse", why: `agency by enrichment (${row.recruiter_reason ?? "flag"})` };
    }
  } catch {
    /* enrichment unavailable — the other gates still stand */
  }

  const llm = await llmAgencyVerdict(companyName, sampleJds);
  if (llm === "AGENCY") return { verdict: "refuse", why: "agency by LLM read of its own ads" };
  if (llm === "UNSURE") return { verdict: "hold", why: "LLM unsure whether agency — held for review" };
  return { verdict: "pass", why: "employer" };
}

// ---------------------------------------------------------------------------
// Rung 4 (LAST) — the universal JobPosting JSON-LD reader
// ---------------------------------------------------------------------------

/**
 * No supported ATS embed anywhere, static or rendered. Final question: does the
 * employer's own careers site publish schema.org JobPosting markup we can read
 * directly? (Nearly every employer does — it is how Google for Jobs indexes
 * them.) Registered with provider "jsonld" and token = the careers URL.
 *
 * VERIFICATION: the hiringOrganization name inside the JSON-LD is board-authored
 * content (the provider never echoes our own name back), so namesMatch() against
 * it is a real check. A manually supplied --careers-url is human provenance and
 * verifies even when the org name differs (brand vs legal entity).
 */
async function jsonldCrawl(
  companyName: string,
  careersUrl: string | null,
  reached: Array<{ url: string; finalUrl: string; sourceDomain: string | null }>
): Promise<DiscoveredBoard | null> {
  const allowRendering = await renderingAvailable();

  // Prefer the page we LANDED on over the URL we guessed — bp.com/careers.html
  // redirects to careers.bp.com, and the landing host is where the jobs are.
  const candidates: string[] = [];
  const push = (u: string | null | undefined) => {
    if (u && !candidates.includes(u)) candidates.push(u);
  };
  push(careersUrl);
  for (const r of reached.slice(0, 3)) {
    push(r.finalUrl);
    push(r.url);
  }

  for (const url of candidates.slice(0, 4)) {
    const probe = await probeJsonLdSite(url, allowRendering, companyName).catch(() => null);
    if (!probe) continue;
    if ("error" in probe) continue; // multi-org or robots refusal — not this URL

    // The agency gates (name → SIC → LLM read of the ads). A refusal here is a
    // refusal of the COMPANY, not just this URL — stop, don't try the next one.
    const gate = await agencyGate(companyName, probe.sampleJds);
    if (gate.verdict === "refuse") return null;

    const orgSaysItself = probe.orgNames.some((n) => namesMatch(companyName, n));
    const manual = Boolean(careersUrl && url === careersUrl);

    return {
      provider: "jsonld",
      token: url,
      companyName,
      renderMode: probe.renderMode,
      discovered_via: "jsonld-crawl",
      board_company_name: probe.orgNames[0] ?? null,
      job_count: probe.jobCount,
      // Unverified boards are held back from ingest (registry.ts) — a scraped
      // site whose postings name a DIFFERENT org than we asked for is exactly
      // the "wrong data is worse than none" case; same for one the LLM couldn't
      // confidently call an employer.
      verified: (orgSaysItself || manual) && gate.verdict === "pass",
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Rung 3 — domain resolution
// ---------------------------------------------------------------------------

function slug(companyName: string): string {
  return normaliseCompanyName(companyName).replace(/[^a-z0-9]/g, "");
}

/**
 * A slug-guessed domain is built FROM the company name — so the page will echo the
 * name back merely by displaying its own domain, and "does the page mention the
 * company?" answers itself. oxfam.io's for-sale page contains the word "oxfam", so
 * it PASSED, and Oxfam (oxfam.org.uk) got recorded as "no ATS board" for 30 days.
 *
 * This is the same circular-verification bug as an adapter echoing back
 * board.companyName so namesMatch() compares a company against itself. Same shape,
 * different rung: never let a candidate supply its own evidence.
 *
 * So: strip the domain (and its bare slug in URL position) out of the haystack
 * BEFORE looking for the company name, and reject the parked-page boilerplate
 * outright.
 */
const PARKED_MARKERS = [
  "domain is for sale", "buy this domain", "this domain is parked", "domain for sale",
  "hugedomains", "sedo.com", "afternic", "dan.com", "namecheap.com/domains",
  "inquire about this domain", "checkout the domain", "parked free, courtesy of",
];

function looksLikeCompanySite(html: string, companyName: string, domain: string): boolean {
  const hay = html.slice(0, 40_000).toLowerCase();
  if (PARKED_MARKERS.some((m) => hay.includes(m))) return false;

  // De-circularise: remove every echo of the domain itself.
  const bare = domain.split(".")[0];
  const stripped = hay.split(domain.toLowerCase()).join(" ").split(`${bare}.`).join(" ");

  const words = normaliseCompanyName(companyName).split(" ").filter((w) => w.length > 3);
  // A name with no substantial word ("BP", "EE") gives us nothing to confirm
  // against. The old code returned TRUE here, which verified ANY page that loaded.
  if (words.length === 0) return false;
  return words.some((w) => stripped.includes(w));
}

/**
 * Slug + TLD guesses. `.io`/`.ai` are LAST, not second: they are startup TLDs, and
 * a UK housebuilder is not on persimmon.ai (which is a real, unrelated AI company).
 * The institutional TLDs were missing entirely, which made every charity,
 * university, NHS trust and public body in the seed list unreachable BY
 * CONSTRUCTION — Oxfam is .org.uk, TfL is .gov.uk, Cambridge is .ac.uk.
 */
const GUESS_TLDS = [".com", ".co.uk", ".org.uk", ".org", ".ac.uk", ".nhs.uk", ".gov.uk", ".net", ".io", ".ai"];

async function guessDomains(companyName: string): Promise<string[]> {
  const s = slug(companyName);
  if (!s || s.length < 3) return [];
  const out: string[] = [];
  for (const tld of GUESS_TLDS) {
    const domain = `${s}${tld}`;
    const page = await fetchText(`https://${domain}`, 8000);
    if (!page) continue;
    if (!looksLikeCompanySite(page.html, companyName, domain)) continue;
    out.push(domain);
  }
  return out;
}

async function llmDomain(companyName: string): Promise<string | null> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 100,
        messages: [
          {
            role: "user",
            content:
              `What is the primary corporate website domain for the UK employer brand "${companyName}"?\n` +
              `Reply with ONLY the bare domain (e.g. "monzo.com"). ` +
              `If you are not confident this is a real, specific company you recognise, reply exactly "UNKNOWN". ` +
              `A wrong domain is worse than no answer.`,
          },
        ],
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { content?: Array<{ text?: string }> };
    const text = (data.content?.[0]?.text ?? "").trim().toLowerCase();
    if (!text || text.includes("unknown")) return null;
    const m = text.match(/([a-z0-9-]+\.)+[a-z]{2,}/);
    return m ? m[0] : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The ladder
// ---------------------------------------------------------------------------

export async function discoverForCompany(
  companyName: string,
  opts: DiscoverOptions = {}
): Promise<{ board: DiscoveredBoard | null; providersTried: AtsProviderId[]; notes: string }> {
  const providers = opts.providers ?? ENABLED_PROVIDERS;
  const tried: AtsProviderId[] = [];

  // Rung 1 — probe the guessable tokens. Run providers in parallel: they're
  // independent HTTP calls to different hosts, and doing them in series turns a
  // 200ms discovery into a 1.5s one, which at registry scale is hours.
  const probes = await Promise.all(
    providers.map(async (p) => {
      tried.push(p);
      return probeProvider(p, companyName);
    })
  );
  const hit = probes.find((b) => b?.verified) ?? probes.find(Boolean);
  if (hit) {
    return {
      board: hit,
      providersTried: tried,
      notes: hit.verified ? "token-probe verified" : "token-probe, board reports no company name",
    };
  }

  if (opts.probeOnly) {
    return { board: null, providersTried: tried, notes: "no board found by token probe" };
  }

  // Rung 2/3 — find the careers page and read the embed.
  //
  // ORDER MATTERS, and it used to be backwards. The old code ran the slug-guesser
  // first and only fell through to the LLM `if (!domain)` — but the guesser's
  // self-confirming check almost always returned SOMETHING, so the accurate rung
  // was rarely reached at all. It "resolved" Oxfam to oxfam.io, Persimmon to
  // persimmon.ai and Kier to kier.io, crawled those, found nothing, and cached a
  // 30-day miss against the real employer.
  //
  // Now: ask the model FIRST (it knows oxfam.org.uk), keep the slug guesses as
  // fallbacks, and crawl EVERY candidate rather than betting the company on the
  // first domain that happened to return HTML.
  const domains: string[] = [];
  if (!opts.careersUrl) {
    if (opts.knownDomains?.length) {
      // Already resolved on a previous attempt — don't re-guess (or re-MIS-guess).
      domains.push(...opts.knownDomains.map(registrable));
    } else {
      if (opts.useLlm) {
        const d = await llmDomain(companyName);
        if (d) domains.push(registrable(d));
      }
      for (const d of await guessDomains(companyName)) {
        if (!domains.includes(d)) domains.push(d);
      }
    }
  }
  if (!opts.careersUrl && domains.length === 0) {
    return { board: null, providersTried: tried, notes: "no board; could not resolve a website" };
  }

  const reached: ReachedPage[] = [];
  const crawled = await crawlCareers(companyName, opts.careersUrl ?? null, domains, reached);
  if (crawled) {
    return {
      board: crawled,
      providersTried: tried,
      notes:
        `careers-crawl via ${opts.careersUrl ?? domains.join("/")}` +
        (crawled.verified ? "" : " — CROSS-DOMAIN redirect, held back for review"),
    };
  }

  // BOT-WALL RESCUE. Aldi's and Boots' retail sites 403 every plain fetch
  // (Akamai/Imperva) — while a real chromium sails straight through the same
  // wall. Any domain we RESOLVED but could not read a single page of gets its
  // homepage + /careers rendered, and that DOM feeds the rungs below. Per
  // DOMAIN, not per company: Aldi's aldi.com country-selector was reachable
  // while aldi.co.uk (where the careers link lives) 403'd — a company-level
  // check would have called that "reached" and starved the hop rung anyway.
  if ((opts.careersUrl || domains.length) && (await renderingAvailable())) {
    const reachedDomains = new Set(reached.map((r) => r.sourceDomain).filter(Boolean));
    const rescueTargets: Array<{ url: string; sourceDomain: string | null }> = [];
    if (opts.careersUrl && !reached.some((r) => r.url === opts.careersUrl)) {
      rescueTargets.push({ url: opts.careersUrl, sourceDomain: hostOf(opts.careersUrl) || null });
    }
    for (const d of domains.slice(0, 3)) {
      if (reachedDomains.has(d)) continue;
      const base = d.startsWith("http") ? d : `https://${d}`;
      rescueTargets.push({ url: `${base}/careers`, sourceDomain: d });
      rescueTargets.push({ url: base, sourceDomain: d });
    }
    if (rescueTargets.length) {
      await withBrowser(async (render) => {
        let rescued = 0;
        for (const t of rescueTargets) {
          if (rescued >= 3) break;
          const page = await render(t.url);
          if (!page || page.html.length < 2_000) continue; // a challenge stub, not a page
          reached.push({ ...t, finalUrl: page.finalUrl, html: page.html, rendered: true });
          rescued++;
        }
        return null;
      });
    }
  }

  // Rung 2a — follow ONE same-org careers link off each reached page. The jobs
  // often live on a sibling domain (boots.com → boots.jobs) and the crawl above
  // stops one click short of them.
  const { board: hopBoard, hops } = await followCareersHops(companyName, reached);
  if (hopBoard) {
    return {
      board: hopBoard,
      providersTried: tried,
      notes:
        `careers-hop via ${hops[hops.length - 1]?.url ?? "?"}` +
        (hopBoard.verified ? "" : " — CROSS-DOMAIN redirect, held back for review"),
    };
  }
  // Hops FIRST: the hop target is the dedicated careers site; the pages we
  // guessed our way onto are the fallback.
  const careersPages = [...hops, ...reached];

  // Rung 2b — render the pages we reached: a JS-built page can link a supported
  // ATS that the static fetch never saw (careers.bp.com → Workday). A native
  // adapter beats a scrape, so this runs before jsonld.
  if (await renderingAvailable()) {
    const rendered = await renderedCrawl(companyName, careersPages);
    if (rendered) {
      return {
        board: rendered,
        providersTried: tried,
        notes:
          `rendered-crawl via ${rendered.token} — embed only visible after JS` +
          (rendered.verified ? "" : " — CROSS-DOMAIN redirect, held back for review"),
      };
    }
  }

  // Rung 4 (LAST) — no supported ATS anywhere. Read the site's own schema.org
  // JobPosting JSON-LD.
  const jsonld = await jsonldCrawl(companyName, opts.careersUrl ?? null, careersPages);
  if (jsonld) {
    return {
      board: jsonld,
      providersTried: [...tried, "jsonld"],
      notes:
        `jsonld-crawl via ${jsonld.token} (${jsonld.renderMode})` +
        (jsonld.verified ? "" : " — org name does not match, held back for review"),
    };
  }

  return {
    board: null,
    providersTried: tried,
    notes: `no ATS embed found on ${opts.careersUrl ?? domains.join(", ")}`,
  };
}
