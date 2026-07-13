// Job type / seniority / job function — the three filter dimensions.
//
// WHY THIS FILE EXISTS (the premise it was built on turned out to be false)
// ------------------------------------------------------------------------
// The plan said these three filters were free: the ATS captures employment_type,
// seniority_hint and job_function at ingest, so the filters would just read them.
// Measured against the real corpus (1,443 ATS + 184 aggregator jobs):
//
//                     ATS      aggregator
//   employment_type   55%          0%
//   seniority_hint    21%          0%
//   job_function      49%          0%     ← and 177 DISTINCT values
//
// Two things kill the "just read the column" plan:
//
//  1. AGGREGATORS SUPPLY NOTHING. Reed and Adzuna are 0% on all three. A filter
//     that excludes unknowns would silently delete every Reed and Adzuna job the
//     moment a user touches it — the same silent-drop shape as the title-filter bug
//     that binned every "Supply Chain Analyst" for a fortnight.
//
//  2. `job_function` IS NOT A TAXONOMY. It is whatever the employer named their
//     internal team: "SMB Hub", "Dev", "Echo", "Somnia", "MIL", "DFW UKI",
//     "Debt Finance Director - Real Estate", "Commercial " (trailing space), and
//     "Other" (90 jobs). You cannot put a dropdown on that. The raw string is a
//     SIGNAL, not an answer.
//
// So every job gets CLASSIFIED, from signals we always have (title, JD) plus the
// provider's structured field as a high-confidence prior when it exists. The raw
// employer department is retained separately in `department` — we derive from it,
// we never filter on it.
//
// PRECISION OVER RECALL. Every classifier may return null. A job with no seniority
// marker genuinely has no stated seniority, and saying "mid" because we had to say
// something is worse than admitting we don't know — the user filters on this and
// trusts it. `null` is a real answer, and the UI's include-unknown toggle is what
// makes null safe.

import type { RawJob } from "./types";

export const JOB_TYPES = [
  "full_time",
  "part_time",
  "contract",
  "temporary",
  "internship",
  "apprenticeship",
] as const;
export type JobType = (typeof JOB_TYPES)[number];

export const SENIORITIES = [
  "intern",
  "entry",
  "junior",
  "mid",
  "senior",
  "lead",
  "principal",
  "director",
  "executive",
] as const;
export type Seniority = (typeof SENIORITIES)[number];

/**
 * The canonical function taxonomy. Deliberately BROAD and non-tech-skewed: the
 * corpus is Primark, Sodexo, John Lewis and AstraZeneca as much as it is Stripe,
 * and a taxonomy that offers "Engineering / Product / Design / Data" and nothing
 * else tells a warehouse supervisor this product isn't for them.
 */
export const JOB_FUNCTIONS = [
  "Engineering",
  "Data & Analytics",
  "IT & Infrastructure",
  "Product",
  "Design",
  "Sales",
  "Marketing",
  "Customer Support",
  "Finance & Accounting",
  "Legal & Compliance",
  "HR & People",
  "Operations",
  "Supply Chain & Logistics",
  "Manufacturing & Engineering Trades",
  "Construction & Property",
  "Retail & Hospitality",
  "Healthcare & Life Sciences",
  "Science & Research",
  "Education & Training",
  "Consulting & Strategy",
  "Admin & Business Support",
] as const;
export type JobFunction = (typeof JOB_FUNCTIONS)[number];

export interface Classification {
  employment_type: JobType | null;
  seniority: Seniority | null;
  job_function: JobFunction | null;
}

/** Display labels. JOB_FUNCTIONS are already written for the eye. */
export const JOB_TYPE_LABELS: Record<JobType, string> = {
  full_time: "Full-time",
  part_time: "Part-time",
  contract: "Contract",
  temporary: "Temporary",
  internship: "Internship",
  apprenticeship: "Apprenticeship",
};

export const SENIORITY_LABELS: Record<Seniority, string> = {
  intern: "Intern",
  entry: "Entry / Graduate",
  junior: "Junior",
  mid: "Mid",
  senior: "Senior",
  lead: "Lead",
  principal: "Principal",
  director: "Director / Head of",
  executive: "Executive / C-suite",
};

const norm = (s: string | null | undefined) => (s ?? "").toLowerCase().replace(/\s+/g, " ").trim();
const has = (hay: string, re: RegExp) => re.test(hay);

