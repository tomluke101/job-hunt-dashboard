// NHS Jobs — the NHS Business Services Authority's national first-party portal for
// the whole of NHS + social-care recruitment (jobs.nhs.uk).
//
// WHY THIS IS A PORTAL (the Teaching Vacancies pattern), NOT a per-employer board
// -----------------------------------------------------------------------------
// SEARCH_QUALITY_BASELINE #6: first-party corpus depth for CARE / NURSING / HEALTH
// was ~0. NHS trusts, GP practices, hospices, councils and CQC-registered care
// providers don't post on Greenhouse/Lever/Workday and don't embed schema.org
// JSON-LD on their own sites — they post on NHS Jobs, the single national portal
// the DHSC runs for the sector. One endpoint carries thousands of DISTINCT
// employers' own vacancies. It is a portal, exactly like DfE Teaching Vacancies
// (see teaching-vacancies.ts), so it cannot ride the jsonld reader (that refuses
// a page showing more than one hiringOrganization). But it is still FIRST-PARTY,
// and — crucially — zero-recruiter BY CONSTRUCTION: only a real NHS/social-care
// employer with an approved NHS Jobs employer account can list a vacancy. An
// agency cannot pose as an NHS trust, because the portal itself gatekeeps who may
// post. So the moat's zero-recruiter guarantee holds here through the PORTAL's
// gatekeeping instead of our single-org check — which is why nhs_jobs belongs in
// ATS_SOURCES (first-party) exactly like an employer's own board.
//
// WHY WE READ THE CANDIDATE HTML, NOT "the NHS Jobs API"
// -----------------------------------------------------
// NHS Jobs DOES have a machine API — but it is the employer/self-serve
// integration API (jobs.nhs.uk/api/...), which is 403 bot-walled AND requires an
// employer code + eligibility approval to use. That is a dead end for reading the
// public board. The CANDIDATE-FACING site, however, is public, server-rendered,
// and NOT bot-walled: GET /candidate/search/results returns real HTML with one
// card per vacancy, and every card carries the fields we need as stable
// `data-test="..."` hooks (title, employer, location+postcode, salary, posted /
// closing dates, contract type, working pattern). So we read the board the way a
// candidate does — no employer code, no credentials, no scraped API. NO per-job
// detail fetch is needed: everything but the JD body is on the results card, so
// one GET per 10 vacancies pulls the whole board (title-classifiable roles —
// "Staff Nurse", "Healthcare Assistant" — don't need the JD to be placed well).
//
// THE DATA
// --------
//   GET https://www.jobs.nhs.uk/candidate/search/results?sort=publicationDateDesc&page=N
//   • keyless, public, ~10 cards/page. "<N> jobs found" on the page is the
//     authoritative corpus size (~13k live UK vacancies at time of writing).
//   • sort=publicationDateDesc = freshest first, so a pull capped by budget/jobCap
//     captures the NEWEST supply — the slice a 14-day freshness window keeps.
//   • all UK, so is_foreign never fires; we still hand geo country_hint:"GB" as
//     belt-and-braces against town-name collisions ("Boston" is Boston, Lincs).
//   • we deliberately DON'T pass a location filter: the portal 302s a free-text
//     location to /candidate/search/too-many-locations (it wants a resolved id),
//     and — like every ATS source — we filter location OURSELVES downstream off
//     location_raw. So we pull the whole board and let lib/geo place each row.
//
// ⚠️ ROBOTS. We read the SAME public listing pages a candidate's browser does, at
// a polite rate, with an identifying UA. Before crawling we fetch robots.txt and
// REFUSE if it disallows /candidate/search — the same courtesy the jsonld reader
// pays every employer site. (Today jobs.nhs.uk serves no parseable robots rules.)
//
// This adapter maps each results card → RawJob. Everything downstream — geocode,
// dedupe, salary parse, classify, canonical key, upsert — is the identical
// hardened path ingest.ts runs for every other board. Nothing on the write side
// is new.

