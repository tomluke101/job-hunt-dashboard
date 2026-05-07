// Master Profile — the user's canonical, sector-agnostic Profile.
//
// Generated once (or refreshed when source data changes), edited by the user,
// saved permanently. Every CV generation uses Master as the starting point
// and tailors it to the specific JD.

import { callAI } from "@/lib/ai-router";
import type { Provider } from "@/lib/ai-providers";
import { extractFactBase } from "./extract";
import { factsOfKind, type FactBase } from "./factbase";
import { scanProfile, buildFixGuidance, type BannedHit } from "./tailor";
import type { TailoredCV } from "./tailored-cv";

// ── Sector-invention scanner (Master-only, FactBase-aware) ────────────────────
//
// AI tends to invent grounding details for Sentence 1 ("at an independent e-commerce
// retailer", "at a fast-growing consumer brand") when the FactBase doesn't actually
// say what sector the candidate works in. This is a TRUTH CONTRACT violation.
// The scanner extracts the descriptor that follows "at a/an/the ..." in S1 and
// verifies every meaningful token appears somewhere in the FactBase text.

const SECTOR_DESCRIPTOR_NOUNS = [
  "retailer",
  "wholesaler",
  "distributor",
  "manufacturer",
  "consultancy",
  "consultant",
  "business",
  "company",
  "firm",
  "brand",
  "startup",
  "scaleup",
  "agency",
  "provider",
  "organisation",
  "organization",
  "charity",
  "operator",
  "broker",
  "dealer",
  "practice",
  "outfit",
  "venture",
  "enterprise",
  "group",
  "platform",
  "marketplace",
  "publisher",
  "studio",
  "workshop",
  "lab",
  "institute",
  "chain",
  "specialist",
  "operator",
  "developer",
  "supplier",
  "vendor",
  "merchant",
  "retail",
  "bank",
  "fund",
  "trust",
  "society",
];

// ONLY grammatical particles + obvious filler. Descriptive qualifiers
// ("independent", "boutique", "leading", "growing", "established", "private",
// "small", "European", etc.) are NOT stopwords — they are claims about the
// employer and must be grounded in the FactBase like everything else. AI loves
// to sneak these in as inventions.
const SECTOR_STOPWORDS = new Set([
  "a",
  "an",
  "the",
  "at",
  "in",
  "on",
  "of",
  "for",
  "with",
  "and",
  "or",
  "to",
  "as",
  "is",
  "by",
  "from",
  "this",
  "that",
]);

function tokensFromDescriptor(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9 -]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !SECTOR_STOPWORDS.has(t));
}

function extractSectorDescriptors(s1: string): string[] {
  // Match "at|for|with|within|inside|in|of a/an/the [adj]* NOUN" where NOUN is
  // one of the sector descriptor nouns. Capture up to ~6 words preceding the
  // noun. The preposition list is broad because AI substitutes "for" / "within"
  // when "at" is banned to dodge a previous flag.
  const out: string[] = [];
  const re = new RegExp(
    `\\b(?:at|for|with|within|inside|in|of)\\s+(?:an?|the)\\s+([\\w\\- ]{2,80}?)\\b(${SECTOR_DESCRIPTOR_NOUNS.join("|")})\\b`,
    "gi"
  );
  let m: RegExpExecArray | null;
  while ((m = re.exec(s1)) !== null) {
    out.push(`${m[1].trim()} ${m[2]}`.trim());
  }
  return out;
}

// Deterministic exclusion enforcement. Exclusions are passed as a HARD rule
// in the system prompt, but AI compliance with HARD rules is not 100%. This
// scanner catches any excluded phrase that slipped through — substring match,
// case-insensitive — so the rewrite loop or fallback can take it back out.
export function scanExcludedPhrases(args: {
  summary: string;
  exclusions: string[];
}): BannedHit[] {
  const hits: BannedHit[] = [];
  if (!args.summary || args.exclusions.length === 0) return hits;
  const summaryLower = args.summary.toLowerCase();
  for (const e of args.exclusions) {
    const needle = e.trim().toLowerCase();
    if (!needle) continue;
    if (summaryLower.includes(needle)) {
      hits.push({
        section: "Profile",
        phrase: `Profile contains the excluded phrase "${e}". Remove it entirely. The user has explicitly forbidden this in any Profile generation, regardless of JD relevance.`,
      });
    }
  }
  return hits;
}

export function scanProfileSectorInvention(args: {
  summary: string;
  factbaseText: string;
}): BannedHit[] {
  const hits: BannedHit[] = [];
  if (!args.summary) return hits;
  const firstSentence = args.summary.split(/(?<=[.!?])\s+/)[0] ?? "";
  const descriptors = extractSectorDescriptors(firstSentence);
  if (descriptors.length === 0) return hits;
  const fbLower = args.factbaseText.toLowerCase();
  for (const d of descriptors) {
    const tokens = tokensFromDescriptor(d);
    if (tokens.length === 0) continue;
    const ungrounded = tokens.filter((t) => !fbLower.includes(t));
    if (ungrounded.length > 0) {
      hits.push({
        section: "Profile",
        phrase: `S1 contains an invented sector descriptor "${d}" — the words [${ungrounded.join(", ")}] do not appear anywhere in the FactBase. Either remove the descriptor entirely (lead S1 with role + work scope only) or replace it with sector language that IS in the FactBase.`,
      });
    }
  }
  return hits;
}

export interface MasterProfileGenerationResult {
  summary?: string;
  warnings: string[];
  error?: string;
}

// Wizard answers, mirrored here so we don't import client types into lib.
// The shape exactly matches WizardContext in app/actions/cv-tailoring.ts.
export interface WizardContextLib {
  stage:
    | "working"
    | "self_employed"
    | "founder"
    | "student"
    | "between"
    | "returner"
    | "other"
    | null;
  jobTitle?: string;
  companyOrSector?: string;
  freelanceDiscipline?: string;
  freelanceYears?: string;
  freelanceSector?: string;
  businessName?: string;
  businessDoes?: string;
  businessFoundedYear?: string;
  degreeSubject?: string;
  university?: string;
  graduationYear?: string;
  lastJobTitle?: string;
  lastJobSector?: string;
  timeOut?: string;
  otherSituation?: string;
  achievement?: string;
  achievementScale?: string;
  achievementOutcome?: string;
  supportingAchievements?: string[];
  distinctive?: string;
  educationToInclude?: string;
  educationPlacement?: "lead" | "close" | "skip";
  anythingElse?: string;
}

