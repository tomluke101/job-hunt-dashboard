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
