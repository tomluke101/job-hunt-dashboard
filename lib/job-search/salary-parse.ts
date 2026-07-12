// Parse a GBP salary out of JD text.
//
// WHY
// ---
// ATS boards almost never ship a structured salary — UK employers write
// "£45,000 - £55,000 per annum" in the JD body and leave the API field null.
// Reed and Adzuna DO ship a structured figure. So without this parser, ingesting
// ATS-direct actively hurts the user:
//   • scoreQuality() docks a job 6 points for "salary hidden"
//   • salaryFitScore() gives it 40/100 instead of up to 100
//   • the `drop_hidden_salary` filter DELETES it outright
// i.e. our best, freshest, recruiter-free, first-party jobs would rank BELOW
// recruiter spam that happened to tick a salary box. The moat would bury itself.
//
// THE BAR: WRONG DATA IS WORSE THAN NONE
// --------------------------------------
// The same principle that governs the company-size bands. A JD is full of money
// that is NOT the salary: "£1,000 signing bonus", "we raised £10 million",
// "manage a £2m budget", "£50 monthly wellness allowance". Mis-reading any of
// those as the salary poisons the salary filter AND the ranking.
//
// So: only accept a figure that is BOTH in a plausible salary band AND carries
// positive salary context ("per annum", "salary", "package", "£45k")— and reject
// it outright if a disqualifying word ("bonus", "budget", "revenue", "funding")
// sits closer to it than the salary word does.

export type SalaryPeriod = "year" | "day" | "hour";

export interface ParsedSalary {
  /** Annual GBP. Null for day/hour rates — see the note on `period`. */
  min: number | null;
  max: number | null;
  currency: "GBP";
  period: SalaryPeriod;
  /** The substring we matched, so a human can audit any figure we show. */
  matched: string;
  confidence: "high" | "medium";
}

/**
 * Plausible ANNUAL UK salary band. Below £8k is part-time pro-rata at best and
 * far more likely a bonus or an allowance; above £2m is not a salary line.
 */
const MIN_ANNUAL = 8_000;
const MAX_ANNUAL = 2_000_000;

const SALARY_CONTEXT =
  /\b(salary|salaried|compensation|remuneration|package|per\s*annum|p\.?a\.?\b|annually|yearly|basic|base\s*pay|base\s*salary|pay\s*range|paying|offering|circa|up\s*to|ote)\b/i;

/**
 * Money that is definitely NOT the salary. If one of these is nearer to the
 * figure than any salary word, the figure is rejected. This is what stops
 * "£1,000 welcome bonus" and "a £2m budget" becoming someone's expected pay.
 */
const DISQUALIFIER =
  /\b(bonus|budget|revenue|turnover|funding|raised|valuation|investment|allowance|voucher|discount|fee|donation|grant|savings|contract\s*value|portfolio|assets|loan|fine|award)\b/i;

/** "£45,000" | "£45k" | "£45,000.00" → pounds as a number. */
function toNumber(raw: string): number | null {
  const m = raw.match(/([\d,]+(?:\.\d+)?)\s*(k)?/i);
  if (!m) return null;
  const n = parseFloat(m[1].replace(/,/g, ""));
  if (!Number.isFinite(n)) return null;
  return m[2] ? Math.round(n * 1000) : Math.round(n);
}

/** Nearest-word-wins context test around a match. */
function contextVerdict(text: string, index: number, length: number): "salary" | "reject" | "none" {
  const WINDOW = 60;
  const before = text.slice(Math.max(0, index - WINDOW), index);
  const after = text.slice(index + length, index + length + WINDOW);
  const hay = `${before} ${after}`;

  const salaryHit = SALARY_CONTEXT.exec(hay);
  const badHit = DISQUALIFIER.exec(hay);

  if (badHit && !salaryHit) return "reject";
  if (!badHit && salaryHit) return "salary";
  if (!badHit && !salaryHit) return "none";

  // Both present — whichever sits CLOSER to the figure wins. "£45,000 per annum
  // plus a £5,000 bonus" must keep the 45k and reject the 5k, and only distance
  // separates them.
  const salaryDist = distanceToFigure(before, after, salaryHit!);
  const badDist = distanceToFigure(before, after, badHit!);
  return salaryDist <= badDist ? "salary" : "reject";
}

function distanceToFigure(before: string, after: string, hit: RegExpExecArray): number {
  // `hay` was built as `${before} ${after}`, so an index inside `before` is that
  // many chars to the LEFT of the figure; anything past it is to the RIGHT.
  const i = hit.index;
  if (i < before.length) return before.length - i;
  return i - before.length;
}