// Build a sector-agnostic Profile from the FactBase. No JD — produces the user's
// strongest unconditional version of themselves, applying all the same rules
// (implied first person, scope-anchor in S2, distinctive S3, fact close).
export async function generateMasterProfileFromFactBase(opts: {
  cvId?: string;
  connectedProviders: Partial<Record<Provider, string>>;
  wizardContext?: WizardContextLib;
  exclusions?: string[];
}): Promise<MasterProfileGenerationResult> {
  const warnings: string[] = [];

  const fbResult = await extractFactBase({ cvId: opts.cvId });
  if (fbResult.error || !fbResult.factBase) {
    return { error: fbResult.error ?? "Could not load profile data.", warnings };
  }
  const fb = fbResult.factBase;
  warnings.push(...fb.warnings);

  const wizardText = opts.wizardContext ? serialiseWizardContext(opts.wizardContext) : "";

  if (
    factsOfKind(fb, "role").length === 0 &&
    factsOfKind(fb, "achievement").length === 0 &&
    !wizardText
  ) {
    return {
      error:
        "No work history or CV bullets to build a Master Profile from. Add Work History entries on the Profile page or upload a base CV.",
      warnings,
    };
  }

  const factbaseText = serialiseFactBaseForMaster(fb);
  // Truth-grounded text is the union of FactBase + wizard answers. Both are
  // treated as canonical for the sector-invention scanner so wizard-provided
  // sectors / employers don't get flagged as inventions.
  const groundedText = `${factbaseText}\n\n${wizardText}`.trim();
  const systemPrompt = buildMasterSystemPrompt(opts.exclusions ?? []);
  const userPrompt = `=== CANDIDATE FACTBASE ===
${factbaseText || "(empty — use the wizard answers below as primary input)"}

${wizardText ? `=== USER-PROVIDED CONTEXT (wizard answers — treat as truth) ===\n${wizardText}\n\n` : ""}=== TASK ===
Produce the candidate's Master Profile — the strongest, sector-agnostic version of themselves. No specific job description to tailor to. Apply ALL Profile rules. Return ONLY the JSON object: { "summary": string }.`;

  let summary: string | null = null;
  try {
    const result = await callAI({
      task: "cv-tailor",
      connectedProviders: opts.connectedProviders,
      systemPrompt,
      prompt: userPrompt,
    });
    summary = parseSummaryFromJSON(result.text);
  } catch (e) {
    console.error("[generateMasterProfile] AI failed:", e);
    return {
      error: e instanceof Error ? e.message : "AI call failed.",
      warnings,
    };
  }

  if (!summary) {
    return { error: "AI returned non-JSON output.", warnings };
  }

  // Run the same Profile scanners as the JD-tailored flow + verify-after-rewrite
  // loop. Wrap the Master string in a minimal TailoredCV stub so we can reuse
  // the existing scan/critic pipeline. Pass the COMBINED grounded text (factbase
  // + wizard answers) so the sector-invention scanner accepts wizard-supplied
  // sectors as grounded.
  summary = await runProfileScannersAndRewrite({
    summary,
    factbaseText: groundedText,
    factbaseFromFactBase: fb,
    connectedProviders: opts.connectedProviders,
    systemPrompt,
    isMaster: true,
    exclusions: opts.exclusions ?? [],
  });

  return { summary, warnings };
}

// Adapt an existing Master Profile to a specific JD. Preserves the user's
// voice + structure where possible; rewrites emphasis to surface JD-relevant
// signals from the FactBase.
export interface TailorMasterResult {
  tailored?: string;
  warnings: string[];
  error?: string;
}

export async function tailorMasterToJD(opts: {
  master: string;
  jdText: string;
  cvId?: string;
  companyName?: string;
  roleName?: string;
  exclusions?: string[];
  connectedProviders: Partial<Record<Provider, string>>;
}): Promise<TailorMasterResult> {
  const warnings: string[] = [];

  if (!opts.master || !opts.master.trim()) {
    return {
      error:
        "No Master Profile to adapt. Save your Master Profile first.",
      warnings,
    };
  }

  if (!opts.jdText || opts.jdText.trim().length < 30) {
    return {
      error:
        "Paste the job description first — it needs to be at least a paragraph.",
      warnings,
    };
  }

  // Run a CONSTRAINED adaptation. The model is forbidden from rewriting,
  // restructuring, or substituting any claim. Allowed changes are word-level
  // vocabulary swaps only, and only where the JD has clear domain-vocabulary
  // preference. After the AI runs, a deterministic entity-preservation check
  // verifies every named entity, credential, number, and acronym from the
  // Master survived — if any went missing, we drop the adaptation and return
  // the verbatim Master.
  const systemPrompt = buildAdaptSystemPrompt(opts.exclusions ?? []);
  const userPrompt = `=== JOB DESCRIPTION ===
${opts.jdText.trim()}

=== CANDIDATE'S MASTER PROFILE (preserve nearly verbatim — see system rules) ===
${opts.master}

${opts.companyName ? `Target company: ${opts.companyName}\n` : ""}${opts.roleName ? `Target role: ${opts.roleName}\n` : ""}
=== TASK ===
Identify if any words in the Master Profile have a JD-vocabulary equivalent that means the SAME thing. Produce a minimally-modified Profile. If no swaps are warranted, return the Master VERBATIM. Return ONLY the JSON object: { "summary": string }.`;

  let tailored: string | null = null;
  try {
    const result = await callAI({
      task: "cv-tailor",
      connectedProviders: opts.connectedProviders,
      systemPrompt,
      prompt: userPrompt,
    });
    tailored = parseSummaryFromJSON(result.text);
  } catch (e) {
    console.error("[tailorMasterToJD] AI failed:", e);
    return {
      error: e instanceof Error ? e.message : "AI call failed.",
      warnings,
    };
  }

  if (!tailored) {
    warnings.push("Adaptation returned non-JSON output — using your Master verbatim.");
    return { tailored: opts.master, warnings };
  }

  // Deterministic entity-preservation check. If the AI removed any named
  // entity / credential / number from the Master, reject the adaptation and
  // fall back to verbatim Master. Better to skip a JD-emphasis tweak than
  // to drop the user's chosen claims.
  const entityCheck = verifyEntitiesPreserved(opts.master, tailored);
  if (!entityCheck.preserved) {
    warnings.push(
      `Adaptation dropped ${entityCheck.missing.length} named claim${entityCheck.missing.length === 1 ? "" : "s"} from your Master — using your Master verbatim. Missing: ${entityCheck.missing.slice(0, 5).join(", ")}${entityCheck.missing.length > 5 ? "…" : ""}`
    );
    return { tailored: opts.master, warnings };
  }

  // Deterministic exclusion-rule enforcement. If the AI introduced any phrase
  // the user has excluded (whether it was in the original Master or not —
  // user might have JUST added a new exclusion), reject the adaptation.
  const exclusionViolations = scanExcludedPhrases({
    summary: tailored,
    exclusions: opts.exclusions ?? [],
  });
  if (exclusionViolations.length > 0) {
    const offenders = (opts.exclusions ?? [])
      .filter((e) => tailored!.toLowerCase().includes(e.trim().toLowerCase()))
      .slice(0, 3);
    warnings.push(
      `Adaptation contained excluded phrase${offenders.length === 1 ? "" : "s"} (${offenders.map((o) => `"${o}"`).join(", ")}) — using your Master verbatim instead.`
    );
    return { tailored: opts.master, warnings };
  }

  // Adaptation passed entity preservation. Return it.
  // Note: we deliberately DO NOT run the full scanner-rewrite loop here —
  // adaptations are meant to be minimal, and re-running 15 scanners on a
  // near-verbatim variant of an already-clean Master tends to push it
  // further from the user's saved wording than necessary.
  return { tailored, warnings };
}

