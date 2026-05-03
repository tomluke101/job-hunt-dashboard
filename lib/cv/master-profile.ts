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
  // Match "at a/an/the ... NOUN" where NOUN is one of the sector descriptor nouns.
  // Capture up to ~6 words preceding the noun.
  const out: string[] = [];
  const re = new RegExp(
    `\\bat\\s+(?:an?|the)\\s+([\\w\\- ]{2,80}?)\\b(${SECTOR_DESCRIPTOR_NOUNS.join("|")})\\b`,
    "gi"
  );
  let m: RegExpExecArray | null;
  while ((m = re.exec(s1)) !== null) {
    out.push(`${m[1].trim()} ${m[2]}`.trim());
  }
  return out;
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

// Build a sector-agnostic Profile from the FactBase. No JD — produces the user's
// strongest unconditional version of themselves, applying all the same rules
// (implied first person, scope-anchor in S2, distinctive S3, fact close).
export async function generateMasterProfileFromFactBase(opts: {
  cvId?: string;
  connectedProviders: Partial<Record<Provider, string>>;
}): Promise<MasterProfileGenerationResult> {
  const warnings: string[] = [];

  const fbResult = await extractFactBase({ cvId: opts.cvId });
  if (fbResult.error || !fbResult.factBase) {
    return { error: fbResult.error ?? "Could not load profile data.", warnings };
  }
  const fb = fbResult.factBase;
  warnings.push(...fb.warnings);

  if (
    factsOfKind(fb, "role").length === 0 &&
    factsOfKind(fb, "achievement").length === 0
  ) {
    return {
      error:
        "No work history or CV bullets to build a Master Profile from. Add Work History entries on the Profile page or upload a base CV.",
      warnings,
    };
  }

  const factbaseText = serialiseFactBaseForMaster(fb);
  const systemPrompt = buildMasterSystemPrompt();
  const userPrompt = `=== CANDIDATE FACTBASE ===
${factbaseText}

=== TASK ===
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
  // the existing scan/critic pipeline.
  summary = await runProfileScannersAndRewrite({
    summary,
    factbaseText,
    factbaseFromFactBase: fb,
    connectedProviders: opts.connectedProviders,
    systemPrompt,
    isMaster: true,
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
  connectedProviders: Partial<Record<Provider, string>>;
}): Promise<TailorMasterResult> {
  const warnings: string[] = [];

  if (!opts.jdText || opts.jdText.trim().length < 30) {
    return {
      error:
        "Paste the job description first — it needs to be at least a paragraph.",
      warnings,
    };
  }

  const fbResult = await extractFactBase({ cvId: opts.cvId });
  if (fbResult.error || !fbResult.factBase) {
    return {
      error: fbResult.error ?? "Could not load profile data.",
      warnings,
    };
  }
  const fb = fbResult.factBase;
  warnings.push(...fb.warnings);

  const factbaseText = serialiseFactBaseForMaster(fb);
  const systemPrompt = buildMasterSystemPrompt();
  const userPrompt = `=== JOB DESCRIPTION ===
${opts.jdText.trim()}

=== CANDIDATE'S MASTER PROFILE (preserve voice; adjust emphasis to the JD) ===
${opts.master}

=== CANDIDATE FACTBASE (truth contract — every claim must trace here) ===
${factbaseText}

${opts.companyName ? `Target company: ${opts.companyName}\n` : ""}${opts.roleName ? `Target role: ${opts.roleName}\n` : ""}

=== TASK ===
Adapt the Master Profile to this specific JD. Keep the user's voice and structure where possible. Surface JD-relevant emphasis from the FactBase. Apply ALL Profile rules. Return ONLY the JSON object: { "summary": string }.`;

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
    return { error: "AI returned non-JSON output.", warnings };
  }

  // Run scanners + rewrite loop on the tailored output too
  tailored = await runProfileScannersAndRewrite({
    summary: tailored,
    factbaseText,
    factbaseFromFactBase: fb,
    connectedProviders: opts.connectedProviders,
    systemPrompt,
    isMaster: false,
    jdText: opts.jdText,
  });

  return { tailored, warnings };
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
}): Promise<string> {
  const { summary, factbaseText, factbaseFromFactBase, connectedProviders, systemPrompt, isMaster, jdText } = args;

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
  for (let attempt = 0; attempt < 2; attempt++) {
    const stub = buildStub(current);
    const flagged = [
      ...scanProfile(stub),
      ...scanProfileSectorInvention({ summary: current, factbaseText }),
    ];
    if (flagged.length === 0) return current;

    const fixGuidance = buildFixGuidance(flagged, stub);
    const escalated = attempt >= 1
      ? "THIS IS THE SECOND REWRITE ATTEMPT — the previous rewrite still failed. Be ruthless about applying every fix.\n\n"
      : "";

    const fixupPrompt = `${escalated}Your previous Profile output failed the critic. Each flagged issue below comes with the EXACT fix to apply. Apply every fix.

FLAGGED ISSUES AND FIXES:
${fixGuidance}

${jdText ? `JOB DESCRIPTION:\n${jdText.trim()}\n\n` : ""}CANDIDATE FACTBASE (truth contract):
${factbaseText}

Previous (flawed) Profile:
${current}

Return ONLY a JSON object: { "summary": string }. The corrected Profile must follow ALL rules.`;

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
  // After 2 attempts, return whatever we have — better than blocking.
  void isMaster;
  return current;
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

// Master Profile system prompt — same Profile rules as the JD-tailored version
// but written for the canonical version. We import the rules text from tailor.ts
// to keep them in sync.
function buildMasterSystemPrompt(): string {
  return `You produce a UK CV "Profile" section — the 3-4 sentence summary at the top of a CV. The output is a JSON object: { "summary": string }.

Apply ALL of these rules. Every rule is hard.

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

S2 PAIRING RULE: S2 must contain BOTH (i) a scope anchor (£/$/€-figure, growth multiple, count of named entities, before/after delta) AND (ii) a specific named action (built/designed/launched a NAMED system, recovered a NAMED amount, switched a NAMED provider).

S3 STRENGTH RULE: S3 must contain a NAMED specific item — named system, named brand collaborator, named outcome, named count. Generic ownership/scope phrases ("end-to-end", "from purchase order through to delivery") are insufficient.

OUTCOME-SIGNAL RULE: S2 or S3 must contain at least one outcome anchor — £-amount, %-improvement, count, before/after delta, or outcome verb (recovered/saved/switched/cut/scaled/closed/shipped).

NO TRICOLONS in any sentence (no "X, Y, and Z" lists). Use 2 items max.
NO em-dashes. Use commas, full stops, or restructure.
NO opening adjective stack ("Dedicated, organised…").
NO closing aspiration ("seeking to leverage…", "in a dynamic environment…").

BANNED VOCABULARY: spearhead, leverage, orchestrate, championed, drove, pioneered, synergise, utilise, streamline, robust, seamless, cutting-edge, delve, embark, results-driven, passionate, dynamic, proven, demonstrated, hands-on, end-to-end (as adjective in S3), forward-thinking, fast-paced, fast-moving, innovative-environment, world-class, best-in-class, hit the ground running, value-add, in today's [X] world.

TRUTH CONTRACT: every claim must trace to the FactBase. No inventing metrics, scopes, tools, brands.

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

CONCRETE BAD-OUTPUT EXAMPLE (this shape is FORBIDDEN — never produce anything like it):
"Senior auditor at an independent advisory firm, specialising in assurance and reporting across a portfolio of mid-market clients. Owned audit files and drafted partner-review packs during a period of 30% portfolio growth, cutting review cycles through workpaper standardisation. Built a bespoke variance dashboard from scratch, replacing manual reconciliations and recovering missed adjustments via an automated tickmark tracker. Awarded a First-Class BSc Accounting from a Russell Group university, finishing top of the cohort."

Why that example is bad: (1) "independent advisory firm" is invented if the FactBase doesn't say "independent". (2) "specialising in" is fluff. (3) "during a period of 30% portfolio growth" is a structural hedge — anchor wedged into a subordinate clause. (4) S2 jams three actions ("Owned X and drafted Y, cutting Z"). (5) S3 jams two unrelated outcomes ("replacing X and recovering Y via Z"). (6) S4 opens with passive "Awarded a".

CORRECTED SHAPE (the kind of structure to aim for, not the words to copy):
"Senior auditor at [employer], owning assurance and reporting across the firm's mid-market portfolio. Scaled the audit function through 30% portfolio growth, drafting the standardised workpaper template that cut review cycles. Sole reviewer of partner-pack quality, having built the bespoke variance dashboard now used to surface missed adjustments before sign-off. First-Class BSc Accounting from a Russell Group university, top of the cohort."

(That's 4 sentences, ~70 words, scope anchor in S2 only, sole/ownership in S3 only, named built system in S3, fact close in S4. Adapt the SHAPE; do not copy the words. Use the candidate's actual data.)

Return ONLY the JSON object.`;
}