// ---------------------------------------------------------------------------
// Job type
// ---------------------------------------------------------------------------

/**
 * A provider's own value, mapped onto our set. Covers the vocabularies of every
 * ATS we ingest plus Adzuna's contract_time / contract_type.
 */
export function canonJobType(raw: string | null | undefined): JobType | null {
  const s = norm(raw).replace(/[_-]/g, " ");
  if (!s) return null;
  if (/(^|\b)(intern|internship|placement|industrial placement)(\b|$)/.test(s)) return "internship";
  if (/apprentice/.test(s)) return "apprenticeship";
  if (/(temp|temporary|seasonal|casual|bank staff)/.test(s)) return "temporary";
  if (/(contract|contractor|fixed term|fixed-term|ftc|freelance|interim|consultant basis)/.test(s)) return "contract";
  if (/part.?time/.test(s)) return "part_time";
  // "permanent" is a CONTRACT BASIS, not a number of hours — but every UK board
  // presents one merged list, and a permanent role with no stated hours is
  // overwhelmingly full-time. Mapping it to full_time matches what the user who
  // ticked "Full-time" is actually asking for.
  if (/(full.?time|permanent|regular)/.test(s)) return "full_time";
  return null;
}

/**
 * ⚠️ BASIS BEATS HOURS. "Part-time" and "Contract" are answers to DIFFERENT
 * questions (how many hours / on what basis), and a job can be both. UK job boards
 * — and Tom's spec — present one merged dropdown, so we must pick.
 *
 * A user who ticks "Contract" wants contracts, including part-time ones. A user who
 * ticks "Part-time" and is shown a 6-month FTC has been mis-sold. So the scarcer,
 * more decision-relevant signal (the basis) wins, and we only fall back to hours
 * when no basis is stated. This is a deliberate choice, not an accident of ordering.
 */
const TYPE_ORDER: JobType[] = [
  "apprenticeship",
  "internship",
  "temporary",
  "contract",
  "part_time",
  "full_time",
];

export function classifyJobType(title: string, jd: string, providerValue?: string | null): JobType | null {
  // 1. The provider said so. Highest confidence — it's a structured field.
  const fromProvider = canonJobType(providerValue);
  if (fromProvider) return fromProvider;

  const t = norm(title);
  const body = norm(jd).slice(0, 4000);

  const votes = new Set<JobType>();

  // 2. The title. UK employers put the basis in the title when it isn't permanent
  //    full-time, precisely because it's the exception.
  if (has(t, /\bapprentice(ship)?\b/)) votes.add("apprenticeship");
  if (has(t, /\b(intern|internship|placement|summer analyst|industrial placement)\b/)) votes.add("internship");
  if (has(t, /\b(temp|temporary|seasonal|casual|bank)\b/)) votes.add("temporary");
  if (has(t, /\b(contract|contractor|ftc|fixed[- ]term|interim|freelance)\b/)) votes.add("contract");
  if (has(t, /\bpart[- ]time\b|\bp\/t\b/)) votes.add("part_time");
  if (has(t, /\bfull[- ]time\b|\bf\/t\b|\bpermanent\b/)) votes.add("full_time");

  // 3. The JD body. Weaker — a permanent ad often *mentions* contractors — so only
  //    consulted when the title was silent.
  //
  //    This is the ONLY signal Reed ever gives us: its API returns no job-type field
  //    at all (it accepts fullTime/partTime/contract as REQUEST filters, but never
  //    reports them back), so a Reed job's type has to be read out of the prose or it
  //    stays unknown forever. UK ads state the basis in the body as a matter of
  //    course — "Permanent, full time" — so we look for the bare terms and not just
  //    the fully-qualified phrasings, which were too narrow to fire on real ads.
  if (votes.size === 0) {
    if (has(body, /\bapprenticeship\b/)) votes.add("apprenticeship");
    if (has(body, /\b(this is an internship|internship programme|placement year|internship)\b/))
      votes.add("internship");
    if (
      has(body, /\b(fixed[- ]term|\bftc\b|\d+ month contract|outside ir35|inside ir35|day rate|contract role|contract position|contract basis)\b/)
    )
      votes.add("contract");
    // NOT a bare /temporary/: a permanent job whose JD mentions "temporary cover"
    // would flip to temporary, and temporary OUTRANKS full_time in TYPE_ORDER — so
    // the greedy version silently mislabels permanent roles as temp.
    if (
      has(body, /\btemporary (role|position|contract|assignment|work|job|vacancy|basis)\b|\btemp to perm\b|\bseasonal (role|work|position|contract)\b/)
    )
      votes.add("temporary");
    if (has(body, /\bpart[- ]time\b|\b0\.[1-9] fte\b|\b(1[0-9]|2[0-9]|3[0-4]) hours per week\b/))
      votes.add("part_time");
    if (has(body, /\bfull[- ]time\b|\bpermanent\b|\b3[5-9](\.\d+)? hours per week\b/))
      votes.add("full_time");
  }

  for (const t2 of TYPE_ORDER) if (votes.has(t2)) return t2;
  return null;
}

