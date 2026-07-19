// Recruiter / agency detection.
//
// Two signals — either fires the flag:
//   1. Companies House SIC code in the "activities of employment placement
//      agencies" / "temporary employment agency activities" family.
//   2. Company name matches a curated regex list of well-known UK agencies
//      OR contains generic agency words (recruitment, staffing, headhunters).
//
// Once flagged, later features can offer a "hide recruiter-posted jobs"
// toggle (from Tom's punch list). We STORE the reason so the UI can be honest
// about why a company was flagged.

const RECRUITMENT_SIC_CODES: Record<string, string> = {
  "78100": "General employment placement",
  "78109": "Other employment placement",
  "78200": "Temporary employment agency activities",
  "78300": "Other human resources provision",
  "74909": "Other prof/tech activities (often umbrella)",
};

// Known UK/global recruitment agencies. Match at word boundary so we don't
// misfire on unrelated brand names.
const AGENCY_NAME_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /^hays\b/i, label: "hays" },
  { pattern: /\bmichael\s+page\b/i, label: "michael page" },
  { pattern: /\bpage\s+group\b/i, label: "pagegroup" },
  { pattern: /\brandstad\b/i, label: "randstad" },
  { pattern: /\brobert\s+walters\b/i, label: "robert walters" },
  { pattern: /\brobert\s+half\b/i, label: "robert half" },
  { pattern: /\badecco\b/i, label: "adecco" },
  { pattern: /\bmanpower\b/i, label: "manpower" },
  { pattern: /\bkelly\s+services\b/i, label: "kelly services" },
  { pattern: /\bsthree\b/i, label: "sthree" },
  { pattern: /\bharvey\s+nash\b/i, label: "harvey nash" },
  { pattern: /\breed\s+specialist\b/i, label: "reed specialist" },
  // "Reed" alone would misfire on Reed Elsevier etc, so we only match
  // qualified forms of that brand.
  { pattern: /\bmorson\b/i, label: "morson" },
  { pattern: /\bimpellam\b/i, label: "impellam" },
  { pattern: /\brulli\s+group\b/i, label: "rullion" },
  { pattern: /\brullion\b/i, label: "rullion" },
  // Brand-name UK agencies — no agency word in the name, so nothing but a
  // curated list catches them. Every one of these was observed posting jobs in
  // live shortlist data and was slipping through as "not a recruiter".
  { pattern: /\bhuntress\b/i, label: "huntress" },
  { pattern: /\bmatchtech\b/i, label: "matchtech" },
  { pattern: /\blorien\b/i, label: "lorien" },
  { pattern: /\bnigel\s+wright\b/i, label: "nigel wright" },
  { pattern: /\bbutler\s+rose\b/i, label: "butler rose" },
  { pattern: /\bcoburg\s+banks\b/i, label: "coburg banks" },
  { pattern: /\bmorgan\s+hunt\b/i, label: "morgan hunt" },
  { pattern: /\bpertemps\b/i, label: "pertemps" },
  { pattern: /\bblue\s+arrow\b/i, label: "blue arrow" },
  { pattern: /\bbrook\s+street\b/i, label: "brook street" },
  { pattern: /\boffice\s+angels\b/i, label: "office angels" },
  { pattern: /\bgi\s+group\b/i, label: "gi group" },
  { pattern: /\bbis\s+henderson\b/i, label: "bis henderson" },
  { pattern: /\bcast\s+uk\b/i, label: "cast uk" },
  { pattern: /\bzachary\s+daniels\b/i, label: "zachary daniels" },
  { pattern: /\bsearch\s+consultancy\b/i, label: "search consultancy" },
  { pattern: /\bsellick\b/i, label: "sellick partnership" },

  // ---- Sector agencies that DOMINATE aggregator supply for the blue-collar /
  // education / care / trades searches (SEARCH_QUALITY_BASELINE_2026-07-19, #5).
  // These are brand names with no agency word, so nothing but a curated entry
  // catches them — and on the teacher search a SINGLE agency ("Academics") filled
  // all 10 results while the detector reported a 0% recruiter rate. Each was
  // observed in live shortlist data or is a top-5 UK agency in its sector.
  //
  // ⚠️ The line these must NOT cross: a CARE-HOME OPERATOR or SCHOOL is the
  // EMPLOYER, not an agency. "Care Concern Group", "Hallmark Care Homes",
  // "Meallmore", "Care UK", "Bluebird Care" hire their own staff — they are the
  // direct employer a candidate wants, the opposite of a middleman. So we match
  // agency BRAND NAMES, never the words "care"/"nursing"/"school" on their own.

  // Education / supply-teaching agencies. Teaching is the most agency-saturated
  // sector we search — the audit's Sheffield teacher run was 100% agency supply —
  // so this list is deliberately the deepest. Each is a distinct agency BRAND
  // (never the bare word "education", which a school / academy trust owns too).
  { pattern: /\bacademics\b/i, label: "academics" },
  { pattern: /\bteaching\s+personnel\b/i, label: "teaching personnel" },
  { pattern: /\bteacher\s*active\b/i, label: "teacheractive" },
  { pattern: /\bgsl\s+education\b/i, label: "gsl education" },
  { pattern: /\bpk\s+education\b/i, label: "pk education" },
  { pattern: /\bprotocol\s+education\b/i, label: "protocol education" },
  { pattern: /\bvision\s+for\s+education\b/i, label: "vision for education" },
  { pattern: /\bengage\s+education\b/i, label: "engage education" },
  { pattern: /\bsimply\s+education\b/i, label: "simply education" },
  { pattern: /\breeson\s+education\b/i, label: "reeson education" },
  { pattern: /\bcareer\s+teachers\b/i, label: "career teachers" },
  { pattern: /\baspire\s+people\b/i, label: "aspire people" },
  { pattern: /\bprospero\b/i, label: "prospero teaching" },
  { pattern: /\btradewind\b/i, label: "tradewind" },
  { pattern: /\bsupply\s+desk\b/i, label: "the supply desk" },
  // "Trust Education" ONLY in that word order — the agency. An academy trust is
  // "<Name> Academy Trust" / "... Education Trust" (reversed), never this, so a
  // real school employer is not caught.
  { pattern: /\btrust\s+education\b/i, label: "trust education" },
  // Healthcare / nursing staffing agencies (supply temp nurses/carers — an agency,
  // distinct from the care-home operators guarded against above).
  { pattern: /\bnewcross\b/i, label: "newcross healthcare" },
  { pattern: /\bmedacs\b/i, label: "medacs" },
  { pattern: /\bthornbury\s+nursing\b/i, label: "thornbury nursing" },
  { pattern: /\bnurse\s+seekers\b/i, label: "nurse seekers" },
  // Industrial / driving / warehouse staffing agencies.
  { pattern: /\bstaffline\b/i, label: "staffline" },
  { pattern: /\bextrastaff\b/i, label: "extrastaff" },
  { pattern: /\bchallenge[\s-]?trg\b/i, label: "challenge-trg" },
  { pattern: /\bdriver\s+hire\b/i, label: "driver hire" },

  // Generic markers — highest false-positive risk, matched last.
  { pattern: /\brecruitment\b/i, label: "generic:recruitment" },
  { pattern: /\brecruiters?\b/i, label: "generic:recruiters" },
  { pattern: /\brecruiting\b/i, label: "generic:recruiting" },
  // Bare "recruit" — catches "Net Recruit", "Recruit UK". The word almost never
  // appears in a non-agency company name.
  { pattern: /\brecruit\b/i, label: "generic:recruit" },
  { pattern: /\bstaffing\b/i, label: "generic:staffing" },
  { pattern: /\bheadhunters?\b/i, label: "generic:headhunters" },
  { pattern: /\bsearch\s+partners\b/i, label: "generic:search partners" },
  // "X Search & Selection" (Avon Search & Selection) — a stock agency construction.
  { pattern: /\bsearch\s+(?:&|and)\s+selection\b/i, label: "generic:search & selection" },
  // "Resourcing" as a company-name token is overwhelmingly an agency ("High
  // Profile Resourcing", "Gi Group Resourcing"); it is not a word an operating
  // employer puts in its trading name.
  { pattern: /\bresourcing\b/i, label: "generic:resourcing" },
  // "X Personnel" (Teaching Personnel, Sanctuary Personnel, Encore Personnel,
  // Pertemps Personnel) — a company named "… Personnel" is an agency.
  { pattern: /\bpersonnel\b/i, label: "generic:personnel" },
  // "<staffing-context> Agency" — a recruitment/employment/nursing/driving/skills
  // AGENCY. Guard the word "agency" behind a staffing context so a creative or
  // marketing "agency" is never caught, and "care agency" (a domiciliary-care
  // EMPLOYER, e.g. Bluebird Care) is deliberately excluded.
  { pattern: /\b(?:recruitment|employment|staffing|nursing|driving|education|teaching|catering|industrial|skills|temp(?:ing)?)\s+agenc(?:y|ies)\b/i,
    label: "generic:staffing agency" },
  // "<Nurse|Care|Job|Staff|Talent> Seekers" — an agency construction. Bounded to
  // these prefixes so a real employer like the nursery group "Attention Seekers"
  // is not swept in.
  { pattern: /\b(?:nurse|care|job|staff|talent)\s+seekers\b/i, label: "generic:seekers" },
];

export interface RecruiterDetectResult {
  is_recruiter: boolean;
  reason: string | null;
}

export function detectRecruiter(
  sicCodes: string[] | null | undefined,
  companyName: string | null | undefined
): RecruiterDetectResult {
  if (sicCodes && sicCodes.length) {
    for (const sic of sicCodes) {
      if (RECRUITMENT_SIC_CODES[sic]) {
        return { is_recruiter: true, reason: `sic_${sic}` };
      }
    }
  }
  if (companyName) {
    for (const { pattern, label } of AGENCY_NAME_PATTERNS) {
      if (pattern.test(companyName)) {
        return { is_recruiter: true, reason: `name:${label}` };
      }
    }
  }
  return { is_recruiter: false, reason: null };
}