import type { AtsBoard, AtsProbeResult, AtsPullResult, EmploymentType } from "../types";
import type { RawJob } from "@/lib/job-search/types";
import { htmlToText } from "@/lib/job-search/html-to-text";
import {
  type AtsProviderImpl,
  type AtsPullOptions,
  budgetDeadline,
  canonEmploymentType,
  errMsg,
  jobCap,
  joinJd,
  mergeCandidates,
  safeIso,
} from "./_util";

/** The candidate-facing listing endpoint. token = this URL (a portal has one address). */
export const NHS_JOBS_SEARCH = "https://www.jobs.nhs.uk/candidate/search/results";

/**
 * Page ceiling — a backstop, not the stop condition. We page until the
 * authoritative "<N> jobs found" total is covered or a card-less page is hit,
 * whichever comes first; the per-pull jobCap and budget bound it well before
 * this. 2500 pages is ~25k vacancies of headroom (the board is ~1,335 pages
 * today). We deliberately do NOT stop on a short page: the real page size is 10,
 * but relying on it would silently truncate supply the day the portal changed it.
 */
const MAX_PAGES = 2500;
const PAGE_SIZE = 10;

/** Politeness between page fetches against a single government host. */
const POLITE_DELAY_MS = 250;

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/122 Safari/537.36 HuntHQ/1.0 (+https://hunthq.app)";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// HTTP (text — this provider reads HTML)
// ---------------------------------------------------------------------------

async function httpText(
  url: string,
  timeoutMs = 20_000
): Promise<{ status: number; text: string } | null> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "follow",
      headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml" },
      cache: "no-store",
    });
    return { status: res.status, text: await res.text() };
  } catch {
    return null;
  }
}

/**
 * robots.txt courtesy. Returns true unless a `*` (or hunthq) group Disallows a
 * path that prefixes /candidate/search. jobs.nhs.uk currently serves no parseable
 * robots.txt (its apex returns an HTML placeholder), so this allows — but the day
 * they add a rule, we stop on our own.
 */
