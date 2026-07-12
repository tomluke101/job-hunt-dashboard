// Taxonomy-driven title suggester. Takes what the user typed in Name /
// Keywords / Description and proposes ADJACENT titles they haven't already
// added — not the words they typed back at them.
//
// Two lookup axes:
//   1. QUALIFIERS_BY_NOUN — bare noun → common qualified titles (Data
//      Analyst, Business Analyst, Financial Analyst...)
//   2. ADJACENT_QUALIFIERS — same-noun, related-domain (Supply Chain
//      Analyst → Procurement Analyst, Logistics Analyst...)
//   3. ADJACENT_NOUNS — same-domain, different role type (Supply Chain
//      Analyst → Supply Chain Manager, Supply Chain Lead...)
//   4. Seniority prefix — Senior <title>, Junior <title>
//
// Anything the user's already typed exactly is filtered out.

// Every word we recognise as the "role type" tail of a job title.
// Kept singular — plurals are stemmed before lookup.
export const ROLE_NOUNS = new Set<string>([
  "analyst", "manager", "engineer", "designer", "developer", "consultant",
  "specialist", "lead", "coordinator", "executive", "director", "writer",
  "scientist", "accountant", "buyer", "advisor", "administrator", "officer",
  "assistant", "representative", "architect", "producer", "editor",
  "planner", "controller", "supervisor", "associate", "researcher",
  "recruiter", "auditor", "strategist", "bookkeeper", "trader",
  "copywriter", "paralegal", "solicitor", "nurse", "teacher", "chef",
  "operator", "technician", "clerk", "receptionist", "surveyor",
]);

// Words that must NOT be treated as part of the qualifier when we parse a
// role phrase — they're modifiers of some kind (seniority, tense, filler).
const NON_QUALIFIER_WORDS = new Set<string>([
  "the", "a", "an", "of", "for", "and", "or", "at", "in", "to", "with", "on",
  "by", "from", "as", "into", "about",
  "senior", "junior", "lead", "principal", "staff", "chief", "head",
  "assistant", "trainee", "graduate", "intern", "interim",
  "contract", "permanent", "temp", "temporary",
  "full", "part", "time", "level", "mid", "entry", "experienced",
  "any", "some", "new", "this", "that", "these", "those",
  "my", "your", "our", "their", "his", "her",
  "very", "really", "quite", "great", "good", "best", "top",
  "role", "job", "position", "vacancy", "opening",
  "be", "am", "is", "are", "was", "were", "been", "being",
  "want", "wants", "wanted", "wanting",
  "like", "likes", "liked", "liking",
  "looking", "seeking", "hoping", "expect", "expects", "expected",
  "hire", "hiring", "seeking",
]);

// If the role-noun is immediately preceded by one of these, treat it as a
// verb rather than a title. Kills "the potential to LEAD to a career" style
// matches that otherwise misfire as "potential lead".
const VERB_PRECEDERS = new Set<string>([
  "to", "will", "would", "can", "could", "should", "may", "might", "shall",
  "must", "does", "did", "do", "let", "lets", "help", "helps",
]);

// Bare-noun expansion. Each entry is roughly ordered by prevalence.
const QUALIFIERS_BY_NOUN: Record<string, string[]> = {
  analyst: ["Data", "Business", "Financial", "Product", "Marketing", "Research", "Systems", "Operations", "Credit", "Risk", "Compliance"],
  manager: ["Product", "Marketing", "Operations", "Project", "Programme", "Account", "Sales", "Category", "Office"],
  engineer: ["Software", "Data", "DevOps", "Frontend", "Backend", "Machine Learning", "Site Reliability", "Full-Stack", "Cloud", "Platform", "Security"],
  designer: ["Product", "UX", "UI", "Graphic", "Motion", "Interaction", "Visual", "Brand"],
  developer: ["Frontend", "Backend", "Full-Stack", "Mobile", "Web", "iOS", "Android"],
  consultant: ["Management", "Strategy", "Business", "Technology", "Financial", "HR", "IT"],
  specialist: ["Marketing", "HR", "SEO", "Content", "Support", "Payroll", "Communications", "Compliance"],
  lead: ["Tech", "Product", "Design", "Engineering", "Growth", "Marketing", "Data"],
  coordinator: ["Project", "Marketing", "Operations", "HR", "Events", "Sales", "Programme"],
  executive: ["Sales", "Account", "Marketing", "Business Development", "PR"],
  director: ["Marketing", "Engineering", "Product", "Sales", "Operations", "Finance", "HR", "IT"],
  writer: ["Content", "Technical", "Copy", "Grant", "Bid"],
  scientist: ["Data", "Research", "Applied", "Machine Learning"],
  accountant: ["Management", "Financial", "Tax", "Trainee", "Chartered", "Cost"],
  buyer: ["Category", "Retail", "Senior", "Assistant", "Merchandise", "IT"],
  advisor: ["Financial", "Client", "Customer", "Careers", "Investment", "Pension"],
  administrator: ["Office", "HR", "Systems", "Database", "Sales", "Payroll"],
  officer: ["Compliance", "Risk", "Data", "Security", "HR", "Communications", "Marketing"],
  assistant: ["Executive", "Personal", "Marketing", "HR", "Legal", "Finance", "Buying"],
  representative: ["Sales", "Customer Service", "Business Development", "Field Sales"],
  architect: ["Software", "Solution", "Enterprise", "Data", "Cloud", "Security"],
  producer: ["Content", "Video", "Live", "Executive", "Music"],
  editor: ["Content", "Video", "Copy", "Web", "Photo", "Managing"],
  planner: ["Media", "Marketing", "Financial", "Supply Chain", "Demand", "Production"],
  controller: ["Financial", "Credit", "Quality", "Cost", "Document"],
  supervisor: ["Warehouse", "Production", "Team", "Site", "Shift", "Operations"],
  associate: ["Sales", "Marketing", "Research", "Account", "Legal", "Investment"],
  researcher: ["Market", "User", "Data", "Clinical", "UX"],
  recruiter: ["Technical", "Executive", "Graduate", "In-House"],
  auditor: ["Internal", "External", "IT", "Financial"],
  strategist: ["Content", "Digital", "Marketing", "Brand", "SEO"],
  bookkeeper: ["Senior", "Junior"],
  trader: ["Equity", "FX", "Commodity", "Derivatives"],
  copywriter: ["Senior", "Junior", "Freelance"],
  paralegal: ["Corporate", "Litigation", "Commercial"],
  solicitor: ["Corporate", "Litigation", "Commercial", "Property"],
  nurse: ["Registered", "Staff", "Practice", "Community"],
  teacher: ["Primary", "Secondary", "Supply", "SEN", "Nursery"],
  chef: ["Head", "Sous", "Pastry", "Development"],
  technician: ["IT", "Lab", "Service", "Maintenance", "Field"],
  surveyor: ["Quantity", "Building", "Land", "Chartered"],
};