// ── Constrained-adapt system prompt ─────────────────────────────────────────
// Used by the per-CV "Adapt to this JD" button. Hard rules forbid any
// rewriting beyond word-level vocabulary alignment.
function buildAdaptSystemPrompt(exclusions: string[]): string {
  const exclusionsBlock = exclusions.length > 0
    ? `\n\nUSER EXCLUSIONS (NEVER include these in the Profile, even if the Master mentions them):\n${exclusions.map((e) => `- ${e}`).join("\n")}\n`
    : "";

  return `You take a candidate's Master Profile and a specific JD, and produce a JSON object: { "summary": string } where summary is the Master Profile with vocabulary swaps applied to align with the JD's language — wherever a swap genuinely improves alignment WITHOUT changing meaning, scope, or claims.

YOUR JOB IS TO ACTIVELY LOOK FOR VOCABULARY SWAPS — not to play it safe by returning verbatim. If the JD uses "vendor management" and the Master uses "supplier management" for the same concept, swap. If the JD uses "leading procurement" and the Master uses "specialising in procurement", swap. Default to MAKING the swap when the JD has a clear preference. Default to verbatim ONLY when the Master's vocabulary already aligns OR when the JD's vocabulary describes a genuinely different concept (in which case a swap would mislead).

PROCESS (follow exactly):
1. Read the Master Profile carefully.
2. Read the JD. Identify its key vocabulary: action verbs, field terminology, role-descriptor language.
3. For EACH content word in the Master, ask: does the JD use a different word for the SAME concept? If yes → swap. If the concept differs → keep the Master's word.
4. Apply every justified swap. Then return the modified Profile.

ABSOLUTE RULES (every rule is hard — violation means the adaptation is rejected and the user's verbatim Master is used):

1. KEEP every named entity verbatim. This includes:
   - Company / employer names (Siemens DISW, Goldman Sachs, JLR, etc.)
   - Built systems / tools (ERP, supplier tracker, dashboard, Power BI, Airtable, etc.)
   - Institutions / universities (Birmingham City University, LSE, etc.)
   - Credentials and degree types (First-Class, BA, BSc, MA, MEng, MSc, MBA, PhD, etc.)
   - Numerical claims (2x revenue growth, 80%+, £40k, 12 suppliers, etc.)
   - Acronyms (3+ uppercase letters: ERP, BCU, DISW, MRP, SRM, etc.)
   - Hyphenated compound terms (First-Class, end-to-end, cross-functional, etc.)

2. KEEP every clause and sentence structure:
   - No reordering sentences
   - No merging clauses
   - No splitting sentences
   - No adding clauses
   - No removing clauses

3. KEEP every claim. Every distinct fact in the Master must appear in the adapted output, in the same sentence it lived in.

4. DO NOT add new claims, even if the JD asks for skills the candidate has elsewhere.
5. DO NOT remove claims, even if the JD doesn't care about them.
6. DO NOT substitute one named system for another (NEVER swap "ERP" for "supplier tracker", NEVER swap "Siemens" for "JLR").
7. DO NOT change a CONCEPT — only the WORD used to describe it. If the Master says "demand planning" (forecasting customer demand) and the JD says "materials planning" (MRP scheduling supply against demand), do NOT swap — these are different concepts. But if the Master says "supplier management" and the JD says "vendor management" — same concept, different word — DO swap.

CONCRETE SWAP EXAMPLES (you SHOULD apply these and equivalents when the JD uses one of the alternatives):

Action verbs (same concept, different word):
- "managing" ↔ "running" / "owning" / "leading" / "directing"
- "specialising in" ↔ "leading" / "owning" / "running"
- "co-designing" ↔ "co-developing" / "co-building" / "partnering on"
- "absorbing" → "managing" / "handling" (always swap "absorbing" — banned)
- "scaling" ↔ "growing" / "expanding"

Field vocabulary (same concept, different word):
- "supplier" ↔ "vendor" (when JD prefers one consistently)
- "supplier management" ↔ "vendor management" / "supplier relationships"
- "supplier performance" ↔ "vendor performance"
- "overseas supply base" ↔ "international supplier network" / "global suppliers"
- "purchase order" ↔ "PO" (when JD uses the abbreviation throughout)
- "purchasing" ↔ "procurement" (when JD prefers one)
- "inventory planning" ↔ "stock planning" (if JD uses "stock")
- "stakeholder reporting" ↔ "stakeholder engagement" (if same activity described differently)

Forbidden pseudo-swaps (different concept — DO NOT swap):
- "demand planning" ≠ "materials planning" (forecasting demand vs MRP scheduling supply)
- "demand planning" ≠ "inventory planning" (different functions)
- "supplier scorecard" ≠ "vendor risk assessment" (different artefacts)
- "ERP" ≠ "MRP" (different systems)
- "co-designed" ≠ "designed" (collaborative vs sole)

DECISION RULE: when uncertain whether a swap is "same concept different word" vs "different concept entirely", err on the side of KEEPING the Master's word. The cost of a false swap (misleading claim) is higher than the cost of a missed swap (slightly less JD-aligned vocabulary).

PROACTIVE BIAS: scan the entire JD for vocabulary that maps cleanly onto Master concepts. Apply ALL justified swaps in a single pass — don't stop after one. A well-adapted Profile typically has 1–4 swaps when JD vocabulary differs.

If after this analysis the Master's vocabulary truly already aligns (no JD word is a clearly-preferred alternative), return the Master VERBATIM. Be honest, not lazy.

UK ENGLISH: British spellings throughout (organise, specialise, analyse, optimise, programme, colour, etc.). Never American.

NO BANNED VOCABULARY: spearhead, leverage, orchestrate, championed, drove, pioneered, synergise, utilise, streamline, robust, seamless, cutting-edge, results-driven, passionate, dynamic, proven, demonstrated, hands-on, forward-thinking, fast-paced, world-class, best-in-class, value-add, absorbing.

NO em-dashes (—). NO tricolons. NO new banned phrases of any kind.${exclusionsBlock}

Return ONLY the JSON object: { "summary": string }.`;
}