// ---------------------------------------------------------------------------
// Seniority
// ---------------------------------------------------------------------------

/**
 * The traps. Every one of these is a title where the seniority WORD is not a
 * seniority — and each would misfile a job into a level the user explicitly asked
 * for, which is worse than leaving it unclassified.
 *
 *   "Lead Generation Executive"  — "lead" is the noun (sales leads), not the level.
 *                                   It is an ENTRY sales job. Also contains
 *                                   "executive", which is a UK synonym for
 *                                   "individual contributor", not for C-suite.
 *   "Art Director" / "Creative Director" / "Funeral Director"
 *                                — "director" is the craft, not the board.
 *   "Head Chef"                  — "head" is the kitchen, not the org chart.
 *   "Senior Living Coordinator"  — "senior" is the CLIENT (elderly), not the level.
 *
 * The "executive" trap is the biggest one in a UK corpus, because "Sales Executive"
 * and "Account Executive" are junior IC roles and there are thousands of them.
 * Reading them as C-suite would put graduate sales jobs in front of a user
 * filtering for executive roles.
 */
const SENIORITY_TRAPS: Array<[RegExp, Seniority | null]> = [
  [/\blead(s)? (generation|gen)\b/, null],
  [/\b(art|creative|funeral|casting|musical|music|photography|technical art) director\b/, null],
  [/\bhead (chef|waiter|waitress|porter|barista|groundsman|gardener)\b/, null],
  [/\bsenior (living|citizens?)\b/, null],
];