const RANGE_RE =
  /£\s*([\d,]+(?:\.\d+)?\s*k?)\s*(?:-|–|—|to|up\s*to)\s*£?\s*([\d,]+(?:\.\d+)?\s*k?)/gi;
const SINGLE_RE = /£\s*([\d,]+(?:\.\d+)?\s*k?)/gi;
const PER_HOUR = /\b(per\s*hour|an\s*hour|hourly|p\/?h\b|\/\s*hour|\/hr\b)/i;
const PER_DAY = /\b(per\s*day|a\s*day|daily|day\s*rate|p\/?d\b|\/\s*day)/i;

function periodAt(text: string, index: number, length: number): SalaryPeriod {
  const after = text.slice(index + length, index + length + 30);
  const before = text.slice(Math.max(0, index - 30), index);
  const hay = `${before} ${after}`;
  if (PER_HOUR.test(hay)) return "hour";
  if (PER_DAY.test(hay)) return "day";
  return "year";
}

/**
 * Best-effort GBP salary from free text. Returns null when nothing clears the bar.
 *
 * Day and hour rates are REPORTED (period: "day"|"hour") but deliberately NOT
 * annualised into min/max. Annualising a day rate means inventing an assumption
 * about billable days that would then be filtered and ranked as if it were fact.
 * The caller still learns a rate was quoted — enough to stop `drop_hidden_salary`
 * binning a job that plainly states "£350 per day" — without us fabricating a
 * number the employer never wrote.
 */
export function parseSalaryFromText(text: string | null | undefined): ParsedSalary | null {
  if (!text) return null;
  // Only look at the first slice: the salary is stated up front, while the tail
  // is benefits boilerplate ("£500 learning budget") that only produces noise.
  const hay = text.slice(0, 4000);

  // --- ranges first: highest-confidence shape -----------------------------
  RANGE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = RANGE_RE.exec(hay)) !== null) {
    if (contextVerdict(hay, m.index, m[0].length) === "reject") continue;
    const lo = toNumber(m[1]);
    const hi = toNumber(m[2]);
    if (lo === null || hi === null) continue;
    const period = periodAt(hay, m.index, m[0].length);
    if (period !== "year") {
      return { min: null, max: null, currency: "GBP", period, matched: m[0].trim(), confidence: "high" };
    }
    if (lo < MIN_ANNUAL || hi > MAX_ANNUAL || hi < lo) continue;
    return {
      min: lo, max: hi, currency: "GBP", period: "year",
      matched: m[0].trim(), confidence: "high",
    };
  }

  // --- single figure: needs POSITIVE salary context, not merely the absence
  //     of a disqualifier. "£45,000" floating in a JD could be anything.
  SINGLE_RE.lastIndex = 0;
  while ((m = SINGLE_RE.exec(hay)) !== null) {
    const verdict = contextVerdict(hay, m.index, m[0].length);
    if (verdict === "reject") continue;

    const v = toNumber(m[1]);
    if (v === null) continue;
    const period = periodAt(hay, m.index, m[0].length);

    // An explicit RATE marker is itself the salary context. "£350 per day" needs no
    // corroborating word — nobody quotes a day rate about anything but pay. Requiring
    // a separate salary keyword here returned null for every contract role in the
    // corpus, which then tripped `drop_hidden_salary` and deleted them outright.
    if (period !== "year") {
      return { min: null, max: null, currency: "GBP", period, matched: m[0].trim(), confidence: "medium" };
    }

    // An ANNUAL figure still needs a positive salary word. A bare "£45,000" in a JD
    // could be a budget, a target, a grant — anything.
    if (verdict !== "salary") continue;
    if (v < MIN_ANNUAL || v > MAX_ANNUAL) continue;

    // "up to £60,000" is a CEILING, not a floor. Reading it as a floor would let
    // a £60k-ceiling job satisfy a "£60k minimum" filter it doesn't actually meet.
    const before = hay.slice(Math.max(0, m.index - 20), m.index);
    if (/\bup\s*to\s*$/i.test(before)) {
      return { min: null, max: v, currency: "GBP", period: "year", matched: m[0].trim(), confidence: "medium" };
    }
    return { min: v, max: v, currency: "GBP", period: "year", matched: m[0].trim(), confidence: "medium" };
  }

  return null;
}
