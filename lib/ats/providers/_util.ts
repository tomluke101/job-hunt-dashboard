// Shared plumbing for every ATS provider adapter.
//
// Everything in here exists because a provider lied to us in a way that was
// silent — the pull "worked", the job count looked fine, and the DATA was
// wrong. Read the comments before simplifying any of it.

import { ATS_FETCH_TIMEOUT_MS, MAX_JOBS_PER_BOARD } from "../types";
import type {
  AtsBoard,
  AtsProvider,
  AtsPullResult,
  EmploymentType,
  SeniorityLevel,
} from "../types";
import { htmlToText } from "@/lib/job-search/html-to-text";

// ---------------------------------------------------------------------------
// Pull options
// ---------------------------------------------------------------------------

/**
 * Optional knobs for `listJobs`. Kept OUT of the AtsProvider signature (it is a
 * frozen contract) and passed as an optional 2nd arg, so a caller that knows
 * nothing about budgets still gets safe defaults.
 *
 * The budget only bites on the two providers with an N+1 detail fetch
 * (SmartRecruiters, Workday). Without it, one 900-job board with a slow detail
 * endpoint can hold an entire 2,000-board ingest run hostage.
 */
export interface AtsPullOptions {
  /** Wall-clock budget for the whole board pull, including detail fetches. */
  budgetMs?: number;
  /** Override the per-board job cap (defaults to MAX_JOBS_PER_BOARD). */
  maxJobs?: number;
  /**
   * jsonld only: page URLs already represented in the corpus (job_postings.
   * source_url for this board). A URL that is STILL ENUMERATED by the site's
   * sitemap/listing is a job that is still open — the provider reports it in
   * `stillListedUrls` WITHOUT re-fetching the page, and spends its page budget
   * exclusively on NEW urls. This is what makes a 3,000-page global board
   * affordable nightly: enumeration is one sitemap fetch; only the delta costs
   * page fetches. Boards larger than one run's cap complete themselves across
   * consecutive runs (each run fetches the next cap-worth of new pages).
   */
  skipUrls?: Set<string>;
}

/**
 * What an adapter actually implements: the frozen AtsProvider contract, plus an
 * OPTIONAL options arg on listJobs.
 *
 * It stays optional (rather than being added to AtsProvider) for two reasons:
 * AtsProvider is a contract I was told not to change, and ingest.ts already calls
 * `provider.listJobs(board)` with one arg. An optional param is assignable to the
 * narrower type, so ATS_PROVIDERS can still be typed Record<AtsProviderId, AtsProvider>
 * exactly as specified — callers that want a budget reach for pullBoard() instead.
 */
export interface AtsProviderImpl extends Omit<AtsProvider, "listJobs"> {
  listJobs(board: AtsBoard, opts?: AtsPullOptions): Promise<AtsPullResult>;
}

/**
 * Per-board wall-clock budget.
 *
 * 60s was not enough for the boards that matter most. The N+1 providers (Workday,
 * SmartRecruiters) must fetch one detail request per job — that is where the JD
 * and the only real posting date live — so a 1,314-job board needs ~1,314 requests
 * at DETAIL_CONCURRENCY=5. It cannot finish in 60s, and when it ran out it just
 * stopped, flagged `truncated`, and nothing read the flag. Raising MAX_JOBS_PER_BOARD
 * without raising this would simply move the silent cut from the cap to the clock.
 *
 * ⚠️ RAISED 240s -> 600s (2026-07-14). Once the registry grew to 94 boards, four
 * of them polling concurrently contend for bandwidth, and AstraZeneca — which had
 * comfortably pulled 1,313 jobs at 240s — got only 700 away before the clock ran
 * out. The board did not change; its NEIGHBOURS did. A per-board budget that is
 * really a function of how many OTHER boards happen to be in flight is not a
 * budget, it is a race, and it silently amputates the biggest employers first.
 *
 * This is the per-board ceiling for the offline script, which has all night. The
 * CRON passes its own, much smaller, whole-run `budgetMs` and polls oldest-first,
 * so raising this does not let a serverless invocation overrun.
 */
export const DEFAULT_BOARD_BUDGET_MS = 600_000;