// ── Deterministic entity-preservation check ────────────────────────────────
// Extracts every named entity / credential / acronym / numerical claim from
// the original Master and verifies all of them appear in the adapted text.
// If any are missing, the adaptation has dropped a claim and must be rejected.

function extractNamedEntities(text: string): string[] {
  const out = new Set<string>();

  // Multi-word capitalised phrases (2+ caps in sequence, 3+ chars per word).
  // Catches: "Siemens DISW", "Birmingham City University", "Project Coordinator",
  // "First-Class Business with Marketing BA" (each multi-word run separately).
  // Skip sentence-initial caps where they aren't proper nouns by requiring 2+ words.
  for (const m of text.matchAll(/\b[A-Z][a-zA-Z]{2,}(?:\s+[A-Z][a-zA-Z']{1,}){1,}\b/g)) {
    out.add(m[0]);
  }

  // Acronyms (3+ uppercase letters) — ERP, BCU, DISW, MRP, JLR, etc.
  for (const m of text.matchAll(/\b[A-Z]{3,}\b/g)) {
    out.add(m[0]);
  }

  // Common 2-letter credential abbreviations — BA, BSc, MA, MSc, MBA, etc.
  // Match only when used as a credential (followed by " from " / " in " / etc.,
  // or preceded by a degree class / subject).
  for (const m of text.matchAll(/\b(?:BA|BSc|BEng|MA|MSc|MEng|MBA|MFin|MPhil|PhD|ACA|ACCA|CFA|CIM|MRICS|FRICS)\b/g)) {
    out.add(m[0]);
  }

  // Numerical claims with units. 2x, 80%, £40k, 3 years, 12 suppliers, etc.
  // Capture the number+unit/word so it can be verified as a unit.
  for (const m of text.matchAll(/\b\d+(?:\.\d+)?\s*(?:x|%|\+|years?|months?|weeks?|days?|k|m|bn|million|billion)\b/gi)) {
    out.add(m[0].toLowerCase().replace(/\s+/g, " "));
  }
  // Currency-led numerical claims. £3.25, $40k, €1.2m, etc.
  for (const m of text.matchAll(/[£$€]\s*\d+(?:\.\d+)?\s*[a-z]?\b/gi)) {
    out.add(m[0].toLowerCase().replace(/\s+/g, ""));
  }

  // Hyphenated compound terms with a leading capital — "First-Class",
  // "End-to-End", "Top-of-Cohort". Catches credentials and named compounds.
  for (const m of text.matchAll(/\b[A-Z][a-z]+(?:-[A-Za-z]+)+\b/g)) {
    out.add(m[0]);
  }

  // CamelCase / mIxedCase tokens (uppercase letter not at position 0). Catches
  // tool/brand names like PowerBI, GitHub, OpenAI, eXtensible, BigQuery.
  for (const m of text.matchAll(/\b[A-Za-z]*[a-z][A-Z][A-Za-z]*\b/g)) {
    if (m[0].length >= 3) out.add(m[0]);
  }

  // Single-word brand allowlist. Common SaaS/tools that users mention by name
  // and the AI might quietly drop. Case-insensitive match against original.
  const SINGLE_WORD_BRANDS = [
    "Airtable", "Excel", "Salesforce", "Anthropic", "OpenAI", "Snowflake",
    "Tableau", "Figma", "Notion", "Slack", "Zoom", "GitHub", "GitLab",
    "Atlassian", "Coupa", "Ariba", "Jaegger", "Workday", "NetSuite",
    "HubSpot", "Stripe", "Shopify", "Mailchimp", "Substack", "Asana",
    "Monday", "Linear", "Looker", "Databricks", "Segment", "Mixpanel",
    "Amplitude", "Heap", "Hotjar", "Pendo", "Intercom", "Zendesk",
    "Mongo", "Postgres", "Redis", "Kafka", "Spark", "Hadoop",
    "Kubernetes", "Docker", "Terraform", "Ansible", "Jenkins",
    "Tally", "Xero", "QuickBooks", "Sage", "Pipedrive", "Klaviyo",
    "AWS", "Azure", "GCP", "Vercel", "Netlify", "Cloudflare",
    "Google", "Microsoft", "Oracle", "Adobe", "SAP", "Siemens",
  ];
  const textLower = text.toLowerCase();
  for (const brand of SINGLE_WORD_BRANDS) {
    const idx = textLower.indexOf(brand.toLowerCase());
    if (idx !== -1) {
      // Confirm word boundary on both sides.
      const before = idx === 0 || /\W/.test(text[idx - 1]);
      const after =
        idx + brand.length === text.length ||
        /\W/.test(text[idx + brand.length]);
      if (before && after) out.add(text.slice(idx, idx + brand.length));
    }
  }

  return Array.from(out);
}

export function verifyEntitiesPreserved(
  original: string,
  adapted: string
): { preserved: boolean; missing: string[] } {
  const entities = extractNamedEntities(original);
  if (entities.length === 0) return { preserved: true, missing: [] };
  const adaptedLower = adapted.toLowerCase().replace(/\s+/g, " ");
  const missing: string[] = [];
  for (const e of entities) {
    const needle = e.toLowerCase().replace(/\s+/g, " ");
    if (!adaptedLower.includes(needle)) missing.push(e);
  }
  return { preserved: missing.length === 0, missing };
}

// ── Verify-after-rewrite loop for Master / Master-tailored output ────────────
//
// Wraps the Profile string in a minimal TailoredCV stub so we can reuse the
// existing 15-scanner pipeline + critic-rewrite flow.

async function runProfileScannersAndRewrite(args: {
  summary: string;
  factbaseText: string;
  factbaseFromFactBase: FactBase;
  connectedProviders: Partial<Record<Provider, string>>;
  systemPrompt: string;
  isMaster: boolean;
  jdText?: string;
  exclusions?: string[];
}): Promise<string> {
  const { summary, factbaseText, factbaseFromFactBase, connectedProviders, systemPrompt, isMaster, jdText, exclusions = [] } = args;

  // Build a minimal TailoredCV stub for the scanners. Scanners only read
  // .summary and .roles[0].company for the brand-tier check. Everything else
  // can be empty.
  const buildStub = (s: string): TailoredCV => {
    const firstRole = factsOfKind(factbaseFromFactBase, "role")[0];
    return {
      contact: { name: "", email: null, phone: null, location: null, linkedin: null },
      summary: s,
      skills: [],
      roles: firstRole
        ? [
            {
              company: firstRole.company,
              title: firstRole.title,
              startDate: firstRole.startDate,
              endDate: firstRole.endDate,
              isCurrent: firstRole.isCurrent,
              location: firstRole.location ?? null,
              bullets: [],
            },
          ]
        : [],
      education: [],
      certifications: [],
      languages: [],
      interests: [],
      jdKeywords: [],
      gaps: [],
    };
  };

  let current = summary;
  const MAX_ATTEMPTS = 6;
  // Track which flagged issues are recurring across attempts. After attempt 3
  // we switch to a focused single-rule prompt — a stubborn rule keeps slipping
  // through because the model is busy juggling other rules. Forcing a
  // single-rule fix in plain English breaks the deadlock.
  const recurrenceCount = new Map<string, number>();

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const stub = buildStub(current);
    const flagged = [
      ...scanProfile(stub),
      ...scanProfileSectorInvention({ summary: current, factbaseText }),
      ...scanExcludedPhrases({ summary: current, exclusions }),
    ];
    if (flagged.length === 0) return current;

    // Bucket recurrences so we know which rule is being stubborn.
    for (const f of flagged) {
      const key = bucketIssue(f.phrase);
      recurrenceCount.set(key, (recurrenceCount.get(key) ?? 0) + 1);
    }

    let fixupPrompt: string;

    if (attempt < 3) {
      // Attempts 0-2: full multi-rule fix prompt with all flagged issues.
      const fixGuidance = buildFixGuidance(flagged, stub);
      const escalated = attempt >= 1
        ? `ATTEMPT ${attempt + 1} of ${MAX_ATTEMPTS} — the previous rewrite still failed. Be ruthless about applying every fix.\n\n`
        : "";
      fixupPrompt = `${escalated}Your previous Profile output failed the critic. Each flagged issue below comes with the EXACT fix to apply. Apply every fix.

FLAGGED ISSUES AND FIXES:
${fixGuidance}

${jdText ? `JOB DESCRIPTION:\n${jdText.trim()}\n\n` : ""}CANDIDATE FACTBASE (truth contract):
${factbaseText}

Previous (flawed) Profile:
${current}

Return ONLY a JSON object: { "summary": string }. The corrected Profile must follow ALL rules.`;
    } else {
      // Attempts 3-5: focus on the SINGLE most-recurring issue. Strip the
      // model's cognitive load so it can fix one thing without re-breaking
      // others. Lead with a one-rule plain-English directive.
      const sorted = Array.from(recurrenceCount.entries()).sort((a, b) => b[1] - a[1]);
      const stubbornKey = sorted[0]?.[0] ?? "";
      const stubbornFlag = flagged.find((f) => bucketIssue(f.phrase) === stubbornKey) ?? flagged[0];
      const fixGuidance = buildFixGuidance([stubbornFlag], stub);
      fixupPrompt = `FINAL ATTEMPT (${attempt + 1} of ${MAX_ATTEMPTS}). One rule keeps slipping through every rewrite. Fix ONLY this one rule. Leave the rest of the Profile alone if it already passes — your previous attempt was nearly correct.

THE ONE RULE TO FIX:
${fixGuidance}

CANDIDATE FACTBASE (truth contract — do not invent claims):
${factbaseText}

Previous Profile (fix only the one rule above; preserve everything else verbatim if possible):
${current}

Return ONLY a JSON object: { "summary": string }.`;
    }

    try {
      const result = await callAI({
        task: "cv-tailor",
        connectedProviders,
        systemPrompt,
        prompt: fixupPrompt,
      });
      const next = parseSummaryFromJSON(result.text);
      if (!next) return current; // rewrite failed to parse; keep what we have
      current = next;
    } catch (e) {
      console.error("[runProfileScannersAndRewrite] rewrite failed:", e);
      return current;
    }
  }
  // After all attempts, return whatever we have — better than blocking.
  void isMaster;
  return current;
}

// Bucket an issue phrase into a short stable key so we can count recurrences
// across attempts (e.g. all tricolon flags map to "tricolon").
function bucketIssue(phrase: string): string {
  const p = phrase.toLowerCase();
  if (/tricolon/.test(p)) return "tricolon";
  if (/em-dash/.test(p)) return "em-dash";
  if (/first-person pronoun/.test(p)) return "first-person";
  if (/third-person verb/.test(p)) return "third-person-verb";
  if (/structural hedge/.test(p)) return "structural-hedge";
  if (/sole\/ownership claim/.test(p)) return "anchor-leak";
  if (/scope anchor/.test(p)) return "scope-leak";
  if (/no outcome signal/.test(p)) return "no-outcome";
  if (/passive cv-speak|introducer verb/.test(p)) return "passive-close";
  if (/connective fluff|specialising in|focusing on/.test(p)) return "s1-fluff";
  if (/jammed into one sentence|action verbs jammed/.test(p)) return "multi-action";
  if (/invented sector descriptor/.test(p)) return "sector-invention";
  if (/no specific named item|s3 contains no named/.test(p)) return "s3-strength";
  if (/length is/.test(p)) return "length";
  if (/uniform length/.test(p)) return "variance";
  return "other";
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function parseSummaryFromJSON(raw: string): string | null {
  try {
    const trimmed = raw.trim();
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start === -1 || end === -1) return null;
    const obj = JSON.parse(trimmed.slice(start, end + 1)) as { summary?: string };
    if (!obj.summary || !obj.summary.trim()) return null;
    return obj.summary.trim();
  } catch {
    return null;
  }
}

function serialiseFactBaseForMaster(fb: FactBase): string {
  const lines: string[] = [];
  const contacts = factsOfKind(fb, "contact");
  if (contacts.length > 0) {
    lines.push("== Contact ==");
    for (const c of contacts) lines.push(`${cap(c.field)}: ${c.content}`);
    lines.push("");
  }

  const roles = factsOfKind(fb, "role");
  const achievements = factsOfKind(fb, "achievement");
  const skills = factsOfKind(fb, "skill");

  if (roles.length > 0) {
    lines.push("== Roles ==");
    for (const r of roles) {
      const dates = `${r.startDate || "?"} – ${r.isCurrent ? "Present" : r.endDate || "?"}`;
      lines.push(
        `[role] ${r.title} at ${r.company} (${dates}${r.location ? ", " + r.location : ""})`
      );
      if (r.summary) lines.push(`  Role summary: ${r.summary}`);
      const roleAchievements = achievements.filter((a) => a.roleId === r.id);
      if (roleAchievements.length > 0) {
        lines.push(`  Source achievements:`);
        for (const a of roleAchievements) lines.push(`    - ${a.content}`);
      }
      const roleSkills = skills.filter((s) => s.roleIds.includes(r.id));
      if (roleSkills.length > 0) {
        lines.push(`  Linked skills:`);
        for (const s of roleSkills) lines.push(`    - ${s.content}`);
      }
      lines.push("");
    }
  }

  const educations = factsOfKind(fb, "education");
  if (educations.length > 0) {
    lines.push("== Education ==");
    for (const e of educations) {
      lines.push(
        `  - ${e.qualification}, ${e.institution}${e.classification ? ` (${e.classification})` : ""}${e.startYear || e.endYear ? ` [${[e.startYear, e.endYear].filter(Boolean).join(" – ")}]` : ""}`
      );
      if (e.details) lines.push(`    Details: ${e.details}`);
    }
    lines.push("");
  }

  const generalSkills = skills.filter((s) => s.roleIds.length === 0);
  if (generalSkills.length > 0) {
    lines.push("== General skills ==");
    for (const s of generalSkills) lines.push(`  - ${s.content}`);
    lines.push("");
  }

  return lines.join("\n").trim();
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// Serialise the wizard answers as a structured, labelled block. Used both as
// truth-grounded prompt context AND as input to the sector-invention scanner
// (so wizard-supplied sectors don't get flagged as inventions).
function serialiseWizardContext(wc: WizardContextLib): string {
  const lines: string[] = [];
  if (wc.stage === "working") {
    if (wc.jobTitle) lines.push(`Current role: ${wc.jobTitle}`);
    if (wc.companyOrSector) lines.push(`Current employer / sector: ${wc.companyOrSector}`);
  } else if (wc.stage === "self_employed") {
    if (wc.freelanceDiscipline) lines.push(`Self-employed discipline: ${wc.freelanceDiscipline}`);
    if (wc.freelanceSector) lines.push(`Sector / typical clients: ${wc.freelanceSector}`);
    if (wc.freelanceYears) lines.push(`Time self-employed: ${wc.freelanceYears}`);
  } else if (wc.stage === "founder") {
    if (wc.businessName) lines.push(`Business name / role: ${wc.businessName}`);
    if (wc.businessDoes) lines.push(`What the business does: ${wc.businessDoes}`);
    if (wc.businessFoundedYear) lines.push(`Founded: ${wc.businessFoundedYear}`);
  } else if (wc.stage === "student") {
    if (wc.degreeSubject) lines.push(`Course / degree: ${wc.degreeSubject}`);
    if (wc.university) lines.push(`Institution: ${wc.university}`);
    if (wc.graduationYear) lines.push(`Year: ${wc.graduationYear}`);
  } else if (wc.stage === "between" || wc.stage === "returner") {
    if (wc.lastJobTitle) lines.push(`Most recent role: ${wc.lastJobTitle}`);
    if (wc.lastJobSector) lines.push(`Most recent sector: ${wc.lastJobSector}`);
    if (wc.timeOut) lines.push(`Time since last worked: ${wc.timeOut}`);
  } else if (wc.stage === "other") {
    if (wc.otherSituation) lines.push(`Current situation: ${wc.otherSituation}`);
  }

  if (wc.achievement) {
    let a = `Headline achievement: ${wc.achievement}`;
    if (wc.achievementScale) a += ` | scale: ${wc.achievementScale}`;
    if (wc.achievementOutcome) a += ` | outcome: ${wc.achievementOutcome}`;
    lines.push(a);
  }
  if (wc.supportingAchievements && wc.supportingAchievements.length > 0) {
    for (const s of wc.supportingAchievements) {
      lines.push(`Supporting achievement: ${s}`);
    }
  }
  if (wc.distinctive) lines.push(`Distinctive context: ${wc.distinctive}`);
  if (wc.educationToInclude) {
    const placement = wc.educationPlacement
      ? ` (placement preference: ${wc.educationPlacement})`
      : "";
    lines.push(`Education to include: ${wc.educationToInclude}${placement}`);
  }
  if (wc.anythingElse) lines.push(`Other context: ${wc.anythingElse}`);

  return lines.join("\n").trim();
}

// Master Profile system prompt — same Profile rules as the JD-tailored version
// but written for the canonical version. We import the rules text from tailor.ts
// to keep them in sync.
function buildMasterSystemPrompt(exclusions: string[] = []): string {
  const exclusionsBlock = exclusions.length > 0
    ? `\n\nUSER EXCLUSIONS (HARDEST RULE — never include these in the Profile, regardless of FactBase content or how relevant they seem):\n${exclusions.map((e) => `- ${e}`).join("\n")}\n`
    : "";

  return `You produce a UK CV "Profile" section — the 3-4 sentence summary at the top of a CV. The output is a JSON object: { "summary": string }.

Apply ALL of these rules. Every rule is hard.${exclusionsBlock}

UK ENGLISH (NON-NEGOTIABLE):
- British spelling throughout: organise, specialise, analyse, optimise, programme, colour, behaviour, fulfil, recognise, centre, favourite, labour.
- UK conventions: "First-Class" (degree class), "BA / BSc / MEng / MSc" (post-nominal letters), pound sterling for money.
- Never use American spellings like organize, specialize, analyze, color, behavior, etc.

LENGTH: 60-100 words, 3-4 sentences, paragraph not bullets.

VOICE — IMPLIED FIRST PERSON (NON-NEGOTIABLE):
- Never use "I", "I'm", "I've", "my", "me".
- Never use third-person verbs about the candidate at sentence start: "Produces…", "Holds…", "Brings…", "Manages…", "Owns…", "Runs…", "Analyses…", "Leads…", "Designs…", "Builds…" etc.
- Implied first person — state actions and facts directly.

STRUCTURE — STRICT SENTENCE-ROLE SEPARATION:
S1 = role + work breadth + sector context. NO scope anchor. NO sole/ownership claim.
S2 = the dominant scope anchor PAIRED with a specific named action that delivered it. The number/scale lives HERE only. Single-signal S2 is insufficient.
S3 = ONE distinctive ownership/breadth claim with a NAMED specific item (system/brand/project/tool/outcome/count). Generic scope phrases like "from X through to Y" or "end-to-end ownership" are insufficient.
S4 = close. Fact-anchored (degree+classification+university) OR named target. Never generic forward-looking aspiration.

ANCHORS-APPEAR-ONCE:
- Scope anchor (numbers/scale) lives in S2 only — NOT in S1, NOT in S3.
- Sole/ownership keywords ("sole", "only [role]", "founding") live in S3 only — NOT in S1, NOT in S2.
- Each claim has ONE home. No repetition across sentences.

EMPLOYER-NAME RULE: include current employer name in S1 only if brand-tier (FTSE 100, S&P 500, FAANG, MBB, Magic Circle, Big 4, household-name). Otherwise omit — employer lives in Experience section.

BRAND-TIER PRIOR-EMPLOYER RULE (NON-NEGOTIABLE): if the FactBase contains ANY brand-tier prior employer (FTSE 100, S&P 500, FAANG, MBB, Magic Circle, Big 4, household-name unicorn — e.g. Siemens, Goldman Sachs, McKinsey, JLR, PwC, Apple, Google, Stripe, Anthropic), you MUST surface that employer in the Profile. This is non-optional credibility signal that travels across applications. Place it where it fits — as a career-narrative bridge in S1 ("…building on a Project Coordinator placement at Siemens DISW") or as the close in S4 — but include it. Dropping a brand-tier prior employer for any reason is a critical omission.

S2 PAIRING RULE: S2 must contain BOTH (i) a scope anchor (£/$/€-figure, growth multiple, count of named entities, before/after delta) AND (ii) a specific named action (built/designed/launched a NAMED system, recovered a NAMED amount, switched a NAMED provider).

S3 STRENGTH RULE: S3 must contain a NAMED specific item — named system, named brand collaborator, named outcome, named count. Generic ownership/scope phrases ("end-to-end", "from purchase order through to delivery") are insufficient.

OUTCOME-SIGNAL RULE: S2 or S3 must contain at least one outcome anchor — £-amount, %-improvement, count, before/after delta, or outcome verb (recovered/saved/switched/cut/scaled/closed/shipped).

NO TRICOLONS in any sentence (no "X, Y, and Z" lists). Use 2 items max.
NO em-dashes. Use commas, full stops, or restructure.
NO opening adjective stack ("Dedicated, organised…").
NO closing aspiration ("seeking to leverage…", "in a dynamic environment…").

BANNED VOCABULARY: spearhead, leverage, orchestrate, championed, drove, pioneered, synergise, utilise, streamline, robust, seamless, cutting-edge, delve, embark, results-driven, passionate, dynamic, proven, demonstrated, hands-on, end-to-end (as adjective in S3), forward-thinking, fast-paced, fast-moving, innovative-environment, world-class, best-in-class, hit the ground running, value-add, in today's [X] world.

TRUTH CONTRACT: every claim must trace to the FactBase. No inventing metrics, scopes, tools, brands.

NO FALSE CAUSAL LINKS (HARD):
The Profile must not invent cause-and-effect chains by linking two unrelated FactBase rows with "by", "through", "via", or "after".
- Each FactBase row is its own claim. If row A says the candidate scaled the function through 2x revenue growth (and lists what they MANAGED during that growth), and row B says they switched logistics providers (with no link to growth), you must NOT write "Scaled the function through 2x revenue growth BY switching logistics providers". The growth and the switch are two separate events.
- Specifically banned patterns: "Scaled X by [unrelated action]", "Drove X through [unrelated action]", "Achieved X by [unrelated action]" where the action is not present IN THE SAME FactBase row as the scale claim.
- Use the action that the FactBase actually attaches to the scale. If row A says "scaled through 2x growth, managing increased complexity, higher PO volumes, wider supplier base", S2 should pair the 2x with "absorbing higher PO volumes" or "managing wider supplier base" — words from THE SAME ROW.
- If you want to mention the unrelated action (e.g. logistics switch), put it in S3 as a separate distinctive claim, not joined to S2's scope anchor.

SOLE-VS-COLLABORATIVE ATTRIBUTION (HARD):
Look at the FactBase wording carefully before claiming "sole", "built from scratch", "designed alone", "single-handed".
- If a row says "Helped to design", "Collaborated with [X] to build", "Partnered with [Y] on", "Worked alongside [Z]" — the achievement is COLLABORATIVE. NEVER claim "sole architect", "sole builder", "designed from scratch alone" for that work.
- Only claim "sole" / "built from scratch" / "designed from the ground up" when a FactBase row explicitly states the candidate did it alone, OR uses a first-person singular ("I designed and built X" with no other party named).
- If you have TWO FactBase rows about TWO DIFFERENT systems — one solo, one collaborative — keep them attached to the right system. Do not transfer the "sole" claim from the solo system onto the collaborative one.
- Acceptable wording for collaborative work: "co-designed", "partnered with [role] to design", "contributed to the design of", "helped build".

NO GENERALISATION DRIFT:
- Don't broaden FactBase scope claims. If a row says "supplier scorecard for our overseas supply base", do NOT write "global supplier risk framework". Stay within the wording of the row.
- Don't promote scope. If FactBase says the candidate is a Supply Chain Analyst, do NOT write "Senior Supply Chain Manager". If FactBase says small business / startup, do NOT write "global enterprise" or "leading brand".
- Acceptable to compress wording (paraphrase). Not acceptable to inflate it.

IDENTITY ANCHORING (HARD): the Master Profile must lead with the candidate's CURRENT professional identity (most recent role / current employer's sector). NEVER mash up current and previous role titles into one identity claim ("Supply Chain Analyst and Project Coordinator" is BANNED — pick the current role only). NEVER blend sectors from current + previous employers into one statement ("e-commerce and enterprise software" when only the previous job was enterprise software is BANNED — use the current sector only). Previous roles belong in the Experience section of the CV, not the Profile.

NO SECTOR INVENTION (HARDEST RULE — TRUTH CONTRACT):
- If the FactBase does NOT explicitly state the candidate's employer's sector or industry, do NOT invent one.
- Specifically banned: "independent e-commerce retailer", "fast-growing startup", "established consumer brand", "boutique consultancy", "leading SME", or any other descriptor of the employer that is not in the FactBase.
- If sector is unknown, lead S1 with role + work scope only — e.g. "Supply Chain Analyst working across procurement and supplier performance to keep operations running efficiently." NO sector clause.
- If the FactBase says "Self-employed (D2C skincare)" the sector IS "D2C skincare" — that's allowed. If it just says a company name with no sector, the sector is UNKNOWN — omit it.
- Same rule applies to company size, geography, funding stage, ownership structure: if the FactBase doesn't say it, you don't say it.

The Master Profile (no JD context) leans on the candidate's strongest UNIVERSAL evidence — the dominant scope anchor and the most distinctive named achievement, both of which travel across applications.

PROHIBITED STRUCTURES (you have produced these before — never again):
- "during a period of Nx revenue growth" / "through a period of 2x growth" — wedges the anchor as a subordinate clause. Lead S2 with the anchor as the SUBJECT: "Scaled the supply chain through 2x revenue growth, switching logistics partners after analysing courier performance data."
- Three actions jammed into S2 ("Scaled X and switched Y, cutting Z") — pick ONE strong action and move others to S3.
- "Awarded a First-Class … from …" — passive CV-speak. Lead with the degree itself: "First-Class Business with Marketing BA from Birmingham City University, top of the cohort."
- "specialising in" / "focusing on" / "dedicated to" as S1 connective tissue — fluff. State scope plainly.
- Adjectives describing the employer that aren't in the FactBase: "independent", "boutique", "leading", "fast-growing", "established", "private". If the FactBase doesn't say it, you don't say it.

CONCRETE BAD-OUTPUT EXAMPLES (these shapes are FORBIDDEN — never produce anything like them):

BAD #1: "Senior auditor at an independent advisory firm, specialising in assurance and reporting across a portfolio of mid-market clients. Owned audit files and drafted partner-review packs during a period of 30% portfolio growth, cutting review cycles through workpaper standardisation. Built a bespoke variance dashboard from scratch, replacing manual reconciliations and recovering missed adjustments via an automated tickmark tracker. Awarded a First-Class BSc Accounting from a Russell Group university, finishing top of the cohort."

Why it's bad: (1) "independent advisory firm" — "independent" is invented if not in the FactBase. (2) "specialising in" is fluff. (3) "during a period of 30% portfolio growth" wedges the anchor as a subordinate clause. (4) S2 jams three actions ("Owned X and drafted Y, cutting Z"). (5) S3 jams two unrelated outcomes. (6) "Awarded a" is passive CV-speak.

BAD #2: "Marketing analyst working across content, performance and brand within a scaling D2C business. Supported 2x audience growth by managing higher campaign volumes and a wider channel mix during a sustained period of increased operational complexity. Built a bespoke attribution dashboard from scratch and a campaign performance tracker that surfaced wasted spend and guides weekly budget planning. Graduated with a First-Class BSc Marketing from a Russell Group university, finishing top of the cohort."

Why it's bad: (1) S1 "content, performance and brand" is a TRICOLON. (2) "scaling D2C business" — "scaling" is invented if not in the FactBase. (3) S2 leads with passive "Supported 2x growth by managing X and Y" — anchor wedged. (4) "during a sustained period of increased operational complexity" is a hedge variant — "sustained" doesn't save it. (5) S3 jams two named systems ("attribution dashboard AND campaign performance tracker") with two outcomes ("surfaced spend AND guides planning"). (6) "Graduated with a" is passive CV-speak — same family as "Awarded a".

CORRECTED SHAPE (the kind of structure to aim for, not the words to copy):
"Senior auditor at [employer], owning assurance and reporting across the firm's mid-market portfolio. Scaled the audit function through 30% portfolio growth, drafting the standardised workpaper template that cut review cycles. Sole reviewer of partner-pack quality, having built the bespoke variance dashboard now used to surface missed adjustments before sign-off. First-Class BSc Accounting from a Russell Group university, top of the cohort."

(4 sentences, ~70 words, scope anchor in S2 only as the SUBJECT of the verb, sole/ownership in S3 only, ONE named built system in S3, fact close in S4 with the qualification as the SUBJECT of the sentence.)

Return ONLY the JSON object.`;
}