async function crawlAllowed(): Promise<boolean> {
  const res = await httpText("https://www.jobs.nhs.uk/robots.txt", 8_000);
  if (!res || res.status !== 200) return true; // no robots ⇒ allowed (polite default)
  let applies = false;
  for (const line of res.text.split(/\r?\n/)) {
    const ua = line.match(/^\s*user-agent:\s*(.+?)\s*$/i);
    if (ua) {
      const agent = ua[1].toLowerCase();
      applies = agent === "*" || agent.includes("hunthq");
      continue;
    }
    if (!applies) continue;
    const dis = line.match(/^\s*disallow:\s*(\S+)\s*$/i);
    if (dis && "/candidate/search".startsWith(dis[1])) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Card parsing
// ---------------------------------------------------------------------------

/** Strip tags + decode entities to clean single-line text. */
function text(html: string): string {
  return htmlToText(html).replace(/\s+/g, " ").trim();
}

/**
 * The HTML region that begins just INSIDE the element carrying `data-test="<name>"`
 * — i.e. AFTER that opening tag's own `>` — and runs to the next `data-test="`
 * marker (fields render in DOM order, each is short) or a 600-char window. We start
 * after the opening tag so the bare `data-test="…">` attribute text cannot leak in
 * as text, and we drop any trailing half-open tag (`<li class=…` of the NEXT field)
 * that the cut left dangling — htmlToText only strips COMPLETE `<…>` tags.
 */
function regionAfter(card: string, name: string): string | null {
  const marker = `data-test="${name}"`;
  const at = card.indexOf(marker);
  if (at < 0) return null;
  const gt = card.indexOf(">", at + marker.length);
  const start = gt >= 0 ? gt + 1 : at + marker.length;
  const rest = card.slice(start);
  const next = rest.indexOf('data-test="');
  return (next >= 0 ? rest.slice(0, next) : rest.slice(0, 600)).replace(/<[^>]*$/, "");
}

/** Clean text of a data-test field, with its leading "Label:" prefix removed. */
function field(card: string, name: string): string | null {
  const region = regionAfter(card, name);
  if (region === null) return null;
  const t = text(region).replace(/^[^:]{0,24}:\s*/, ""); // drop a short "Label:" prefix
  return t || null;
}

/** "8 July 2026" / "Date posted: 8 July 2026" → ISO, or null. */
function nhsDate(raw: string | null): string | null {
  if (!raw) return null;
  const m = raw.match(/(\d{1,2}\s+[A-Za-z]+\s+\d{4})/);
  return safeIso(m ? m[1] : raw);
}

/**
 * NHS ships TWO orthogonal fields where our single EmploymentType enum has one
 * slot: "Contract type" (permanence — Permanent / Fixed-term / Bank / Apprenticeship)
 * and "Working pattern" (Full time / Part time / Job share …). We map from the
 * employer's OWN fields (never the title — see _util canonEmploymentType), taking
 * the permanence signal when it is temporary/apprenticeship, else the hours
 * signal. When a role lists BOTH full and part time we return null rather than
 * pick one — a wrong hint HIDES the role from the other filter (the _util rule).
 */
function nhsEmploymentType(contractType: string | null, workingPattern: string | null): EmploymentType | null {
  const c = (contractType ?? "").toLowerCase();
  if (/apprentice/.test(c)) return "apprenticeship";
  if (/fixed.?term|secondment|training|temporary|locum/.test(c)) return "temporary";
  if (/bank|voluntary|honorary/.test(c)) return "temporary"; // as-and-when, not a standing post
  const w = (workingPattern ?? "").toLowerCase();
  const hasPart = /part.?time|job.?share|term.?time/.test(w);
  const hasFull = /full.?time/.test(w);
  if (hasPart && hasFull) return null; // ambiguous — don't hide from either filter
  if (hasPart) return "part_time";
  if (hasFull) return "full_time";
  return canonEmploymentType(contractType); // Permanent → full_time
}

interface ParsedCard {
  ref: string;
  title: string;
}

/** ref + title from a card, or null if the card has no advert link/title. */
function refAndTitle(card: string): ParsedCard | null {
  const m = card.match(
    /href="\/candidate\/jobadvert\/([A-Za-z0-9-]+)[^"]*"[^>]*data-test="search-result-job-title"[^>]*>([\s\S]*?)<\/a>/i
  );
  if (!m) return null;
  const ref = m[1].trim();
  const title = text(m[2]);
  if (!ref || !title) return null;
  return { ref, title };
}

/**
 * The location block holds BOTH the employer (in the <h3>) and the place (in a
 * nested <div class="location-font-size">). Text-converting the whole block would
 * MERGE them ("North Cumbria …Trust Carlisle CA1 3TP"), so we pull the inner
 * place div out first, then read the employer from what remains.
 */
function employerAndLocation(card: string): { employer: string; locationRaw: string | null } {
  const region = regionAfter(card, "search-result-location");
  if (region === null) return { employer: "", locationRaw: null };
  const locDiv = region.match(/<div[^>]*location-font-size[^>]*>([\s\S]*?)<\/div>/i);
  const locationRaw = locDiv ? text(locDiv[1]) || null : null;
  const employer = text(locDiv ? region.replace(locDiv[0], " ") : region);
  return { employer, locationRaw };
}

/** One results card → RawJob, or null if it is too broken to place. */
function cardToRawJob(card: string): RawJob | null {
  const rt = refAndTitle(card);
  if (!rt) return null;
  const { ref, title } = rt;

  const raw = employerAndLocation(card);
  const employer = raw.employer;
  // NHS glues town + postcode into ONE string with a SPACE ("Sheffield S35 0JW"),
  // whereas Teaching Vacancies supplies them as separate fields joined by a COMMA
  // ("Luton, LU4 9FJ"). lib/geo resolves off location_candidates, and a bare town
  // ("Sheffield") hits the gazetteer while "Sheffield S35 0JW" does not — so we
  // split the UK postcode off here and hand the town and the postcode as SEPARATE
  // candidates (town → gazetteer, postcode → postcodes.io), exactly as TV does.
  const pcMatch = raw.locationRaw?.match(/\b([A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2})\b/i) ?? null;
  const postcode = pcMatch ? pcMatch[1].replace(/\s+/g, " ").toUpperCase() : null;
  const locality = raw.locationRaw
    ? raw.locationRaw.replace(pcMatch?.[0] ?? " ", "").replace(/^[,\s]+|[,\s]+$/g, "").trim() || null
    : null;
  const locationRaw = [locality, postcode].filter(Boolean).join(", ") || raw.locationRaw || null;
  const candidates = mergeCandidates([postcode], [locality]);
  const salary = field(card, "search-result-salary");
  const posted = field(card, "search-result-publicationDate");
  const closing = field(card, "search-result-closingDate");
  const contractType = field(card, "search-result-jobType");
  const workingPattern = field(card, "search-result-workingPattern");

  // A stable, canonical URL (drop the tracking query the card link carries).
  const url = `https://www.jobs.nhs.uk/candidate/jobadvert/${ref}`;

  // No JD body on the card, so synthesise a compact one from the structured
  // fields. Prepend the stated pay as text so the shared salary parser (which
  // rounds — SEARCH_QUALITY_BASELINE #1) can read it; we emit NO structured
  // salary_min/max ourselves (a fractional figure in an integer column is exactly
  // the crash defect #1 was — better a parsed-or-null number from one chokepoint).
  const jd = joinJd([
    salary ? `Salary: ${salary}` : null,
    employer ? `Employer: ${employer}` : null,
    contractType ? `Contract type: ${contractType}` : null,
    workingPattern ? `Working pattern: ${workingPattern}` : null,
  ]);

  return {
    source: "nhs_jobs",
    source_id: `nhs:${ref}`,
    source_url: url,
    company: employer,
    title,
    location_raw: locationRaw,
    jd_text: jd,
    jd_html: null,
    posted_at: nhsDate(posted),
    expires_at: nhsDate(closing),
    salary_min: null,
    salary_max: null,
    salary_currency: "GBP",
    department: null,
    employment_type: nhsEmploymentType(contractType, workingPattern),
    seniority_hint: null, // NHS bands aren't on the card; the classifier derives seniority.
    job_function: null,
    is_remote: null, // NHS/care roles are on-site; never assert remote.
    location_candidates: candidates.length ? candidates : undefined,
    country_hint: "GB", // all NHS Jobs supply is UK — reinforces geo, blocks collisions.
    lat: null,
    lng: null,
    raw: { ref, title, employer, locationRaw, salary, posted, closing, contractType, workingPattern },
  };
}

/** "13,341 jobs found" → 13341, or null. */
function totalFound(html: string): number | null {
  const m = html.match(/([\d,]+)\s+jobs?\s+found/i);
  if (!m) return null;
  const n = parseInt(m[1].replace(/,/g, ""), 10);
  return Number.isFinite(n) ? n : null;
}

/** Split a results page into per-card HTML fragments (one per vacancy). */
function cards(html: string): string[] {
  // The card <li> is the ONLY element whose data-test is exactly "search-result"
  // (the field hooks are "search-result-title", "-salary", … — none of which the
  // quote-terminated marker below matches). So splitting here yields one fragment
  // per card, each running to the start of the next card.
  return html.split('data-test="search-result"').slice(1);
}

function pageUrl(token: string, page: number): string {
  const u = new URL(token);
  u.searchParams.set("sort", "publicationDateDesc");
  u.searchParams.set("page", String(page));
  return u.toString();
}

export const nhsJobsProvider: AtsProviderImpl = {
  id: "nhs_jobs",

  async listJobs(board: AtsBoard, opts?: AtsPullOptions): Promise<AtsPullResult> {
    const token = board.token || NHS_JOBS_SEARCH;
    const deadline = budgetDeadline(opts);
    const cap = jobCap(opts);

    if (!(await crawlAllowed())) {
      return { jobs: [], error: "nhs_jobs: robots.txt disallows /candidate/search — refusing to crawl" };
    }

    const jobs: RawJob[] = [];
    const seenIds = new Set<string>();
    let enumeratedCards = 0;
    let truncated = false;
    let softError: string | null = null;
    let total: number | null = null;
    let totalPages = MAX_PAGES; // narrowed once we read the "<N> jobs found" total.

    let page = 1;
    for (; page <= MAX_PAGES && page <= totalPages; page++) {
      if (jobs.length >= cap) {
        truncated = page <= totalPages;
        break;
      }
      if (Date.now() > deadline) {
        truncated = true;
        softError = `budget exhausted at page ${page} of ${totalPages}`;
        break;
      }

      const res = await httpText(pageUrl(token, page));
      if (!res || res.status !== 200) {
        // Page 1 failing = the source is down; report it as an error (no jobs).
        // A LATER page failing after we already have jobs = a partial pull: keep
        // what we have but flag it loudly rather than silently serving a slice.
        if (page === 1) {
          return { jobs: [], error: `nhs_jobs page 1: ${res ? `HTTP ${res.status}` : "network error"}` };
        }
        truncated = true;
        softError = `stopped at page ${page}: ${res ? `HTTP ${res.status}` : "network error"}`;
        break;
      }

      if (total === null) {
        total = totalFound(res.text);
        if (total !== null) {
          const tp = Math.ceil(total / PAGE_SIZE);
          if (tp > 0 && tp < MAX_PAGES) totalPages = tp;
        }
      }

      const frags = cards(res.text);
      if (frags.length === 0) break; // walked off the end (or a card-less page)
      enumeratedCards += frags.length;
      for (const frag of frags) {
        const rj = cardToRawJob(frag);
        if (rj && !seenIds.has(rj.source_id)) {
          seenIds.add(rj.source_id);
          jobs.push(rj);
        }
      }
      await sleep(POLITE_DELAY_MS);
    }

    if (page > MAX_PAGES && totalPages > MAX_PAGES) truncated = true;

    // Cards enumerated but parsed 0 = the markup moved under us. Returning [] here
    // would be the Adzuna failure mode: a dead source indistinguishable from an
    // empty market. Say it out loud instead.
    if (enumeratedCards > 0 && jobs.length === 0) {
      return {
        jobs: [],
        error: `nhs_jobs: enumerated ${enumeratedCards} cards but parsed 0 — results markup changed?`,
      };
    }

    return {
      jobs,
      boardCompanyName: null, // a portal has no single company — and it is never discovered by name.
      truncated,
      ...(softError ? { error: softError } : {}),
    };
  },

  async probe(board: AtsBoard): Promise<AtsProbeResult> {
    try {
      const res = await httpText(pageUrl(board.token || NHS_JOBS_SEARCH, 1));
      if (!res || res.status !== 200) {
        return { exists: false, jobCount: 0, error: res ? `HTTP ${res.status}` : "network error" };
      }
      const frags = cards(res.text);
      // A portal always exists; jobCount is this first page's card count (liveness).
      // If the page has cards we can't parse, that is a real fault — surface it.
      const parsed = frags.map(cardToRawJob).filter(Boolean).length;
      if (frags.length > 0 && parsed === 0) {
        return { exists: false, jobCount: 0, error: "nhs_jobs: page 1 has cards but none parsed — markup changed?" };
      }
      return { exists: true, jobCount: totalFound(res.text) ?? parsed, boardCompanyName: null };
    } catch (e) {
      return { exists: false, jobCount: 0, error: errMsg(e) };
    }
  },

  detect(url: string): AtsBoard | null {
    try {
      const u = new URL(url.trim());
      if (
        u.hostname.toLowerCase().endsWith("jobs.nhs.uk") &&
        /\/candidate\/(jobadvert|search)/i.test(u.pathname)
      ) {
        return { provider: "nhs_jobs", token: NHS_JOBS_SEARCH };
      }
    } catch {
      /* not a URL */
    }
    return null;
  },

  // A fixed national portal is NEVER discovered by guessing a company slug — it is
  // seeded once (scripts/seed-nhs-jobs.ts). Returning [] keeps discovery from ever
  // fabricating a bogus nhs_jobs board for some company name.
  candidateTokens(): string[] {
    return [];
  },
};