/**
 * Detail-fetch concurrency for the N+1 providers.
 *
 * Five was deliberately modest — these are free, unauthenticated endpoints and
 * getting IP-blocked would kill supply for every user. But it was too modest for
 * the biggest boards, and the cost was not merely "a slow ingest":
 *
 * AstraZeneca (1,313 jobs) and Barclays (1,115) could not finish their detail
 * fetches inside the per-board budget. THE DETAIL IS WHERE `country` LIVES. So the
 * timeout silently stripped the country hint off exactly the jobs most likely to be
 * foreign — and Barclays' Wilmington, DELAWARE jobs then matched the UK gazetteer
 * (there is a Wilmington in Kent) and entered the corpus as country_code=GB.
 *
 * A timeout that drops a FIELD is far more dangerous than one that drops a JOB:
 * a missing job is absent, a job missing its country is WRONG. Eight is still a
 * polite rate against a single tenant, and it clears the largest board we have with
 * room to spare.
 */
export const DETAIL_CONCURRENCY = 8;

export function budgetDeadline(opts?: AtsPullOptions): number {
  return Date.now() + (opts?.budgetMs ?? DEFAULT_BOARD_BUDGET_MS);
}

export function jobCap(opts?: AtsPullOptions): number {
  return Math.max(1, opts?.maxJobs ?? MAX_JOBS_PER_BOARD);
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

export interface HttpResult<T> {
  ok: boolean;
  /** 0 means the request never completed (network error / timeout / bad JSON). */
  status: number;
  data: T | null;
  error?: string;
}

const UA = "HuntHQ/1.0 (job aggregation; +https://hunthq.app)";

/**
 * Fetch JSON, never throw.
 *
 * Rule 2 of the whole subsystem: one bad board must never kill an ingest run of
 * 2,000 boards. Every failure mode — DNS, TLS, timeout, 500, HTML error page
 * served with a JSON content-type — has to come back as a VALUE, not an
 * exception, or a single dead company takes the run down with it.
 */
export async function httpJson<T>(
  url: string,
  init?: { method?: string; body?: string; headers?: Record<string, string> },
  /**
   * Transient failures get ONE retry.
   *
   * Timeouts and 5xx are common on big boards (Palantir's Lever payload is ~2MB
   * and timed out once during verification) and on Workday, which is slow. Without
   * a retry, a single network blip marks the board failed — and five of those in a
   * row will mark a perfectly healthy board DEAD and stop polling it forever.
   * We do NOT retry a 404/422: those are real answers, not blips.
   */
  attempt = 0
): Promise<HttpResult<T>> {
  try {
    const res = await fetch(url, {
      method: init?.method ?? "GET",
      body: init?.body,
      headers: {
        accept: "application/json",
        "user-agent": UA,
        ...(init?.body ? { "content-type": "application/json" } : {}),
        ...(init?.headers ?? {}),
      },
      cache: "no-store",
      signal: AbortSignal.timeout(ATS_FETCH_TIMEOUT_MS),
    });

    if (!res.ok) {
      // 429 = WE are going too fast, not "this board is broken". Observed live on
      // Recruitee 2026-07-12 during repeated probe runs. Without this, a rate-limit
      // in the middle of an ingest silently drops whole employers — and because the
      // board still "exists", nothing ever flags it. Back off (honouring Retry-After
      // when the server sends one) and try once more.
      //
      // 5xx is the server having a moment; 404/422 is a real answer about a real
      // board and retrying it just wastes the ingest budget.
      const transient = res.status >= 500 || res.status === 429;
      if (transient && attempt === 0) {
        const retryAfter = Number(res.headers.get("retry-after"));
        // Cap the wait: an honest ingest budget beats obeying a 300s Retry-After.
        const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.min(retryAfter * 1000, 5_000)
          : res.status === 429
            ? 2_000
            : 750;
        await new Promise((r) => setTimeout(r, waitMs));
        return httpJson<T>(url, init, attempt + 1);
      }
      const body = await res.text().catch(() => "");
      return {
        ok: false,
        status: res.status,
        data: null,
        error: `HTTP ${res.status}: ${body.slice(0, 200)}`,
      };
    }

    // A 200 carrying HTML (a login wall, a CDN interstitial) is a real observed
    // failure. Parse defensively so it surfaces as an error rather than a throw.
    const text = await res.text();
    try {
      return { ok: true, status: res.status, data: JSON.parse(text) as T };
    } catch {
      return {
        ok: false,
        status: res.status,
        data: null,
        error: `HTTP ${res.status} but body was not JSON: ${text.slice(0, 120)}`,
      };
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Timeout / DNS / TLS wobble — retry once. Palantir's 2MB Lever payload timed
    // out exactly like this during verification and succeeded immediately after.
    if (attempt === 0) {
      await new Promise((r) => setTimeout(r, 750));
      return httpJson<T>(url, init, attempt + 1);
    }
    return { ok: false, status: 0, data: null, error: `network: ${msg}` };
  }
}

/**
 * Run `fn` over `items` with a hard concurrency cap AND a wall-clock deadline.
 * Items not reached before the deadline come back as null and `timedOut` is set,
 * so the caller can flag the pull `truncated` instead of pretending it's complete.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  deadlineAt: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<{ results: (R | null)[]; timedOut: boolean; attempted: number }> {
  const results: (R | null)[] = new Array(items.length).fill(null);
  let cursor = 0;
  let timedOut = false;

  async function worker(): Promise<void> {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      if (Date.now() > deadlineAt) {
        timedOut = true;
        return;
      }
      try {
        results[i] = await fn(items[i], i);
      } catch {
        // Swallow: a single failed detail fetch degrades ONE job to title-only.
        // It must not abort the other 900.
        results[i] = null;
      }
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  // How many items were STARTED before the clock ran out. Items are taken in
  // index order, so a caller that front-loads its list (jsonld's UK-first
  // ordering) can tell whether a timeout cut into the part it cares about.
  return { results, timedOut, attempted: Math.min(cursor, items.length) };
}

// ---------------------------------------------------------------------------
// HTML / text
// ---------------------------------------------------------------------------

const NAMED: Record<string, string> = {
  lt: "<", gt: ">", amp: "&", quot: '"', apos: "'", nbsp: " ", "#39": "'",
};

function decodeEntitiesOnce(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex: string) => {
      const code = parseInt(hex, 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : _m;
    })
    .replace(/&#(\d+);/g, (_m, dec: string) => {
      const code = parseInt(dec, 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : _m;
    })
    .replace(/&([a-zA-Z]+);/g, (whole, name: string) => NAMED[name.toLowerCase()] ?? whole);
}

/** Does this string look like HTML that has been ENTITY-ESCAPED (`&lt;p&gt;`)? */
function looksEscapedHtml(s: string): boolean {
  return /&lt;\/?(p|div|br|strong|em|span|ul|ol|li|h[1-6]|table|a)\b/i.test(s);
}

/**
 * THE GREENHOUSE TRAP.
 *
 * Greenhouse's `content` field is not HTML — it is HTML that has been
 * entity-escaped. It literally begins:
 *     &lt;div class=&quot;content-intro&quot;&gt;&lt;p&gt;&lt;strong&gt;
 *
 * htmlToText() strips TAGS first and decodes ENTITIES second (correct for real
 * HTML). Feed it escaped HTML and there are no tags to strip, so the entities
 * decode at the END and you are left with the literal text
 *     <div class="content-intro"><p><strong>
 * sitting inside jd_text. It looks like a JD, it has a plausible length, and it
 * quietly poisons every keyword match, the JD-length quality score and anything
 * that renders the text. Verified broken on 2026-07-12.
 *
 * Fix: DECODE FIRST, then strip. The loop handles the (rare, observed on a few
 * boards) double-escaped case without ever running away.
 */
export function decodeEscapedHtml(s: string): string {
  let out = s;
  for (let i = 0; i < 3 && looksEscapedHtml(out); i++) out = decodeEntitiesOnce(out);
  return out;
}

/** Decode escaped HTML if present, THEN convert to text. Use for every ATS JD. */
export function decodeThenHtmlToText(s: string | null | undefined): string {
  if (!s) return "";
  return htmlToText(decodeEscapedHtml(s));
}

/** Join JD parts (description + requirements + lists) with clean paragraph gaps. */
export function joinJd(parts: (string | null | undefined)[]): string {
  return parts
    .map((p) => (p ?? "").trim())
    .filter((p) => p.length > 0)
    .join("\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

/** ISO-8601 or null. Never throws, never returns "Invalid Date". */
export function safeIso(v: string | number | null | undefined): string | null {
  if (v === null || v === undefined || v === "") return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Recruitee stamps dates as "2025-12-22 10:19:52 UTC" — a space instead of the
 * `T`, and a trailing zone NAME. `new Date()` parses that inconsistently across
 * engines (V8 tolerates it, others return Invalid Date), so normalise to real
 * ISO before parsing rather than betting on the runtime.
 */
export function parseLooseUtc(v: string | null | undefined): string | null {
  if (!v) return null;
  const normalised = v.trim().replace(/\s+UTC$/i, "Z").replace(/^(\d{4}-\d{2}-\d{2}) /, "$1T");
  return safeIso(normalised) ?? safeIso(v);
}

// ---------------------------------------------------------------------------
// Canonical enums
// ---------------------------------------------------------------------------

function normKey(s: string): string {
  return s.toLowerCase().replace(/[^a-z]/g, "");
}

const EMPLOYMENT_TYPE_MAP: Record<string, EmploymentType> = {
  // full_time
  fulltime: "full_time", full: "full_time", permanent: "full_time",
  regular: "full_time", fte: "full_time", fulltimeemployee: "full_time",
  // part_time
  parttime: "part_time", part: "part_time",
  // contract
  contract: "contract", contractor: "contract", freelance: "contract",
  consultant: "contract", b2b: "contract",
  // temporary
  temporary: "temporary", temp: "temporary", seasonal: "temporary",
  fixedterm: "temporary", fixedtermcontract: "temporary", interim: "temporary",
  // internship
  intern: "internship", internship: "internship", placement: "internship",
  coop: "internship", workexperience: "internship",
  // apprenticeship
  apprentice: "apprenticeship", apprenticeship: "apprenticeship",
};

/**
 * Canonicalise the provider's OWN employment-type field. Returns null when the
 * provider didn't say.
 *
 * NEVER guess from the title. "Senior Contract Manager" is a permanent role;
 * "Head of Interim Staffing" is not a temp job. A wrong hint is worse than no
 * hint because the Job Type filter treats it as fact and silently hides the
 * role — a proper title classifier ships separately.
 */
export function canonEmploymentType(raw: unknown): EmploymentType | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  return EMPLOYMENT_TYPE_MAP[normKey(raw)] ?? null;
}

const SENIORITY_MAP: Record<string, SeniorityLevel> = {
  intern: "intern", internship: "intern", student: "intern", trainee: "intern",
  entry: "entry", entrylevel: "entry", graduate: "entry", grad: "entry", junior1: "entry",
  junior: "junior", jr: "junior", associate: "junior", associatelevel: "junior",
  mid: "mid", midlevel: "mid", intermediate: "mid", experienced: "mid",
  // LinkedIn/SmartRecruiters ship ONE bucket spanning mid AND senior. We take the
  // LOWER bound: a mid-level searcher still sees the role, and the seniority
  // filter is a soft preference (weight 0.5) rather than a hard gate, so the
  // downside of under-calling is smaller than the downside of hiding it.
  midsenior: "mid", midseniorlevel: "mid",
  senior: "senior", sr: "senior", seniorlevel: "senior", expert: "senior",
  lead: "lead", teamlead: "lead", staff: "lead",
  principal: "principal",
  director: "director", head: "director", headof: "director", vp: "director",
  executive: "executive", executivelevel: "executive", clevel: "executive", chief: "executive",
  // NOTE: SmartRecruiters' "not_applicable" is deliberately ABSENT — it means the
  // employer declined to classify, so it must fall through to null, not be coerced
  // into a bucket.
};

/** Canonicalise the provider's OWN seniority field. Null when unstated. */
export function canonSeniority(raw: unknown): SeniorityLevel | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const k = normKey(raw);
  const direct = SENIORITY_MAP[k];
  if (direct) return direct;
  // "entry_level" / "mid_level" / "senior_level" — same value with a suffix.
  if (k.endsWith("level") && k.length > 5) {
    const stripped = SENIORITY_MAP[k.slice(0, -5)];
    if (stripped) return stripped;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Country
// ---------------------------------------------------------------------------

const COUNTRY_TO_ISO2: Record<string, string> = {
  "united kingdom": "GB", "united kingdom of great britain and northern ireland": "GB",
  uk: "GB", "great britain": "GB", britain: "GB", england: "GB", scotland: "GB",
  wales: "GB", "northern ireland": "GB",
  "united states": "US", "united states of america": "US", usa: "US", "u.s.a.": "US",
  america: "US",
  ireland: "IE", "republic of ireland": "IE",
  germany: "DE", france: "FR", spain: "ES", portugal: "PT", italy: "IT",
  netherlands: "NL", "the netherlands": "NL", belgium: "BE", luxembourg: "LU",
  poland: "PL", sweden: "SE", norway: "NO", denmark: "DK", finland: "FI",
  switzerland: "CH", austria: "AT", "czech republic": "CZ", czechia: "CZ",
  romania: "RO", hungary: "HU", bulgaria: "BG", greece: "GR", croatia: "HR",
  canada: "CA", australia: "AU", "new zealand": "NZ",
  india: "IN", singapore: "SG", japan: "JP", china: "CN", "hong kong": "HK",
  "south korea": "KR", "korea, republic of": "KR",
  brazil: "BR", mexico: "MX", argentina: "AR", chile: "CL", colombia: "CO",
  "south africa": "ZA", israel: "IL", "united arab emirates": "AE", uae: "AE",
  turkey: "TR", "türkiye": "TR", ukraine: "UA", estonia: "EE", latvia: "LV",
  lithuania: "LT", slovakia: "SK", slovenia: "SI", serbia: "RS", iceland: "IS",
  malta: "MT", cyprus: "CY", philippines: "PH", indonesia: "ID", malaysia: "MY",
  vietnam: "VN", thailand: "TH", nigeria: "NG", kenya: "KE", egypt: "EG",
};

/**
 * Country name/code → ISO-2. Providers hand us three different shapes for the
 * same fact: SmartRecruiters "gb" (lowercase ISO-2), Ashby "United Kingdom",
 * Workday "United States of America". Normalising here means the geo layer only
 * ever handles one.
 */
export function toIso2(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim().toLowerCase();
  if (!s) return null;
  // The lookup MUST come before the 2-letter passthrough. Ashby's Multiverse board
  // reports its country as "UK" — which LOOKS like an ISO-2 code and is not one
  // (ISO-2 for the United Kingdom is GB). Passing "UK" through would hand the geo
  // layer a country code that matches no country, and every job on that board
  // would fail its country check. Observed live 2026-07-12.
  const mapped = COUNTRY_TO_ISO2[s];
  if (mapped) return mapped;
  if (/^[a-z]{2}$/.test(s)) return s.toUpperCase();
  return null;
}

// ---------------------------------------------------------------------------
// Location splitting
// ---------------------------------------------------------------------------

/**
 * Tokens that are a QUALIFIER on the place before them, not a second place.
 * The distinction matters because of the comma: "London, United Kingdom" is ONE
 * location, "Cardiff, London" is TWO. Splitting the first blindly gives the geo
 * layer a candidate of "United Kingdom", whose centroid sits in a field near
 * Nottingham — which would then pass a "within 25 miles of Nottingham" filter
 * for a job in London.
 */
const PLACE_QUALIFIERS = new Set<string>([
  ...Object.keys(COUNTRY_TO_ISO2),
  "u.s.", "u.k.", "emea", "apac", "americas", "europe", "eu", "north america",
  "middle east", "asia", "latam", "anywhere", "worldwide", "global",
  // US states + provinces show up as ", CA" / ", NY" / ", ON".
  "alabama", "alaska", "arizona", "arkansas", "california", "colorado",
  "connecticut", "delaware", "florida", "georgia", "hawaii", "idaho", "illinois",
  "indiana", "iowa", "kansas", "kentucky", "louisiana", "maine", "maryland",
  "massachusetts", "michigan", "minnesota", "mississippi", "missouri", "montana",
  "nebraska", "nevada", "new hampshire", "new jersey", "new mexico", "new york",
  "north carolina", "north dakota", "ohio", "oklahoma", "oregon", "pennsylvania",
  "rhode island", "south carolina", "south dakota", "tennessee", "texas", "utah",
  "vermont", "virginia", "washington", "west virginia", "wisconsin", "wyoming",
  "district of columbia", "washington dc", "dc", "ontario", "quebec",
  "british columbia", "alberta",
]);

function isQualifier(seg: string): boolean {
  const s = seg.trim().toLowerCase().replace(/\.$/, "");
  if (!s) return true;
  if (PLACE_QUALIFIERS.has(s)) return true;
  // Bare 2-letter uppercase after a comma is a state/province code ("CA", "NY").
  if (/^[A-Z]{2}$/.test(seg.trim())) return true;
  // "Remote (UK)", "Remote - Europe" — a modality, not a distinct place.
  if (/^remote\b/i.test(s) || /^hybrid\b/i.test(s)) return true;
  return false;
}

/** Split on top-level separators only — anything inside (parens) stays intact. */
function splitTopLevel(s: string, seps: RegExp): string[] {
  const out: string[] = [];
  let depth = 0;
  let buf = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth = Math.max(0, depth - 1);
    if (depth === 0) {
      const rest = s.slice(i);
      const m = rest.match(seps);
      if (m && m.index === 0) {
        out.push(buf);
        buf = "";
        i += m[0].length - 1;
        continue;
      }
    }
    buf += ch;
  }
  out.push(buf);
  return out;
}

// ";" | "|" | " or " | "/" | " & " | newline — all unambiguous multi-location
// separators. Comma is handled separately below because it is NOT unambiguous.
const HARD_SEPARATORS = /^(?:\s*[;|\n]\s*|\s+or\s+|\s*\/\s*|\s+&\s+)/i;

/**
 * "Cardiff, London or Remote (UK)" → ["Cardiff", "London", "Remote (UK)", "Cardiff, London"]
 *
 * An ATS posting routinely lists SEVERAL locations in one free-text string. If we
 * collapse that to a single location, a Cardiff user and a London user can't both
 * match the same job — one of them silently never sees it. So we split, and the
 * geo layer takes the best match.
 *
 * The comma is the dangerous one (see PLACE_QUALIFIERS). When we do take the risk
 * and split on it, we ALSO keep the un-split original as a candidate, because the
 * geo layer is tolerant and scores the best match rather than the first.
 */
export function splitLocationCandidates(raw: string | null | undefined): string[] {
  if (!raw || !raw.trim()) return [];
  const out: string[] = [];

  for (const chunk of splitTopLevel(raw, HARD_SEPARATORS)) {
    const part = chunk.trim().replace(/^[-–,\s]+|[-–,\s]+$/g, "");
    if (!part) continue;

    const commaSegs = part.split(",").map((s) => s.trim()).filter(Boolean);
    const tailIsQualifier = commaSegs.slice(1).every(isQualifier);

    if (commaSegs.length > 1 && !tailIsQualifier) {
      // Both sides look like real places ("Cardiff, London") → treat as several,
      // but keep the original too in case we misread it.
      out.push(...commaSegs, part);
    } else {
      out.push(part);
    }
  }

  const seen = new Set<string>();
  const unique: string[] = [];
  for (const c of out) {
    const k = c.toLowerCase();
    if (c.length < 2 || seen.has(k)) continue;
    seen.add(k);
    unique.push(c);
  }
  // A posting listing 20 offices is a global req, not 20 real options. Cap it.
  return unique.slice(0, 12);
}

/** Merge several provider location fields into one deduped candidate list. */
export function mergeCandidates(...groups: (string | null | undefined)[][]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const g of groups) {
    for (const raw of g) {
      for (const c of splitLocationCandidates(raw)) {
        const k = c.toLowerCase();
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(c);
      }
    }
  }
  return out.slice(0, 12);
}

// ---------------------------------------------------------------------------
// Ids + tokens
// ---------------------------------------------------------------------------

/**
 * THE COLLISION TRAP.
 *
 * A provider's job id is unique only WITHIN a board. Greenhouse job `4567` exists
 * on Monzo's board AND on Stripe's. `job_postings` has UNIQUE(source, source_id),
 * so storing the bare id means the second company's job silently OVERWRITES the
 * first's — same source, same id — and an employer's roles vanish with no error
 * anywhere. Always prefix with the board token.
 */
export function sourceId(token: string, id: string | number): string {
  return `${token}:${String(id)}`;
}

/**
 * Board tokens are almost always the slugified company name, so a direct probe
 * resolves most companies for free — no crawl, no LLM. Emit the plausible slug
 * shapes, best guess first; discovery probes them in order and stops on a hit.
 */
export function slugCandidates(companyName: string): string[] {
  const base = companyName
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip accents: "Grünenthal" → "grunenthal"
    // Drop legal suffixes — no board is ever "monzo-bank-plc".
    .replace(/\b(ltd|limited|plc|llp|inc|incorporated|corp|corporation|gmbh|llc|group|holdings)\b/g, " ")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  if (!base) return [];

  const words = base.split(/\s+/);
  const joined = words.join("");
  const hyphen = words.join("-");
  const underscore = words.join("_");
  const firstWord = words[0];

  const out = [joined, hyphen, underscore, firstWord];
  const seen = new Set<string>();
  return out.filter((t) => t && !seen.has(t) && (seen.add(t), true));
}

/** Pull `{token}` out of a URL path shaped like `host/prefix/{token}`. */
export function pathSegments(url: string): { host: string; segs: string[] } | null {
  try {
    const u = new URL(url.trim());
    return {
      host: u.hostname.toLowerCase(),
      segs: u.pathname.split("/").map((s) => decodeURIComponent(s)).filter(Boolean),
    };
  } catch {
    return null;
  }
}

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