// Adjacent domain qualifiers — same role noun, related field.
const ADJACENT_QUALIFIERS: Record<string, string[]> = {
  // Supply / procurement family
  "supply chain": ["Procurement", "Logistics", "Operations", "Category"],
  "procurement": ["Supply Chain", "Category", "Sourcing", "Buying"],
  "logistics": ["Supply Chain", "Warehouse", "Operations", "Distribution"],
  "category": ["Procurement", "Buying", "Merchandising"],
  "warehouse": ["Logistics", "Operations", "Distribution"],

  // Product / delivery family
  "product": ["Growth", "Programme", "Delivery", "Technical Product"],
  "growth": ["Product", "Marketing", "Performance Marketing"],
  "program": ["Programme", "Project", "Product", "Delivery"],
  "programme": ["Project", "Product", "Delivery", "Portfolio"],
  "project": ["Programme", "Delivery", "Product"],

  // Data family
  "data": ["Analytics", "Business Intelligence", "Machine Learning", "Insight"],
  "analytics": ["Data", "Business Intelligence", "Insight"],
  "business intelligence": ["Data", "Analytics", "BI"],
  "machine learning": ["Data Science", "AI", "Applied Science"],

  // Marketing / brand family
  "marketing": ["Growth", "Brand", "Digital Marketing", "Product Marketing", "Content"],
  "brand": ["Marketing", "Communications", "Creative", "PR"],
  "content": ["Marketing", "Editorial", "SEO", "Communications"],
  "digital marketing": ["Marketing", "Performance Marketing", "Growth", "SEO"],
  "performance marketing": ["Growth", "Digital Marketing", "Acquisition"],
  "communications": ["PR", "Marketing", "Corporate Affairs", "Brand"],
  "pr": ["Communications", "Corporate Affairs", "Media Relations"],
  "seo": ["Content", "Digital Marketing", "Performance Marketing"],

  // Finance family
  "finance": ["Financial", "Accounting", "Treasury", "FP&A"],
  "financial": ["Finance", "Accounting", "Treasury", "Audit"],
  "accounting": ["Financial", "Finance", "Audit", "Tax"],
  "treasury": ["Finance", "Financial", "Cash"],
  "audit": ["Financial", "Compliance", "Risk"],
  "tax": ["Financial", "Accounting", "VAT"],

  // People family
  "hr": ["People", "Talent", "Learning & Development", "Recruitment"],
  "people": ["HR", "Talent", "Culture", "Employee Experience"],
  "talent": ["HR", "Recruitment", "Talent Acquisition", "People"],
  "recruitment": ["Talent Acquisition", "HR", "Talent"],
  "learning & development": ["HR", "People", "Training"],
  "payroll": ["HR", "Finance", "People"],

  // Sales / commercial
  "sales": ["Business Development", "Account Management", "Partnerships", "Commercial"],
  "business development": ["Sales", "Partnerships", "Commercial"],
  "account": ["Client", "Customer", "Sales", "Business Development"],
  "commercial": ["Sales", "Business", "Trading", "Revenue"],

  // Software family
  "software": ["Backend", "Frontend", "Full-Stack", "Platform"],
  "backend": ["Software", "Platform", "Cloud"],
  "frontend": ["Software", "UI", "Full-Stack"],
  "full-stack": ["Software", "Backend", "Frontend"],
  "full stack": ["Software", "Backend", "Frontend"],
  "devops": ["Platform", "Site Reliability", "Cloud", "Infrastructure"],
  "cloud": ["Platform", "DevOps", "Infrastructure"],
  "platform": ["DevOps", "Cloud", "Infrastructure"],
  "site reliability": ["DevOps", "Platform", "Infrastructure"],
  "security": ["Cyber Security", "Information Security", "Cloud Security"],

  // Design family
  "ux": ["UI", "Product", "Interaction", "Visual"],
  "ui": ["UX", "Product", "Visual", "Graphic"],
  "visual": ["Graphic", "Brand", "UI"],
  "graphic": ["Visual", "Brand", "UI"],

  // Compliance / risk family
  "compliance": ["Risk", "Legal", "Audit", "Regulatory"],
  "risk": ["Compliance", "Credit", "Audit", "Actuarial"],
  "legal": ["Compliance", "Regulatory", "Contracts"],

  // Operations family
  "operations": ["Business Operations", "Supply Chain", "Programme", "Delivery"],
  "business operations": ["Operations", "Strategy", "BizOps"],

  // Research family
  "research": ["Insights", "R&D", "Market Research", "User Research"],
  "market research": ["Insights", "Research", "Analytics"],
  "user research": ["UX Research", "Research", "Product Research"],
  "insight": ["Analytics", "Research", "Data"],

  // Customer family
  "customer": ["Client", "Account", "Support", "Success"],
  "customer service": ["Support", "Customer Experience", "Customer Success"],
  "customer success": ["Account Management", "Support", "Customer Experience"],
  "support": ["Customer Service", "Technical Support", "IT Support"],
};

// Adjacent role nouns — same domain, related role type. Kept conservative
// to avoid awkward combinations like "Marketing Owner".
const ADJACENT_NOUNS: Record<string, string[]> = {
  analyst: ["Manager", "Consultant", "Associate", "Lead"],
  manager: ["Lead", "Consultant", "Coordinator"],
  engineer: ["Developer", "Architect"],
  developer: ["Engineer", "Architect"],
  designer: ["Design Lead"],
  consultant: ["Manager", "Analyst", "Associate"],
  specialist: ["Manager", "Coordinator", "Lead"],
  lead: ["Manager", "Principal"],
  coordinator: ["Assistant", "Specialist", "Manager"],
  executive: ["Manager", "Coordinator"],
  writer: ["Editor", "Copywriter"],
  scientist: ["Engineer", "Researcher"],
  accountant: ["Bookkeeper", "Analyst"],
  buyer: ["Merchandiser"],
  advisor: ["Consultant", "Specialist"],
  administrator: ["Coordinator", "Officer"],
  officer: ["Manager", "Advisor", "Specialist"],
  assistant: ["Coordinator", "Administrator", "Associate"],
  associate: ["Manager", "Analyst", "Consultant"],
  researcher: ["Analyst", "Manager"],
  auditor: ["Manager"],
  strategist: ["Manager", "Lead"],
  bookkeeper: ["Accountant"],
  copywriter: ["Editor", "Writer"],
};

// Damerau-Levenshtein edit distance — handles insertions, deletions,
// substitutions, and adjacent transpositions ("anaylst" → "analyst" in 1).
function damerauLevenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const alen = a.length;
  const blen = b.length;
  if (alen === 0) return blen;
  if (blen === 0) return alen;
  const dp: number[][] = [];
  for (let i = 0; i <= alen; i++) {
    dp.push(new Array(blen + 1).fill(0));
    dp[i][0] = i;
  }
  for (let j = 0; j <= blen; j++) dp[0][j] = j;
  for (let i = 1; i <= alen; i++) {
    for (let j = 1; j <= blen; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        dp[i][j] = Math.min(dp[i][j], dp[i - 2][j - 2] + 1);
      }
    }
  }
  return dp[alen][blen];
}

