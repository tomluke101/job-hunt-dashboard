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

import { getProvider, ATS_PROVIDERS } from "./providers";
import { ENABLED_PROVIDERS, type AtsBoard, type AtsProviderId } from "./types";
import { normaliseCompanyName } from "@/lib/enrichment/normalise-company";

export interface DiscoveredBoard extends AtsBoard {
  discovered_via: "token-probe" | "careers-crawl" | "seed" | "manual";
  board_company_name: string | null;
  job_count: number;
  /** verified = the board itself confirms who it belongs to. */
  verified: boolean;
}

export interface DiscoverOptions {
  /** Known careers page. Skips domain guessing entirely. */
  careersUrl?: string | null;
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

async function fetchText(url: string, timeoutMs = 12_000): Promise<string | null> {
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
    return await res.text();
  } catch {
    return null;
  }
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
  domain: string | null
): Promise<DiscoveredBoard | null> {
  const candidates: string[] = [];
  if (careersUrl) candidates.push(careersUrl);
  if (domain) {
    const base = domain.startsWith("http") ? domain : `https://${domain}`;
    for (const p of CAREERS_PATHS) candidates.push(base + p);
  }

  for (const url of candidates.slice(0, 8)) {
    const html = await fetchText(url);
    if (!html) continue;

    for (const board of detectBoardsInHtml(html, companyName)) {
      const provider = getProvider(board.provider);
      if (!provider) continue;
      const res = await provider.probe(board).catch(() => null);
      if (!res?.exists) continue;
      return {
        ...board,
        discovered_via: "careers-crawl",
        board_company_name: res.boardCompanyName ?? null,
        job_count: res.jobCount,
        // A board linked FROM the employer's own careers page is self-evidently
        // theirs. That provenance is stronger than any name comparison, so it
        // verifies even when the provider reports no company name.
        verified: true,
      };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Rung 3 — domain resolution
// ---------------------------------------------------------------------------

function slug(companyName: string): string {
  return normaliseCompanyName(companyName).replace(/[^a-z0-9]/g, "");
}

/** Cheap guesses before we pay for a model call. */
async function guessDomain(companyName: string): Promise<string | null> {
  const s = slug(companyName);
  if (!s || s.length < 3) return null;
  for (const tld of [".com", ".co.uk", ".io", ".ai"]) {
    const domain = `${s}${tld}`;
    const html = await fetchText(`https://${domain}`, 8000);
    if (!html) continue;
    // Confirm the page is actually about this company — a parked domain or a
    // squatter would otherwise send the crawler off hunting a stranger's board.
    const words = normaliseCompanyName(companyName).split(" ").filter((w) => w.length > 3);
    const hay = html.slice(0, 20_000).toLowerCase();
    if (words.length === 0 || words.some((w) => hay.includes(w))) return domain;
  }
  return null;
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
  let domain: string | null = null;
  if (!opts.careersUrl) {
    domain = await guessDomain(companyName);
    if (!domain && opts.useLlm) domain = await llmDomain(companyName);
  }
  if (!opts.careersUrl && !domain) {
    return { board: null, providersTried: tried, notes: "no board; could not resolve a website" };
  }

  const crawled = await crawlCareers(companyName, opts.careersUrl ?? null, domain);
  if (crawled) {
    return { board: crawled, providersTried: tried, notes: `careers-crawl via ${opts.careersUrl ?? domain}` };
  }

  return {
    board: null,
    providersTried: tried,
    notes: `no ATS embed found on ${opts.careersUrl ?? domain}`,
  };
}