export function classifySeniority(
  title: string,
  jd: string,
  providerValue?: string | null
): Seniority | null {
  const t = norm(title);

  // A trap match is a REFUSAL, not a fallthrough: "Lead Generation Executive"
  // contains both "lead" and "executive", so letting it fall through to the normal
  // rules below would just pick the other wrong answer.
  for (const [re, verdict] of SENIORITY_TRAPS) {
    if (has(t, re)) return verdict;
  }

  // The provider's own hint, when it gave one and it maps cleanly.
  const p = norm(providerValue);
  if (p) {
    const direct = (SENIORITIES as readonly string[]).find((s) => s === p);
    if (direct) return direct as Seniority;
    if (/grad|entry|trainee/.test(p)) return "entry";
    if (/exec|c.level|chief/.test(p)) return "executive";
  }

  // Title markers, most senior first — a "Senior Principal Engineer" is principal.
  if (has(t, /\b(chief|ceo|cto|cfo|coo|cmo|ciso|cio)\b|\bc-suite\b|\b(vp|svp|evp)\b|\bvice president\b|\bpartner\b|\bmanaging director\b/))
    return "executive";
  if (has(t, /\bhead of\b|\bhead teacher\b|\bheadteacher\b|\bdirector\b|\bdirectorate\b/)) return "director";
  if (has(t, /\bprincipal\b|\bdistinguished\b|\bfellow\b/)) return "principal";
  if (has(t, /\blead\b|\bstaff\b|\bteam lead\b|\bsupervisor\b|\bforeman\b/)) return "lead";
  if (has(t, /\bsenior\b|\bsnr\b|\bsr\.?\b|\biii\b/)) return "senior";
  if (has(t, /\b(junior|jnr|jr\.?)\b|\bassociate\b/)) return "junior";
  if (has(t, /\b(graduate|grad scheme|trainee|entry.?level|apprentice)\b/)) return "entry";
  if (has(t, /\b(intern|internship|placement|summer analyst)\b/)) return "intern";

  // The JD's experience requirement, when the title said nothing. Only the clearly
  // separable bands — "3-5 years" is the classic mid signal and is unambiguous.
  const body = norm(jd).slice(0, 6000);
  const yrs = body.match(/(\d{1,2})\s*\+?\s*(?:-|to|–)?\s*(\d{1,2})?\s*years?(?:'| of)? experience/);
  if (yrs) {
    const low = parseInt(yrs[1], 10);
    if (!Number.isNaN(low)) {
      if (low >= 8) return "principal";
      if (low >= 5) return "senior";
      if (low >= 3) return "mid";
      if (low >= 1) return "junior";
      if (low === 0) return "entry";
    }
  }
  if (has(body, /\bno (prior )?experience (is )?(necessary|required)\b|\bgraduate (scheme|programme)\b/))
    return "entry";

  // Genuinely unstated. Say so — do not invent "mid".
  return null;
}

// ---------------------------------------------------------------------------
// Job function
// ---------------------------------------------------------------------------

/**
 * Title keywords → canonical function. ORDER MATTERS: the first match wins, so the
 * specific must precede the general. "Data Engineer" must be tested before
 * "Engineer", or every analyst in the corpus becomes Engineering.
 */
const FUNCTION_RULES: Array<[JobFunction, RegExp]> = [
  // --- specific-before-general ---
  ["Data & Analytics", /\b(data (scientist|engineer|analyst|architect)|analytics|machine learning|ml engineer|business intelligence|\bbi\b|statistician|data science|quantitative)\b/],
  ["Supply Chain & Logistics", /\b(supply chain|logistics|procurement|purchasing|buyer|sourcing|warehouse|inventory|demand planner|s&op|freight|shipping|fulfilment|fulfillment|category manager)\b/],
  ["IT & Infrastructure", /\b(it support|helpdesk|service desk|sysadmin|system administrator|network engineer|infrastructure engineer|devops|site reliability|\bsre\b|cloud engineer|platform engineer|it technician)\b/],
  ["Engineering", /\b(software|developer|engineer|programmer|full.?stack|front.?end|back.?end|mobile|ios|android|qa engineer|test engineer|architect)\b/],
  ["Product", /\b(product manager|product owner|product lead|head of product|product director|scrum master|delivery manager|business analyst)\b/],
  ["Design", /\b(designer|design|\bux\b|\bui\b|user experience|user research|creative|art director|graphic|brand designer)\b/],
  ["Science & Research", /\b(scientist|research|\br&d\b|laboratory|lab technician|chemist|biologist|clinical trial|bioinformatic)\b/],
  ["Healthcare & Life Sciences", /\b(nurse|nursing|doctor|physician|gp\b|clinician|clinical|healthcare|care (assistant|worker|home)|pharmacist|pharmacy|therapist|radiographer|paramedic|dental|midwife|support worker)\b/],
  ["Finance & Accounting", /\b(accountant|accounting|finance|financial|audit|auditor|tax|treasury|payroll|bookkeep|controller|fp&a|actuar|credit risk|underwrit|investment)\b/],
  ["Legal & Compliance", /\b(legal|lawyer|solicitor|paralegal|counsel|compliance|regulatory|governance|company secretar|barrister|conveyanc)\b/],
  ["HR & People", /\b(hr\b|human resources|people (team|partner|operations)|recruit|talent acquisition|talent partner|learning and development|l&d|reward|employee relations)\b/],
  ["Marketing", /\b(marketing|brand|content|seo|ppc|social media|communications|\bpr\b|public relations|copywriter|growth marketing|crm|campaign)\b/],
  ["Sales", /\b(sales|account executive|account manager|business development|\bbdr\b|\bsdr\b|partnerships|revenue|commercial manager|telesales|lead generation)\b/],
  ["Customer Support", /\b(customer (support|service|success|care|experience)|client services|help ?desk|contact centre|call centre|complaints)\b/],
  ["Consulting & Strategy", /\b(consultant|consulting|strategy|strategic|advisory|transformation|change manager)\b/],
  ["Education & Training", /\b(teacher|teaching|lecturer|tutor|professor|academic|trainer|training|education|school|nursery practitioner|teaching assistant)\b/],
  ["Construction & Property", /\b(construction|quantity surveyor|site manager|architect(ural)?|civil engineer|structural|surveyor|estate agent|property|facilities|building)\b/],
  ["Manufacturing & Engineering Trades", /\b(manufacturing|production (operative|manager|planner)|machine operator|maintenance (engineer|technician)|mechanical engineer|electrical engineer|technician|fitter|welder|cnc|assembly|plant)\b/],
  ["Retail & Hospitality", /\b(retail|store (manager|assistant)|shop|sales assistant|cashier|merchandis|chef|cook|waiter|waitress|barista|bartender|hotel|housekeep|hospitality|restaurant|kitchen)\b/],
  ["Operations", /\b(operations|ops\b|programme manager|project manager|process improvement|continuous improvement|lean|business operations|general manager)\b/],
  ["Admin & Business Support", /\b(administrator|administrative|admin\b|receptionist|secretary|executive assistant|personal assistant|\bpa\b|office manager|data entry|coordinator|clerk)\b/],
];

/**
 * The employer's own department string, mapped onto the taxonomy where it is
 * legible. This is a SECONDARY signal by design: 177 distinct values, of which
 * "Somnia", "Echo", "Delta", "MIL", "SMB Hub" and "Other" (90 jobs) mean nothing
 * outside that company. When the department is opaque, the title still speaks.
 */
function functionFromDepartment(dept: string | null | undefined): JobFunction | null {
  const d = norm(dept);
  if (!d || d === "other" || d === "general") return null;
  for (const [fn, re] of FUNCTION_RULES) {
    if (has(d, re)) return fn;
  }
  // Adzuna ships its own category taxonomy ("IT Jobs", "Accounting & Finance Jobs",
  // "Logistics & Warehouse Jobs") — legible, and free, and previously discarded.
  if (has(d, /\bit jobs|\bit\b|technology/)) return "IT & Infrastructure";
  if (has(d, /teaching|education/)) return "Education & Training";
  if (has(d, /trade|construction/)) return "Construction & Property";
  if (has(d, /social work|charity/)) return "Operations";
  return null;
}

export function classifyFunction(
  title: string,
  jd: string,
  department?: string | null
): JobFunction | null {
  const t = norm(title);
  // The TITLE leads. It is the one field every source supplies, it is what the
  // employer chose to advertise the role as, and it is the only signal that is
  // comparable across employers.
  for (const [fn, re] of FUNCTION_RULES) {
    if (has(t, re)) return fn;
  }
  // Then the employer's department, for titles the taxonomy doesn't reach
  // ("Somnia Delivery Partner" tells us nothing; its department may).
  const fromDept = functionFromDepartment(department);
  if (fromDept) return fromDept;

  // Last resort: the JD's opening, which usually names the team. Cheap, and only
  // reached for the small tail the title and department both missed.
  const body = norm(jd).slice(0, 600);
  for (const [fn, re] of FUNCTION_RULES) {
    if (has(body, re)) return fn;
  }
  return null;
}

// ---------------------------------------------------------------------------

/**
 * Classify a job from every signal available. Safe to call on any source: an ATS
 * job passes its structured fields through as priors, a Reed/Adzuna job (which has
 * none) is classified from title + JD alone. That symmetry is the point — without
 * it, any filter the user touches quietly deletes the entire aggregator half of the
 * corpus.
 */
export function classifyJob(job: {
  title: string;
  jd_text?: string | null;
  employment_type?: string | null;
  seniority_hint?: string | null;
  department?: string | null;
  job_function?: string | null;
}): Classification {
  const title = job.title ?? "";
  const jd = job.jd_text ?? "";
  // The ATS `job_function` column holds the employer's raw department string, which
  // is exactly what functionFromDepartment() wants — not a taxonomy value.
  const dept = job.department ?? job.job_function ?? null;

  return {
    employment_type: classifyJobType(title, jd, job.employment_type),
    seniority: classifySeniority(title, jd, job.seniority_hint),
    job_function: classifyFunction(title, jd, dept),
  };
}

/** Convenience for the ingest path, which works in RawJob. */
export function classifyRawJob(raw: RawJob): Classification {
  return classifyJob({
    title: raw.title,
    jd_text: raw.jd_text,
    employment_type: raw.employment_type,
    seniority_hint: raw.seniority_hint,
    department: raw.department,
    job_function: raw.job_function,
  });
}