// Length-scaled fuzzy match — 1 edit for short words, 2 for long. Skips
// candidates that are wildly different length (cheap early-out).
function fuzzyMatch(word: string, candidates: Iterable<string>): string | null {
  const w = word.toLowerCase();
  if (w.length < 4) return null;
  const threshold = w.length <= 7 ? 1 : 2;
  let best: string | null = null;
  let bestDist = threshold + 1;
  for (const c of candidates) {
    if (Math.abs(c.length - w.length) > threshold) continue;
    const d = damerauLevenshtein(w, c);
    if (d < bestDist) {
      bestDist = d;
      best = c;
      if (d === 0) return c;
    }
  }
  return bestDist <= threshold ? best : null;
}

// Prefix match — used for live autocomplete ("prod" → "product"). Prefers
// the shortest candidate when several start with the same prefix.
function prefixMatch(prefix: string, candidates: Iterable<string>): string | null {
  const p = prefix.toLowerCase();
  if (p.length < 3) return null;
  let best: string | null = null;
  for (const c of candidates) {
    if (c.startsWith(p)) {
      if (best === null || c.length < best.length) best = c;
    }
  }
  return best;
}

function stemPlural(w: string): string {
  const s = w.toLowerCase();
  if (s.length < 5) return s;
  if (s.endsWith("ss") || s.endsWith("us") || s.endsWith("is")) return s;
  if (s.endsWith("ies")) return s.slice(0, -3) + "y";
  if (s.endsWith("s")) return s.slice(0, -1);
  return s;
}

function titleCase(s: string): string {
  return s
    .split(/\s+/)
    .map((w) => (w.length ? w[0].toUpperCase() + w.slice(1).toLowerCase() : ""))
    .filter(Boolean)
    .join(" ");
}

// Special-cased title-case for known acronyms and multi-word qualifiers
// where naïve titleCase gives us "Ux" or "It".
const SPECIAL_CASE: Record<string, string> = {
  ux: "UX", ui: "UI", hr: "HR", it: "IT", pr: "PR", seo: "SEO",
  bi: "BI", ai: "AI", vp: "VP", rd: "R&D", "fp&a": "FP&A",
  devops: "DevOps", ios: "iOS",
};

function prettyToken(s: string): string {
  const lower = s.toLowerCase();
  if (SPECIAL_CASE[lower]) return SPECIAL_CASE[lower];
  return titleCase(lower);
}

function prettyPhrase(s: string): string {
  return s.split(/\s+/).map(prettyToken).join(" ");
}

function normalise(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

interface ParsedRole {
  qualifier: string;
  noun: string;
}

function parseRolePhrase(phrase: string): ParsedRole | null {
  const words = normalise(phrase).split(/\s+/).filter(Boolean);
  if (words.length === 0) return null;
  const lastRaw = words[words.length - 1];
  let noun = stemPlural(lastRaw);
  if (!ROLE_NOUNS.has(noun)) {
    // Try fuzzy match (misspelling like "analst" → "analyst") then prefix
    // match (autocomplete like "eng" → "engineer" while typing).
    const fuzzy = fuzzyMatch(noun, ROLE_NOUNS);
    if (fuzzy) noun = fuzzy;
    else {
      const prefix = prefixMatch(noun, ROLE_NOUNS);
      if (prefix) noun = prefix;
      else return null;
    }
  }
  const qualifierWords = words
    .slice(0, -1)
    .filter((w) => !NON_QUALIFIER_WORDS.has(w));
  return { qualifier: qualifierWords.join(" "), noun };
}

// Extract phrases the user typed as an explicit list — Name or Keywords.
// Yields both parseable role phrases AND bare qualifier phrases (project,
// legal, supply chain) so downstream logic can suggest for either.
function extractPhrasesFromList(text: string): string[] {
  if (!text) return [];
  const out = new Set<string>();
  for (const part of text.split(/[,/\n]|\band\b/i).map((s) => s.trim())) {
    if (part.length < 2 || part.length > 60) continue;
    if (parseRolePhrase(part)) {
      out.add(part);
      continue;
    }
    if (parseBareQualifier(part)) out.add(part);
  }
  return Array.from(out);
}

// Role nouns that are always used as nouns in English — safe to extract
// from prose even without a qualifier. Excludes ambiguous nouns like
// "lead" (verb: to lead), "head" (verb: to head), "staff" (verb),
// "chief"/"principal"/"associate" (adjectives), etc.
const UNAMBIGUOUS_ROLE_NOUNS = new Set<string>([
  "analyst", "engineer", "developer", "designer", "manager", "consultant",
  "coordinator", "administrator", "specialist", "accountant", "buyer",
  "writer", "scientist", "researcher", "recruiter", "auditor",
  "bookkeeper", "copywriter", "paralegal", "solicitor", "nurse",
  "teacher", "chef", "technician", "surveyor", "clerk", "receptionist",
  "producer", "editor", "planner", "supervisor", "architect", "trader",
]);

// Tokenise a prose blob. Splits on hyphens (so "entry-junior" reads as two
// words), commas, and whitespace — matches how humans separate list items
// mid-sentence.
function tokeniseProse(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z\s&+/]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

// Extract role phrases from a description written in prose. STRICT: rejects
// verb usage ("to lead a team"), figures of speech ("potential to lead"),
// and bare ambiguous nouns ("hire a lead"). Bare unambiguous nouns like
// "analyst" are accepted; anything with a qualifier requires the qualifier
// to be a recognised professional term.
function extractPhrasesFromProse(text: string): string[] {
  if (!text) return [];
  const out = new Set<string>();
  const words = tokeniseProse(text);
  let picked = 0;
  for (let i = 0; i < words.length && picked < 5; i++) {
    const stem = stemPlural(words[i]);
    if (!ROLE_NOUNS.has(stem)) continue;
    if (i > 0 && VERB_PRECEDERS.has(words[i - 1])) continue;
    let start = Math.max(0, i - 3);
    while (start < i && NON_QUALIFIER_WORDS.has(words[start])) start++;
    if (start === i) {
      // No qualifier — accept only if the noun is unambiguous in English.
      if (!UNAMBIGUOUS_ROLE_NOUNS.has(stem)) continue;
      if (!out.has(stem)) {
        out.add(stem);
        picked++;
      }
      continue;
    }
    const qualifierWords = words.slice(start, i);
    if (!qualifierWordsAreRecognised(qualifierWords)) continue;
    const phrase = qualifierWords.concat(stem).join(" ");
    if (!out.has(phrase)) {
      out.add(phrase);
      picked++;
    }
  }
  return Array.from(out);
}

// A prose qualifier is "recognised" iff at least one of its tokens (or a
// contiguous bigram inside it) matches a KNOWN_QUALIFIERS entry. Used as
// the gate on prose-extraction; permissive extraction paths (user-typed
// lists) skip this check.
function qualifierWordsAreRecognised(qualifierWords: string[]): boolean {
  for (let i = 0; i < qualifierWords.length; i++) {
    if (KNOWN_QUALIFIERS.has(qualifierWords[i])) return true;
    if (i + 1 < qualifierWords.length) {
      const two = `${qualifierWords[i]} ${qualifierWords[i + 1]}`;
      if (KNOWN_QUALIFIERS.has(two)) return true;
    }
  }
  return false;
}

// Built once from ADJACENT_QUALIFIERS and QUALIFIERS_BY_NOUN. Used by both
// prose extraction and pass 2 of extractSearchTerms.
const KNOWN_QUALIFIERS: Set<string> = (() => {
  const s = new Set<string>();
  for (const k of Object.keys(ADJACENT_QUALIFIERS)) s.add(k);
  for (const arr of Object.values(QUALIFIERS_BY_NOUN)) for (const v of arr) s.add(v.toLowerCase());
  return s;
})();

// Explicit augments where the automatic inversion of QUALIFIERS_BY_NOUN
// (below) is thin — e.g. "legal" only appears as a qualifier for
// "assistant", so inversion alone gives Legal Assistant. Users typing
// "legal" also want Legal Counsel, Solicitor, Paralegal etc.
const NOUNS_BY_QUALIFIER_OVERRIDES: Record<string, string[]> = {
  // --- Legal
  legal: ["Counsel", "Advisor", "Analyst", "Secretary", "Paralegal", "Solicitor", "Officer", "Assistant"],
  "corporate law": ["Solicitor", "Paralegal", "Counsel"],
  litigation: ["Solicitor", "Paralegal", "Executive"],
  "commercial law": ["Solicitor", "Paralegal", "Counsel"],
  "property law": ["Solicitor", "Paralegal", "Conveyancer"],
  "family law": ["Solicitor", "Paralegal"],
  "criminal law": ["Solicitor", "Paralegal", "Barrister"],
  immigration: ["Advisor", "Officer", "Solicitor"],
  conveyancing: ["Solicitor", "Paralegal", "Assistant"],

  // --- Supply chain / procurement / logistics
  "supply chain": ["Analyst", "Manager", "Coordinator", "Planner", "Officer", "Director"],
  procurement: ["Analyst", "Manager", "Coordinator", "Officer", "Specialist", "Buyer"],
  logistics: ["Manager", "Coordinator", "Analyst", "Executive", "Supervisor"],
  warehouse: ["Manager", "Operative", "Supervisor", "Coordinator", "Team Leader"],
  transportation: ["Manager", "Coordinator", "Planner"],
  distribution: ["Manager", "Coordinator", "Analyst"],
  fleet: ["Manager", "Coordinator", "Administrator"],
  shipping: ["Coordinator", "Manager", "Analyst"],
  freight: ["Coordinator", "Manager", "Forwarder"],

  // --- Projects / programme / change
  project: ["Manager", "Coordinator", "Lead", "Administrator", "Officer", "Analyst"],
  programme: ["Manager", "Director", "Coordinator", "Lead", "Officer"],
  program: ["Manager", "Director", "Coordinator", "Lead"],
  transformation: ["Manager", "Analyst", "Consultant", "Lead", "Director"],
  change: ["Manager", "Analyst", "Lead", "Consultant"],
  "programme management": ["Manager", "Director", "Officer"],
  portfolio: ["Manager", "Analyst", "Director"],

  // --- Marketing / brand / media / content
  marketing: ["Manager", "Executive", "Analyst", "Coordinator", "Specialist", "Director", "Assistant"],
  brand: ["Manager", "Executive", "Director", "Strategist", "Coordinator"],
  content: ["Writer", "Manager", "Editor", "Marketer", "Strategist", "Creator", "Producer"],
  creative: ["Director", "Lead", "Manager", "Producer"],
  media: ["Planner", "Buyer", "Executive", "Manager"],
  events: ["Manager", "Coordinator", "Executive"],
  pr: ["Manager", "Executive", "Officer", "Coordinator", "Account Manager"],
  communications: ["Manager", "Executive", "Officer", "Director", "Specialist"],
  "digital marketing": ["Manager", "Executive", "Specialist"],
  "performance marketing": ["Manager", "Executive", "Specialist", "Analyst"],
  "product marketing": ["Manager", "Executive", "Specialist"],
  seo: ["Specialist", "Manager", "Consultant", "Executive"],
  ppc: ["Executive", "Specialist", "Manager"],
  crm: ["Manager", "Analyst", "Administrator", "Executive"],
  "social media": ["Manager", "Executive", "Coordinator", "Specialist"],
  copywriting: ["Copywriter", "Writer", "Executive"],
  editorial: ["Editor", "Assistant", "Director", "Manager"],
  journalism: ["Journalist", "Reporter", "Editor", "Writer"],
  publishing: ["Editor", "Assistant", "Manager"],
  broadcasting: ["Producer", "Presenter", "Reporter", "Editor"],
  film: ["Producer", "Director", "Editor", "Camera Operator"],
  video: ["Producer", "Editor", "Manager"],
  photography: ["Photographer", "Assistant", "Editor"],

  // --- Sales / commercial / account
  sales: ["Executive", "Manager", "Representative", "Director", "Coordinator", "Assistant"],
  "business development": ["Manager", "Executive", "Representative", "Director"],
  "account management": ["Manager", "Director", "Executive"],
  "key account": ["Manager", "Executive"],
  "field sales": ["Representative", "Manager", "Executive"],
  "inside sales": ["Representative", "Executive", "Manager"],
  commercial: ["Manager", "Director", "Analyst"],
  partnerships: ["Manager", "Executive", "Director"],
  "customer success": ["Manager", "Advisor", "Specialist", "Executive"],
  "customer service": ["Manager", "Advisor", "Representative", "Team Leader"],
  "customer experience": ["Manager", "Analyst", "Specialist"],
  "contact centre": ["Manager", "Advisor", "Team Leader"],

  // --- HR / people / talent / L&D
  hr: ["Manager", "Advisor", "Officer", "Coordinator", "Business Partner", "Assistant"],
  people: ["Advisor", "Officer", "Business Partner", "Manager", "Coordinator"],
  talent: ["Acquisition Manager", "Partner", "Advisor", "Acquisition Specialist"],
  "talent acquisition": ["Manager", "Partner", "Specialist", "Coordinator"],
  recruitment: ["Consultant", "Coordinator", "Officer", "Manager"],
  payroll: ["Manager", "Administrator", "Officer", "Assistant", "Analyst"],
  benefits: ["Manager", "Analyst", "Specialist"],
  compensation: ["Manager", "Analyst", "Specialist"],
  "employee relations": ["Manager", "Advisor", "Officer", "Partner"],
  "learning & development": ["Manager", "Coordinator", "Specialist", "Partner"],
  "l&d": ["Manager", "Coordinator", "Specialist", "Partner"],
  learning: ["Manager", "Coordinator", "Specialist"],
  training: ["Manager", "Officer", "Coordinator"],
  diversity: ["Manager", "Officer", "Advisor", "Consultant"],

  // --- Finance / accounting / tax / audit / banking
  finance: ["Analyst", "Manager", "Director", "Officer", "Business Partner"],
  financial: ["Analyst", "Advisor", "Controller", "Officer", "Planner"],
  accounting: [
    "Accountant", "Management Accountant", "Financial Accountant",
    "Trainee Accountant", "Manager", "Analyst", "Clerk", "Assistant",
  ],
  audit: ["Manager", "Analyst", "Senior", "Associate"],
  tax: ["Manager", "Analyst", "Advisor", "Accountant"],
  treasury: ["Analyst", "Manager"],
  "fp&a": ["Analyst", "Manager", "Director"],
  banking: ["Analyst", "Manager", "Advisor", "Associate"],
  investment: ["Analyst", "Manager", "Banker", "Advisor", "Associate"],
  insurance: ["Broker", "Underwriter", "Claims Handler", "Manager", "Advisor"],
  actuarial: ["Analyst", "Consultant", "Manager"],
  "wealth management": ["Advisor", "Manager", "Planner"],
  trading: ["Analyst", "Manager", "Assistant", "Trader"],
  mortgage: ["Advisor", "Broker", "Underwriter"],
  claims: ["Handler", "Manager", "Adjuster"],
  underwriting: ["Manager", "Analyst", "Officer"],
  "credit control": ["Officer", "Manager", "Analyst"],
  bookkeeping: ["Bookkeeper", "Assistant", "Manager"],

  // --- Risk / compliance
  risk: ["Analyst", "Manager", "Officer", "Advisor"],
  compliance: ["Officer", "Analyst", "Manager", "Specialist"],
  aml: ["Officer", "Analyst", "Manager"],
  kyc: ["Analyst", "Officer", "Manager"],
  regulatory: ["Analyst", "Manager", "Officer", "Affairs Manager"],

  // --- Product / design / UX
  product: ["Manager", "Designer", "Analyst", "Owner", "Marketer"],
  design: ["Lead", "Manager", "Director", "Consultant"],
  ux: ["Designer", "Researcher", "Writer", "Lead"],
  ui: ["Designer", "Developer"],
  "user research": ["Researcher", "Lead", "Manager"],
  "product design": ["Designer", "Lead", "Manager"],
  "graphic design": ["Designer", "Artist"],
  graphic: ["Designer", "Artist"],
  visual: ["Designer", "Artist", "Merchandiser"],
  motion: ["Designer", "Graphics Designer"],
  "3d": ["Artist", "Designer", "Animator"],
  animation: ["Animator", "Designer", "Producer"],
  illustration: ["Illustrator", "Designer"],

  // --- Data / analytics
  data: ["Analyst", "Scientist", "Engineer", "Architect", "Manager"],
  // Analyst intentionally NOT in analytics — "Analytics Analyst" isn't a
  // real UK job title; real titles are Analytics Engineer / Analytics
  // Manager. Same for ML/AI (Engineer/Scientist, not Analyst).
  analytics: ["Manager", "Lead", "Engineer"],
  "business intelligence": ["Analyst", "Developer", "Manager"],
  bi: ["Analyst", "Developer", "Manager"],
  "machine learning": ["Engineer", "Scientist", "Researcher"],
  ml: ["Engineer", "Scientist", "Researcher"],
  ai: ["Engineer", "Researcher", "Scientist"],
  "data science": ["Scientist", "Manager", "Lead"],

  // --- Software / engineering (tech)
  software: ["Engineer", "Developer", "Architect"],
  backend: ["Engineer", "Developer"],
  frontend: ["Engineer", "Developer"],
  "full-stack": ["Engineer", "Developer"],
  "full stack": ["Engineer", "Developer"],
  devops: ["Engineer", "Manager"],
  cloud: ["Engineer", "Architect", "Solutions Architect"],
  platform: ["Engineer", "Manager"],
  "site reliability": ["Engineer"],
  sre: ["Engineer", "Manager"],
  ios: ["Developer", "Engineer"],
  android: ["Developer", "Engineer"],
  mobile: ["Developer", "Engineer"],
  web: ["Developer", "Designer"],
  qa: ["Engineer", "Analyst", "Tester", "Manager"],
  "quality assurance": ["Engineer", "Analyst", "Manager"],
  test: ["Engineer", "Analyst", "Manager"],
  security: ["Analyst", "Engineer", "Officer", "Manager", "Architect"],
  "cyber security": ["Analyst", "Engineer", "Consultant", "Manager"],
  cybersecurity: ["Analyst", "Engineer", "Consultant", "Manager"],
  "information security": ["Analyst", "Officer", "Manager"],
  network: ["Engineer", "Administrator", "Manager"],
  systems: ["Analyst", "Engineer", "Administrator"],
  database: ["Administrator", "Developer", "Engineer"],
  "solution architect": ["Solutions Architect"],
  blockchain: ["Developer", "Engineer", "Consultant"],
  crypto: ["Analyst", "Trader", "Developer"],
  gaming: ["Developer", "Designer", "Producer"],
  games: ["Developer", "Designer", "Producer"],
  it: ["Manager", "Support Analyst", "Technician", "Administrator"],
  "it support": ["Analyst", "Technician", "Engineer"],
  helpdesk: ["Analyst", "Technician", "Support"],

  // --- Operations / strategy / management
  operations: ["Manager", "Analyst", "Director", "Coordinator", "Executive"],
  "business operations": ["Manager", "Analyst", "Director"],
  strategy: ["Analyst", "Manager", "Consultant", "Director"],
  business: ["Analyst", "Development Manager", "Partner", "Consultant"],
  consulting: ["Consultant", "Manager", "Analyst"],
  "management consulting": ["Consultant", "Manager", "Partner", "Associate"],
  category: ["Manager", "Buyer", "Analyst", "Executive"],
  facilities: ["Manager", "Coordinator", "Officer"],
  policy: ["Analyst", "Advisor", "Officer", "Manager"],
  quality: ["Analyst", "Manager", "Engineer", "Officer"],
  "quality control": ["Officer", "Inspector", "Manager"],
  "process improvement": ["Manager", "Analyst", "Consultant"],

  // --- Retail / merchandising / e-commerce
  retail: ["Manager", "Assistant", "Buyer", "Merchandiser"],
  buying: ["Manager", "Assistant", "Executive", "Coordinator", "Analyst"],
  merchandising: ["Manager", "Assistant", "Coordinator", "Planner"],
  store: ["Manager", "Assistant", "Supervisor"],
  ecommerce: ["Manager", "Executive", "Coordinator", "Analyst"],
  "e-commerce": ["Manager", "Executive", "Coordinator", "Analyst"],

  // --- Hospitality / tourism / travel
  hospitality: ["Manager", "Assistant", "Coordinator"],
  hotel: ["Manager", "Receptionist", "Concierge", "Housekeeper"],
  restaurant: ["Manager", "Chef", "Waiter", "Host"],
  catering: ["Manager", "Assistant", "Coordinator", "Chef"],
  tourism: ["Manager", "Officer", "Advisor"],
  travel: ["Consultant", "Manager", "Agent"],
  aviation: ["Pilot", "Engineer", "Cabin Crew", "Officer"],

  // --- Healthcare / clinical / care
  healthcare: ["Assistant", "Advisor", "Manager", "Coordinator"],
  medical: ["Doctor", "Officer", "Assistant", "Secretary", "Writer", "Sales Representative"],
  // Nursing lists the actual UK job titles a nursing job seeker would
  // recognise — multi-word entries auto-emit as bare because that's how
  // real postings are titled.
  nursing: [
    "Nurse", "Staff Nurse", "Registered Nurse", "Nurse Practitioner",
    "Ward Sister", "Charge Nurse", "Community Nurse", "Practice Nurse",
    "Nursing Assistant", "Nursing Manager",
  ],
  nurse: ["Practitioner", "Manager", "Sister", "Assistant"],
  dental: ["Nurse", "Hygienist", "Practitioner", "Receptionist", "Assistant"],
  veterinary: ["Nurse", "Surgeon", "Assistant", "Receptionist"],
  pharmacy: ["Assistant", "Technician", "Manager"],
  pharmaceutical: ["Sales Representative", "Scientist", "Analyst"],
  clinical: ["Trials Manager", "Trials Coordinator", "Research Associate", "Nurse", "Psychologist"],
  "mental health": ["Nurse", "Worker", "Practitioner", "Support Worker", "Counsellor"],
  physiotherapy: ["Assistant", "Practitioner", "Therapist"],
  radiography: ["Radiographer", "Assistant"],
  radiology: ["Radiographer", "Assistant"],
  care: ["Assistant", "Coordinator", "Manager", "Worker"],
  "social care": ["Worker", "Manager", "Assessor"],
  midwifery: ["Midwife", "Assistant"],
  paramedic: ["Practitioner", "Officer"],
  optometry: ["Optometrist", "Assistant"],

  // --- Education / teaching
  education: ["Coordinator", "Manager", "Officer", "Advisor", "Assistant"],
  teaching: [
    "Teacher", "Primary Teacher", "Secondary Teacher", "Supply Teacher",
    "SEN Teacher", "Nursery Teacher", "Teaching Assistant", "Learning Support Assistant",
  ],
  teacher: ["Assistant", "Support Worker"],
  tutoring: ["Tutor", "Coordinator"],
  lecturer: ["Lecturer", "Senior Lecturer"],
  academic: ["Researcher", "Coordinator", "Officer"],
  "higher education": ["Lecturer", "Researcher", "Administrator"],
  "early years": ["Practitioner", "Assistant", "Manager"],
  sen: ["Teacher", "Coordinator", "Support Assistant"],
  senco: ["Coordinator"],
  school: ["Administrator", "Business Manager", "Bursar"],

  // --- Construction / engineering / trades
  construction: ["Manager", "Site Manager", "Foreman", "Estimator", "Surveyor", "Engineer", "Labourer", "Supervisor", "Planner"],
  civil: ["Engineer", "Manager", "Designer"],
  "civil engineering": ["Engineer", "Manager", "Designer"],
  structural: ["Engineer", "Designer"],
  mechanical: ["Engineer", "Fitter", "Technician", "Designer"],
  electrical: ["Engineer", "Technician", "Electrician", "Fitter"],
  chemical: ["Engineer", "Technician", "Scientist"],
  industrial: ["Engineer", "Technician"],
  aerospace: ["Engineer", "Technician", "Designer"],
  automotive: ["Engineer", "Technician", "Mechanic", "Designer", "Sales Executive"],
  manufacturing: ["Engineer", "Manager", "Operator", "Supervisor", "Planner"],
  production: ["Manager", "Operative", "Planner", "Supervisor"],
  energy: ["Engineer", "Analyst", "Manager", "Consultant", "Trader"],
  renewables: ["Engineer", "Analyst", "Consultant", "Manager", "Officer"],
  utilities: ["Engineer", "Manager", "Officer", "Analyst"],
  "oil and gas": ["Engineer", "Analyst", "Consultant", "Manager"],
  water: ["Engineer", "Manager", "Officer"],
  nuclear: ["Engineer", "Scientist", "Analyst"],
  environmental: ["Consultant", "Officer", "Manager", "Advisor"],
  sustainability: ["Consultant", "Officer", "Manager", "Advisor"],
  agriculture: ["Manager", "Worker", "Consultant", "Advisor"],
  farming: ["Manager", "Worker"],
  mining: ["Engineer", "Manager", "Operative"],
  quarrying: ["Manager", "Operative"],

  // Trades
  plumbing: ["Plumber", "Apprentice", "Engineer"],
  plumber: ["Apprentice"],
  electrician: ["Apprentice", "Mate"],
  carpentry: ["Carpenter", "Joiner", "Apprentice"],
  carpenter: ["Apprentice"],
  joinery: ["Joiner", "Carpenter", "Apprentice"],
  painting: ["Painter", "Decorator", "Apprentice"],
  bricklaying: ["Bricklayer", "Apprentice"],
  roofing: ["Roofer", "Apprentice"],
  landscaping: ["Gardener", "Manager", "Designer"],
  gardening: ["Gardener", "Manager"],
  welding: ["Welder", "Apprentice"],
  scaffolding: ["Scaffolder", "Apprentice"],
  driving: ["Driver", "Operator", "Instructor"],
  hgv: ["Driver"],
  taxi: ["Driver"],

  // --- Property / real estate / surveying
  property: ["Manager", "Consultant", "Coordinator", "Officer"],
  "real estate": ["Agent", "Manager", "Analyst", "Investor"],
  "estate agent": ["Manager", "Negotiator", "Valuer"],
  "estate agency": ["Manager", "Agent", "Negotiator", "Valuer"],
  surveying: ["Surveyor", "Manager", "Consultant"],
  surveyor: ["Manager", "Consultant"],
  architecture: ["Architect", "Technologist", "Assistant"],
  architect: ["Technologist", "Assistant"],
  "interior design": ["Designer", "Consultant", "Manager"],
  "quantity surveying": ["Surveyor", "Senior Surveyor"],

  // --- Public sector / non-profit
  "civil service": ["Officer", "Manager", "Advisor", "Analyst"],
  government: ["Officer", "Manager", "Advisor", "Coordinator"],
  "local government": ["Officer", "Manager", "Advisor", "Coordinator"],
  nhs: ["Nurse", "Manager", "Officer", "Advisor", "Assistant"],
  police: ["Officer", "Constable", "Sergeant", "Analyst"],
  military: ["Officer", "Analyst"],
  housing: ["Officer", "Manager", "Advisor", "Coordinator"],
  charity: ["Officer", "Manager", "Coordinator", "Fundraiser"],
  fundraising: ["Manager", "Officer", "Coordinator", "Executive"],
  grants: ["Officer", "Manager", "Coordinator"],
  "social work": ["Worker", "Manager", "Assistant"],
  "public health": ["Officer", "Manager", "Analyst", "Advisor"],
  "public sector": ["Officer", "Manager", "Consultant", "Analyst"],
  "non-profit": ["Officer", "Manager", "Coordinator", "Fundraiser"],
  "third sector": ["Officer", "Manager", "Coordinator"],

  // --- Science / research
  research: ["Analyst", "Scientist", "Associate", "Manager"],
  laboratory: ["Technician", "Analyst", "Manager", "Assistant", "Scientist"],
  "clinical trials": ["Manager", "Coordinator", "Associate", "Nurse"],
  "life sciences": ["Researcher", "Manager", "Scientist", "Consultant"],
  chemistry: ["Scientist", "Technician", "Analyst"],
  biology: ["Scientist", "Researcher", "Technician"],
  physics: ["Scientist", "Researcher"],
  biotech: ["Scientist", "Researcher", "Manager"],
  biotechnology: ["Scientist", "Researcher", "Manager"],

  // --- Beauty / wellness / fitness
  beauty: ["Therapist", "Consultant", "Advisor", "Assistant"],
  hair: ["Stylist", "Assistant", "Colourist"],
  hairdressing: ["Stylist", "Assistant"],
  "personal training": ["Trainer", "Coach", "Instructor"],
  fitness: ["Instructor", "Trainer", "Coach", "Manager"],
  wellness: ["Coach", "Consultant", "Manager"],
  spa: ["Therapist", "Manager"],

  // --- Growth / adjacent
  growth: ["Manager", "Marketer", "Lead", "Analyst"],
};

// Invert QUALIFIERS_BY_NOUN so a qualifier maps to the nouns commonly paired
// with it, then merge with explicit overrides. Powers "type a bare
// qualifier like project / legal / supply chain, see chip suggestions".
const NOUNS_BY_QUALIFIER: Record<string, string[]> = (() => {
  const map: Record<string, string[]> = {};
  const push = (key: string, val: string): void => {
    const k = key.toLowerCase();
    if (!map[k]) map[k] = [];
    if (!map[k].some((v) => v.toLowerCase() === val.toLowerCase())) map[k].push(val);
  };
  for (const [noun, qualifiers] of Object.entries(QUALIFIERS_BY_NOUN)) {
    for (const q of qualifiers) push(q, prettyToken(noun));
  }
  for (const [k, vs] of Object.entries(NOUNS_BY_QUALIFIER_OVERRIDES)) {
    for (const v of vs) push(k, v);
  }
  return map;
})();

// If the user typed a bare qualifier (project, legal, supply chain), return
// it normalised so we can expand it in suggestTitles. Otherwise null.
// Also handles typos ("marketng" → "marketing") and autocomplete prefixes
// ("prod" → "product").
function parseBareQualifier(phrase: string): string | null {
  const norm = normalise(phrase);
  if (!norm) return null;
  if (NOUNS_BY_QUALIFIER[norm]) return norm;
  if (KNOWN_QUALIFIERS.has(norm)) return norm;
  const allKeys = new Set<string>([
    ...Object.keys(NOUNS_BY_QUALIFIER),
    ...KNOWN_QUALIFIERS,
  ]);
  const fuzzy = fuzzyMatch(norm, allKeys);
  if (fuzzy) return fuzzy;
  const prefix = prefixMatch(norm, allKeys);
  if (prefix) return prefix;
  return null;
}

// Role nouns that stand alone as real job titles because the noun itself
// carries a domain signal. "Foreman" doesn't need "Construction Foreman";
// "Solicitor" doesn't need "Legal Solicitor". Contrast with generic words
// (Manager, Analyst, Engineer) which mean nothing without a qualifier.
// Only nouns that UNIQUELY identify a single domain in real English. If the
// bare word could mean multiple things (Architect = software OR building,
// Editor = video OR copy, Scientist = many kinds), leave it OUT so the
// suggester emits the qualified form ("Software Architect", "Video Editor",
// "Data Scientist").
const BARE_NATURAL_NOUNS = new Set<string>([
  // Construction / trades — each word carries construction domain
  "foreman", "estimator", "surveyor", "labourer", "operative", "bricklayer",
  "roofer", "welder", "plumber", "electrician", "carpenter", "joiner",
  "painter", "decorator", "gardener", "landscaper", "fitter", "mechanic",
  "scaffolder",
  // Legal — each word is legal-only
  "solicitor", "paralegal", "barrister", "counsel", "conveyancer",
  // Healthcare — each word is healthcare-only
  "nurse", "midwife", "paramedic", "radiographer", "optometrist",
  "pharmacist", "physiotherapist", "hygienist",
  // Media narrow — copywriter/journalist/reporter/illustrator are single-domain
  "copywriter", "journalist", "reporter", "photographer", "illustrator",
  // Education
  "teacher", "tutor", "lecturer",
  // Finance — each unambiguous
  "bookkeeper", "accountant", "actuary", "broker", "underwriter", "auditor",
  "trader",
  // Hospitality / service
  "chef", "waiter", "barista", "barber", "stylist", "receptionist",
  "cashier", "cleaner", "concierge", "housekeeper",
  // Transportation
  "driver", "pilot", "conductor",
  // Other single-domain
  "recruiter", "veterinarian", "chemist", "biologist",
]);

function isBareNatural(noun: string): boolean {
  const trimmed = noun.trim();
  if (trimmed.includes(" ")) return true; // multi-word titles like "Site Manager"
  return BARE_NATURAL_NOUNS.has(trimmed.toLowerCase());
}

// Cross-check: is (qualifier, noun) a real pair according to the taxonomy?
// Used to prune weird combinations from adjacency expansion — e.g.
// "Machine Learning Analyst" isn't a common title, so if ML isn't listed
// as a qualifier for Analyst anywhere, we skip the emission.
function isRealPair(qualifier: string, noun: string): boolean {
  const q = qualifier.toLowerCase();
  const n = noun.toLowerCase();
  const entries = NOUNS_BY_QUALIFIER[q];
  if (!entries) return false;
  return entries.some((e) => e.toLowerCase() === n);
}

export interface SuggestInputs {
  name?: string;
  keywords?: string;
  description?: string;
  // What the user is CURRENTLY typing into the Job Titles chip input.
  // When present (>= 2 chars), takes over as the sole suggestion source
  // — behaves like a live autocomplete. When empty, suggestions come from
  // name/keywords/description as related-role hints.
  buffer?: string;
}

export function suggestTitles(
  inputs: SuggestInputs,
  existing: string[],
  max: number = 8
): string[] {
  const blocked = new Set<string>();
  for (const c of existing) blocked.add(normalise(c));

  const phrases: string[] = [];
  const seenPhrases = new Set<string>();
  const collect = (extracted: string[]): void => {
    for (const p of extracted) {
      const key = normalise(p);
      if (!seenPhrases.has(key)) {
        seenPhrases.add(key);
        phrases.push(p);
      }
    }
  };
  // Autocomplete mode: if the user is actively typing in the chip input,
  // that's their intent — ignore Name/Keywords/Description as suggestion
  // sources and use only the buffer. Behaves like a live search-as-you-type.
  const activeBuffer = (inputs.buffer ?? "").trim();
  if (activeBuffer.length >= 2) {
    collect(extractPhrasesFromList(activeBuffer));
  } else {
    collect(extractPhrasesFromList(inputs.name ?? ""));
    collect(extractPhrasesFromList(inputs.keywords ?? ""));
    collect(extractPhrasesFromProse(inputs.description ?? ""));
  }

  const primary: string[] = [];
  const secondary: string[] = [];
  const tertiary: string[] = [];
  const seenSuggested = new Set<string>();

  function push(bucket: string[], text: string): void {
    const key = normalise(text);
    if (!key || blocked.has(key) || seenSuggested.has(key)) return;
    seenSuggested.add(key);
    bucket.push(text);
  }

  for (const phrase of phrases) {
    const parsed = parseRolePhrase(phrase);
    // Also try the bare-qualifier path. For a prefix like "prod", the role
    // parser fuzzy-matches to "producer" AND the qualifier parser
    // prefix-matches to "product" — both are useful, emit both.
    const bareQualifier = parseBareQualifier(phrase);
    if (parsed) {
      const { qualifier, noun } = parsed;
      const nounPretty = prettyToken(noun);

      if (!qualifier) {
        // Bare role noun — offer the noun itself + common qualified variants.
        push(primary, nounPretty);
        for (const q of QUALIFIERS_BY_NOUN[noun] ?? []) {
          push(primary, `${q} ${nounPretty}`);
        }
        push(tertiary, `Senior ${nounPretty}`);
        push(tertiary, `Junior ${nounPretty}`);
      } else {
        const qualifierPretty = prettyPhrase(qualifier);
        // 1. Offer the exact phrase they typed as a click-to-add chip.
        push(primary, `${qualifierPretty} ${nounPretty}`);

        // 2. Interleave same-qualifier variants (Data Scientist, Data Engineer)
        // and same-noun variants (Business Analyst, Financial Analyst). Both
        // lists sourced from the FULL taxonomy (NOUNS_BY_QUALIFIER +
        // QUALIFIERS_BY_NOUN), not the narrow ADJACENT_ maps that produced
        // weird pairs like "Analytics Analyst".
        const sameQualifier: string[] = [];
        for (const n of NOUNS_BY_QUALIFIER[qualifier] ?? []) {
          if (n.toLowerCase() === noun) continue;
          sameQualifier.push(isBareNatural(n) ? n : `${qualifierPretty} ${n}`);
        }
        const sameNoun: string[] = [];
        for (const q of QUALIFIERS_BY_NOUN[noun] ?? []) {
          if (q.toLowerCase() === qualifier) continue;
          sameNoun.push(`${q} ${nounPretty}`);
        }
        const maxLen = Math.max(sameQualifier.length, sameNoun.length);
        for (let i = 0; i < maxLen; i++) {
          if (i < sameQualifier.length) push(primary, sameQualifier[i]);
          if (i < sameNoun.length) push(primary, sameNoun[i]);
        }

        push(tertiary, `Senior ${qualifierPretty} ${nounPretty}`);
      }
    }
    // Bare qualifier path — "project", "legal", "supply chain" etc. Prefer
    // BARE forms when the role noun is distinctive on its own (Foreman,
    // Solicitor, Site Manager); use QUALIFIED forms only for generic role
    // words (Manager, Analyst, Engineer). This matches how real job boards
    // actually title jobs — a construction "Foreman" job is titled Foreman,
    // not "Construction Foreman".
    if (bareQualifier && bareQualifier !== parsed?.noun) {
      const nouns = NOUNS_BY_QUALIFIER[bareQualifier] ?? [];
      const qualifierPretty = prettyPhrase(bareQualifier);
      for (const n of nouns) {
        if (isBareNatural(n)) {
          push(primary, n); // bare — real job title stands alone
        } else {
          push(primary, `${qualifierPretty} ${n}`); // qualified — Construction Manager etc.
        }
      }
    }
  }

  return [...primary, ...secondary, ...tertiary].slice(0, max);
}

// Explicit programme-style phrases the extractor treats as high-signal
// search terms even without a role noun. "graduate scheme" is a real query
// on Reed / Adzuna; "senior" alone is not (it matches the verb "to lead" in
// prose too easily, and seniority alone doesn't narrow the search).
const PROGRAMME_PHRASES: string[] = [
  "graduate scheme",
  "graduate programme",
  "graduate program",
  "graduate trainee",
  "trainee scheme",
  "trainee programme",
  "apprenticeship",
  "internship",
  "leadership programme",
  "leadership program",
];

// Best-effort search-term extraction from free text. Powers the "user typed
// a description but no keywords / titles" fallback path in the run pipeline.
// Never uses the search NAME — the name is user-facing identification, not
// a query string.
export function extractSearchTerms(description: string, max: number = 5): string[] {
  if (!description) return [];
  const words = tokeniseProse(description);

  // Pass 1 — explicit role phrases with a recognised qualifier, or bare
  // unambiguous role nouns ("analyst"). Rejects verb usage ("to lead") and
  // figures of speech ("potential lead").
  const rolePhrases = extractPhrasesFromProse(description);
  if (rolePhrases.length) return rolePhrases.slice(0, max);

  // Pass 2 — bare domain qualifier ("want a marketing role"). Expand to
  // common concrete titles for that domain. Verb-preceder guard prevents
  // "want to sales" or "used to marketing" style false matches.
  const foundQualifiers: string[] = [];
  const seenQ = new Set<string>();
  function addQ(q: string): void {
    const norm = normalise(q);
    if (!seenQ.has(norm)) {
      seenQ.add(norm);
      foundQualifiers.push(q);
    }
  }
  for (let i = 0; i < words.length; i++) {
    if (i > 0 && VERB_PRECEDERS.has(words[i - 1])) continue;
    if (i + 1 < words.length) {
      const two = `${words[i]} ${words[i + 1]}`;
      if (KNOWN_QUALIFIERS.has(two)) {
        addQ(two);
        i++;
        continue;
      }
    }
    if (KNOWN_QUALIFIERS.has(words[i])) addQ(words[i]);
  }
  if (foundQualifiers.length) {
    const out: string[] = [];
    for (const q of foundQualifiers.slice(0, 3)) {
      out.push(`${q} manager`);
      out.push(`${q} analyst`);
    }
    return out.slice(0, max);
  }

  // Pass 3 — programme phrases ("graduate scheme", "apprenticeship") only.
  // Seniority alone ("senior", "entry level") is intentionally NOT used as a
  // search term — too generic to narrow results and too easy to mis-match
  // against verbs / figures of speech. If we get here, the search falls
  // through to browse mode (filters drive the pull, no keyword).
  const lower = description.toLowerCase();
  const found: string[] = [];
  for (const p of PROGRAMME_PHRASES) {
    if (lower.includes(p) && !found.includes(p)) found.push(p);
  }
  if (found.length) return found.slice(0, max);

  return [];
}

