import { callAI } from "@/lib/ai-router";
import { getApiKeyValues } from "@/app/actions/api-keys";
import { extractFactBase } from "./extract";
import {
  AchievementFact,
  CertificationFact,
  ContactFact,
  EducationFact,
  Fact,
  FactBase,
  factsOfKind,
  InterestFact,
  LanguageFact,
  RoleFact,
  SkillFact,
  SummaryFact,
} from "./factbase";
import { TailoredCV, TailoredContact } from "./tailored-cv";

export interface TailorInput {
  jdText: string;
  cvId?: string;
  companyName?: string;
  roleName?: string;
}

export interface RefineInput extends TailorInput {
  previousCV: TailoredCV;
  instruction: string;
}

export interface TailorResult {
  tailoredCV?: TailoredCV;
  error?: string;
  warnings: string[];
  jdKeywords?: string[];
  gaps?: string[];
}

export async function tailorCV(input: TailorInput): Promise<TailorResult> {
  const warnings: string[] = [];

  if (!input.jdText || input.jdText.trim().length < 30) {
    return {
      error: "Paste the job description first — it needs to be at least a paragraph for the tailoring to work.",
      warnings,
    };
  }

  const fbResult = await extractFactBase({ cvId: input.cvId });
  if (fbResult.error || !fbResult.factBase) {
    return { error: fbResult.error ?? "Could not load your profile data.", warnings };
  }
  const fb = fbResult.factBase;
  warnings.push(...fb.warnings);

  if (factsOfKind(fb, "role").length === 0 && factsOfKind(fb, "achievement").length === 0) {
    return {
      error:
        "No work history or CV bullets to tailor from. Add Work History entries on the Profile page, or upload a base CV.",
      warnings,
    };
  }

  const keys = await getApiKeyValues();
  if (Object.keys(keys).length === 0) {
    return { error: "No AI provider connected. Add an API key in Settings.", warnings };
  }

  const factbaseText = serialiseFactBase(fb);

  const systemPrompt = buildSystemPrompt();
  const userPrompt = buildUserPrompt({
    factbaseText,
    jdText: input.jdText,
    companyName: input.companyName,
    roleName: input.roleName,
  });

  let raw: string;
  try {
    const result = await callAI({
      task: "cv-tailor",
      connectedProviders: keys,
      systemPrompt,
      prompt: userPrompt,
    });
    raw = result.text;
  } catch (e) {
    console.error("[tailorCV] AI call failed:", e);
    return {
      error: e instanceof Error ? e.message : "AI call failed. Check your API key.",
      warnings,
    };
  }

  const parsed = parseTailoredCV(raw);
  if (!parsed) {
    return {
      error: "The AI returned an output we couldn't parse. Try again.",
      warnings,
    };
  }

  const sanitised = sanitiseTailoredCV(parsed, fb);

  // Post-process critic: scan for banned phrases / patterns and surface as warnings.
  // If any are found, make one targeted AI call to rewrite the offenders.
  const flagged = scanBannedPhrases(sanitised);
  if (flagged.length > 0) {
    try {
      const fixed = await rewriteOffendingSections({
        cv: sanitised,
        flagged,
        jdText: input.jdText,
        factbaseText,
        connectedProviders: keys,
      });
      if (fixed) {
        return {
          tailoredCV: fixed,
          warnings,
          jdKeywords: fixed.jdKeywords,
          gaps: fixed.gaps,
        };
      }
    } catch (e) {
      console.error("[tailorCV] critic rewrite failed:", e);
    }
    warnings.push(
      `Critic flagged ${flagged.length} AI-tell phrase${flagged.length === 1 ? "" : "s"} that auto-rewrite couldn't fix. Click "Tailor CV" again to regenerate.`
    );
  }

  return {
    tailoredCV: sanitised,
    warnings,
    jdKeywords: sanitised.jdKeywords,
    gaps: sanitised.gaps,
  };
}

// ── Refine: take the previous output + a natural-language instruction ────────

export async function refineTailoredCV(input: RefineInput): Promise<TailorResult> {
  const warnings: string[] = [];

  if (!input.instruction || !input.instruction.trim()) {
    return { error: "Tell me what to change first.", warnings };
  }

  const fbResult = await extractFactBase({ cvId: input.cvId });
  if (fbResult.error || !fbResult.factBase) {
    return { error: fbResult.error ?? "Could not load your profile data.", warnings };
  }
  const fb = fbResult.factBase;
  warnings.push(...fb.warnings);

  const keys = await getApiKeyValues();
  if (Object.keys(keys).length === 0) {
    return { error: "No AI provider connected. Add an API key in Settings.", warnings };
  }

  const factbaseText = serialiseFactBase(fb);
  const systemPrompt = buildSystemPrompt();
  const userPrompt = `${
    [input.companyName && `Target company: ${input.companyName}`, input.roleName && `Target role: ${input.roleName}`]
      .filter(Boolean)
      .join("\n") + "\n\n"
  }=== JOB DESCRIPTION ===
${input.jdText.trim()}

=== CANDIDATE FACTBASE ===
${factbaseText}

=== PREVIOUS OUTPUT (rewrite this, do not abandon what works) ===
${JSON.stringify(input.previousCV)}

=== USER REFINEMENT INSTRUCTION ===
${input.instruction.trim()}

=== TASK ===
Apply the user's instruction to the previous output. Keep everything that wasn't called out. Maintain the Truth Contract — every claim still traces to the FactBase. Apply ALL system-prompt rules: banned phrases, no JD echo, no forward-looking aspiration in Profile, skill items 1-3 words, categorised skills, etc. Return the FULL updated TailoredCV JSON.

Return ONLY the JSON object.`;

  let raw: string;
  try {
    const result = await callAI({
      task: "cv-tailor",
      connectedProviders: keys,
      systemPrompt,
      prompt: userPrompt,
    });
    raw = result.text;
  } catch (e) {
    console.error("[refineTailoredCV] AI call failed:", e);
    return { error: e instanceof Error ? e.message : "AI call failed.", warnings };
  }

  const parsed = parseTailoredCV(raw);
  if (!parsed) {
    return { error: "The AI returned an output we couldn't parse. Try again.", warnings };
  }
  const sanitised = sanitiseTailoredCV(parsed, fb);

  const flagged = scanBannedPhrases(sanitised);
  if (flagged.length > 0) {
    try {
      const fixed = await rewriteOffendingSections({
        cv: sanitised,
        flagged,
        jdText: input.jdText,
        factbaseText,
        connectedProviders: keys,
      });
      if (fixed) {
        return {
          tailoredCV: fixed,
          warnings,
          jdKeywords: fixed.jdKeywords,
          gaps: fixed.gaps,
        };
      }
    } catch (e) {
      console.error("[refineTailoredCV] critic rewrite failed:", e);
    }
    warnings.push(
      `Critic flagged ${flagged.length} AI-tell phrase${flagged.length === 1 ? "" : "s"} that auto-rewrite couldn't fix.`
    );
  }

  return {
    tailoredCV: sanitised,
    warnings,
    jdKeywords: sanitised.jdKeywords,
    gaps: sanitised.gaps,
  };
}

// ── Banned-phrase critic ──────────────────────────────────────────────────────

interface BannedHit {
  section: string;
  phrase: string;
}

const BANNED_REGEX: Array<[string, RegExp]> = [
  ["fast-moving X environment", /fast[- ]moving[^.,;]{0,40}environment/gi],
  ["fast-paced environment", /fast[- ]paced environment/gi],
  ["uninterrupted X", /\buninterrupted\b/gi],
  // 'translating' + nearby data noun (catches "translating complex datasets",
  // "translating data into actionable insight", etc.)
  ["translating data/datasets", /\btranslat(?:ing|e)\b[^.;,\n]{0,40}\b(?:data|dataset|datasets|information|insight|insights|metrics|figures|numbers)\b/gi],
  ["actionable information / insight", /\bactionable (?:information|insight|insights|business intelligence)\b/gi],
  ["concise business information", /\bconcise business (?:information|intelligence)\b/gi],
  ["complex datasets into", /\bcomplex datasets? into\b/gi],
  ["timely corrective action", /timely corrective action/gi],
  ["budget-conscious", /budget[- ]conscious/gi],
  ["high-footfall", /high[- ]footfall/gi],
  ["results-driven", /results[- ]driven/gi],
  ["proven track record", /proven track record/gi],
  ["demonstrated ability", /demonstrated ability/gi],
  ["spearheaded", /\bspearheaded?\b/gi],
  ["leveraged", /\bleverag(?:ed|e|ing)\b/gi],
  ["orchestrated", /\borchestrated?\b/gi],
  ["championed", /\bchampioned?\b/gi],
  ["pioneered", /\bpioneered?\b/gi],
  ["forward-looking aspiration", /\b(?:looking to (?:bring|apply|leverage|contribute)|seeks to leverage|eager to (?:contribute|apply))\b/gi],
  ["best-in-class / world-class", /\b(?:best[- ]in[- ]class|world[- ]class)\b/gi],
  ["cross-functional excellence", /cross[- ]functional excellence/gi],
  ["value-add", /\bvalue[- ]add\b/gi],
  ["hits the ground running", /hits the ground running/gi],
  ["under pressure cliché", /\b(?:thrives|excels|performs) under pressure\b/gi],
  // "successfully recovered" / "successfully delivered" — the "successfully"
  // adverb is filler that always gets stripped from polished CVs.
  ["successfully [verb] filler", /\bsuccessfully (?:delivered|recovered|implemented|launched|completed|managed|achieved)\b/gi],
];

function scanText(label: string, text: string, hits: BannedHit[]): void {
  if (!text) return;
  for (const [name, re] of BANNED_REGEX) {
    re.lastIndex = 0;
    if (re.test(text)) {
      hits.push({ section: label, phrase: name });
    }
  }
}

function scanBannedPhrases(cv: TailoredCV): BannedHit[] {
  const hits: BannedHit[] = [];
  scanText("Profile", cv.summary, hits);
  for (let i = 0; i < cv.roles.length; i++) {
    const r = cv.roles[i];
    for (let j = 0; j < r.bullets.length; j++) {
      scanText(`Experience: ${r.title} bullet ${j + 1}`, r.bullets[j], hits);
    }
  }
  for (const g of cv.skills) {
    for (const item of g.items) scanText(`Key Skills: ${g.category}`, item, hits);
  }
  for (const e of cv.education) {
    if (e.details) scanText(`Education: ${e.qualification}`, e.details, hits);
  }
  return hits;
}

// ── Targeted rewrite of offending sections ────────────────────────────────────

async function rewriteOffendingSections(args: {
  cv: TailoredCV;
  flagged: BannedHit[];
  jdText: string;
  factbaseText: string;
  connectedProviders: Partial<Record<string, string>>;
}): Promise<TailoredCV | null> {
  const { cv, flagged, jdText, factbaseText, connectedProviders } = args;
  const flaggedList = flagged.map((f) => `  - [${f.section}] phrase: "${f.phrase}"`).join("\n");

  const fixupPrompt = `Your previous CV output contained banned phrases that scream AI-written. The flagged offenders:

${flaggedList}

Rewrite the ENTIRE CV JSON, removing those phrases and any close paraphrases. Apply ALL the rules from the system prompt: no banned phrases, no JD echo, no forward-looking aspiration in Profile, skill items 1-3 words, no parentheticals in skills, no "in today's [X] world" patterns, no buzz adjectives, no aspirational closings.

Keep all factual content and the Truth Contract intact — every claim must still trace to the FactBase. Return the FULL TailoredCV JSON object, not a diff.

Previous (flawed) output:
${JSON.stringify(cv)}

JOB DESCRIPTION:
${jdText.trim()}

CANDIDATE FACTBASE:
${factbaseText}

Return ONLY the corrected JSON.`;

  const result = await callAI({
    task: "cv-tailor",
    connectedProviders: connectedProviders as Partial<Record<import("@/lib/ai-providers").Provider, string>>,
    systemPrompt: buildSystemPrompt(),
    prompt: fixupPrompt,
  });
  const reparsed = parseTailoredCV(result.text);
  if (!reparsed) return null;
  // Build a minimal FactBase shape for sanitising — we only use it for contact fallback,
  // and the existing CV already has resolved contacts, so reuse them.
  const stub: FactBase = {
    userId: "",
    cvId: null,
    cvName: null,
    generatedAt: new Date().toISOString(),
    facts: [
      { id: "n", kind: "contact", content: cv.contact.name, source: { origin: "profile" }, field: "name" },
      ...(cv.contact.email
        ? [{ id: "e", kind: "contact" as const, content: cv.contact.email, source: { origin: "profile" as const }, field: "email" as const }]
        : []),
      ...(cv.contact.phone
        ? [{ id: "p", kind: "contact" as const, content: cv.contact.phone, source: { origin: "profile" as const }, field: "phone" as const }]
        : []),
      ...(cv.contact.location
        ? [{ id: "l", kind: "contact" as const, content: cv.contact.location, source: { origin: "profile" as const }, field: "location" as const }]
        : []),
      ...(cv.contact.linkedin
        ? [{ id: "li", kind: "contact" as const, content: cv.contact.linkedin, source: { origin: "profile" as const }, field: "linkedin" as const }]
        : []),
    ],
    unmatchedCompanies: [],
    warnings: [],
  };
  return sanitiseTailoredCV(reparsed, stub);
}

// ── Prompt builders ───────────────────────────────────────────────────────────

function buildSystemPrompt(): string {
  return `You are a UK CV writer. You produce ATS-safe, evidence-grounded, tailored CVs that read as authentically human.

OUTPUT FORMAT
Return ONLY a single valid JSON object. No preamble, no commentary, no markdown fences. Schema:
{
  "contact": { "name": string, "email": string|null, "phone": string|null, "location": string|null, "linkedin": string|null },
  "summary": string,
  "roles": [{
    "company": string, "title": string,
    "startDate": "YYYY-MM", "endDate": "YYYY-MM"|null, "isCurrent": boolean,
    "location": string|null,
    "bullets": [string]
  }],
  "education": [{ "qualification": string, "institution": string, "classification": string|null, "startYear": string|null, "endYear": string|null, "details": string|null }],
  "skills": [{ "category": string, "items": [string] }],
  "certifications": [{ "content": string, "issuer": string|null, "year": string|null }],
  "languages": [{ "language": string, "proficiency": string }],
  "interests": [string],
  "jdKeywords": [string],
  "gaps": [string]
}

THE TRUTH CONTRACT (NON-NEGOTIABLE)
- Every claim in the output must trace to the FactBase. You may rephrase, reorder, prioritise, prune. You may NOT invent.
- Do not invent metrics, percentages, currency amounts, team sizes, durations, or scopes that aren't in the FactBase.
- Do not promote the candidate to titles, scopes, or tools they don't claim. "Helped build" stays "helped build" — never "led the build of".
- If a JD requirement isn't supported by the FactBase, list it in the "gaps" array. Do not paper over it.
- Do not fabricate certifications, languages, or education entries.

UK CONVENTIONS (ENFORCED)
- British spelling: organise, specialise, analyse, optimise, programme, colour, behaviour, fulfil, recognise.
- Date format: "YYYY-MM" in the JSON; the renderer formats to "Mar 2024 – Present".
- Filename intent: this is a CV, not a resume.
- No photo, no DOB, no nationality, no marital status — never include in contact.
- Address: city + region only — don't output a full street address even if one is in the FactBase.
- Profile section ("summary"): always include, 3–4 lines, written in plain UK English. Anchored on the candidate's most JD-relevant existing experience.
- "References available on request" — never include. The renderer drops it.

BANNED VERBS (instant AI-tell)
spearheaded, spearhead, orchestrated, championed, transformed, drove, drives, pioneered, leveraged, leverage, demonstrated, demonstrating, results-driven, dynamic, passionate, proven, synergistic, synergised, cross-functional [as adjective on its own], detail-oriented, self-starter

REPLACEMENT VERBS (use these instead)
Led, Delivered, Built, Designed, Managed, Reduced, Increased, Negotiated, Launched, Owned, Cut, Saved, Scaled, Shipped, Won, Closed, Migrated, Improved, Implemented, Coordinated, Investigated, Resolved, Recovered, Analysed, Configured

BANNED PHRASES (these scream ChatGPT — never use ANY of these wordings or close paraphrases)
- "results-driven professional", "proven track record", "demonstrated ability to", "rapidly masters", "fast-paced environment", "fast-moving [X] environment" (any), "in today's [X] world", "best-in-class", "world-class", "cross-functional excellence", "value-add"
- "data-driven analysis and strategic implementation", "strategic communication and collaborative problem-solving", "driving measurable improvements", "hits the ground running"
- "uninterrupted supply continuity", "uninterrupted [X]" patterns generally
- "translating data into [X, Y, Z] information", "actionable information / actionable insight" (the words "actionable" and "translating data" are AI tells)
- "enabling timely corrective action", "timely corrective action"
- "supporting budget-conscious [X]", "budget-conscious"
- "high-footfall [X] environment", "high-footfall"
- "operational decision-making" used more than once in the whole CV
- "looking to bring [X] to [Y environment]" — any forward-looking aspirational line in the Profile is BANNED. The Profile must read as evidence (what the candidate has done), never as aspiration.

JD-ECHO RULE
You are tailoring TO the JD, not echoing it. Do not lift any phrase of 4+ words verbatim from the JD into the candidate's CV. Surface JD vocabulary by integrating individual terms naturally into the candidate's own factual statements, NOT by parroting JD sentences back. If the JD says "fast-moving automotive supply chain environment", do not write that phrase. Use the underlying terms (e.g. "automotive supply chain") inside concrete bullets.

SKILL GROUP RULES (HARD)
- Skills are organised into 3–4 groups for visual scannability. Each group has a category label and 3–5 items.
- Category labels: short, sector-aware, JD-aligned. Examples: "Procurement & Supply Chain", "Analytics & Reporting", "Systems & Tools", "Stakeholder & Project Management". Pick categories that match the candidate's actual evidence and the JD's structure.
- Each item is 1–3 words. NEVER longer.
- No parentheticals in items. "ERP system management (Airtable)" is WRONG. Use "ERP design" or "Airtable" as separate items.
- No conjunctions inside an item. "Report writing and data visualisation" is WRONG. Split into "Reporting" and "Data visualisation".
- Total across all groups: 10–14 items. Order both groups and items within them by JD relevance.

PROFILE RULES (HARD)
- 3–4 sentences, all factual / evidence-based.
- NO forward-looking sentence ("looking to apply…", "is looking to bring…", "seeks to leverage…", "eager to contribute…"). The Profile ends on a factual sentence about who the candidate is, not on what they hope to do.
- NO mirroring of JD environment language ("fast-moving", "high-growth", "innovative", "dynamic environment").
- NO weak closers ("with strong [X] capability", "with a passion for [Y]", "with proven [Z]"). Close the Profile on a fact.
- Anchor the Profile on the candidate's strongest JD-relevant evidence: a specific achievement or distinctive role context.

WORD-LEVEL BANS (always replace with specifics)
- "multiple" — replace with a number or names: "across 4 overseas vendors", "procurement, finance, operations"
- "various", "several", "numerous" — same — give a count or list
- "extensive", "significant" — drop, or quantify
- "successfully" — always filler in a CV bullet — drop it ("successfully recovered" → "recovered")
- "actionable" — banned (AI tell)
- "translating" — banned when followed by "data"/"datasets"/"insight"/"information"
- "ensure", "ensuring" — usually weak; prefer the concrete verb of what was done

GOOD BULLET PRINCIPLES
- Lead with the concrete verb of the action (Built, Designed, Negotiated, Reduced, Cut, Investigated, Migrated, Implemented, Coordinated).
- Specify the scope (count, geography, headcount, £ value, system) where the FactBase supports it.
- Name the method when distinctive (the system used, the approach, the collaboration).
- Close with the outcome — a number, a before/after, a clear result.
- A great bullet is 12–24 words. Vary the length across a role's bullets.
- If you cannot quantify because the FactBase has no numbers, replace the metric with concrete scope (team size, geography, frequency, before/after qualitative).

BULLET STRUCTURE — XYZ FORMULA
Where the FactBase supports it, write bullets as: "Accomplished [X] as measured by [Y] by doing [Z]."
- X = what was achieved (verb + object)
- Y = how it was measured (number, scope, frequency, time, qualitative delta)
- Z = the method (system, approach, tool, collaboration)
When numbers aren't in the FactBase, fall back to scope (team size, geography), frequency, or before/after deltas. Never invent a number.

BULLET STRUCTURE — VARIANCE
Vary bullet length deliberately. Mix short (10–15 words), medium (15–22), and one or two longer (22–30) per role. Identical-length bullets read as AI.

ATS RULES
- Standard section labels only: "Experience", "Education", "Skills", "Certifications", "Profile" (the renderer adds these — your job is to populate them).
- Skills: a single flat array of 8–15 short noun-phrase items, ordered by JD relevance. Items use exact JD vocabulary where the FactBase supports the claim. Do not list skills that have no FactBase backing.
- Each skill item is a short noun phrase ("Power BI", "supplier negotiation", "SAP S/4HANA migration"). Never a full sentence. Never categorised; just one ordered list.
- The Skills section sits BETWEEN Profile and Experience in the rendered CV — it acts as a scan-friendly keyword block for ATS and recruiters. Pick the items that earn that prime placement.

ROLE BULLET RULES
- Each role gets 3–6 bullets. The most JD-relevant role can have up to 7. Older roles get 2–4.
- Bullets must be drawn from the achievements + linked skills attached to that role in the FactBase. Skills attached to a role can become bullets if they describe an action; verbatim skill descriptions (no rewrite) are also acceptable in the Skills section.
- If a role has zero source achievements and zero linked skills in the FactBase, skip its bullets and only show the role header.

JD KEYWORDS
- Identify 8–12 of the most important JD terms / required skills / tools / domains.
- Surface them naturally inside bullets, summary, and skills section ONLY where the FactBase supports the claim.
- Do not stuff. Do not list keywords as a standalone block.
- Output the chosen list in "jdKeywords".

GAPS
- After tailoring, list the JD requirements you could NOT support from the FactBase.
- Be specific: "Tableau (JD asks for it; not in your skills or CV)" beats "Some skills missing".

NEVER
- Never include hobbies/interests that aren't in the FactBase. If the FactBase has interests, include them only if they're distinctive or JD-relevant. Generic ones (reading, travel) — drop.
- Never use em dashes (—). Use hyphens or restructure.
- Never write "References available on request".
- Never duplicate a fact across sections (e.g. an education detail in both Education and Skills).
- Never include the word "resume" — this is a CV.
- Never invent a job. Only roles in the FactBase.`;
}

function buildUserPrompt(args: {
  factbaseText: string;
  jdText: string;
  companyName?: string;
  roleName?: string;
}): string {
  const { factbaseText, jdText, companyName, roleName } = args;
  const targetLine = [companyName && `Target company: ${companyName}`, roleName && `Target role: ${roleName}`]
    .filter(Boolean)
    .join("\n");
  return `${targetLine ? targetLine + "\n\n" : ""}=== JOB DESCRIPTION ===
${jdText.trim()}

=== CANDIDATE FACTBASE ===
${factbaseText}

=== TASK ===
Produce a UK-conventional, ATS-safe, JD-tailored CV using ONLY the FactBase above.
- Pick the bullets and skills with the highest JD relevance.
- Rewrite each chosen bullet using the XYZ formula where possible, but stay strictly within what the FactBase supports.
- Build a 3–4 line summary that anchors on the candidate's most JD-relevant existing experience.
- Surface JD keywords naturally where evidence exists.
- List gaps honestly.

Return ONLY the JSON object.`;
}

// ── FactBase serialisation (the AI's read-only ground truth) ──────────────────

function serialiseFactBase(fb: FactBase): string {
  const lines: string[] = [];
  const contacts = factsOfKind(fb, "contact");
  if (contacts.length > 0) {
    lines.push("== Contact ==");
    for (const c of contacts) lines.push(`${cap(c.field)}: ${c.content}`);
    lines.push("");
  }

  const summaries = factsOfKind(fb, "summary");
  if (summaries.length > 0) {
    lines.push("== Existing profile / summary (verbatim from base CV) ==");
    for (const s of summaries) lines.push(s.content);
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
        `[role] ${r.title} at ${r.company} (${dates}${r.location ? ", " + r.location : ""}${
          r.employmentType ? ", " + r.employmentType : ""
        })`
      );
      if (r.summary) lines.push(`  Role summary: ${r.summary}`);
      const roleAchievements = achievements.filter((a) => a.roleId === r.id);
      if (roleAchievements.length > 0) {
        lines.push(`  Source achievements (verbatim from CV — rewrite, don't invent):`);
        for (const a of roleAchievements) lines.push(`    - ${a.content}`);
      }
      const roleSkills = skills.filter((s) => s.roleIds.includes(r.id));
      if (roleSkills.length > 0) {
        lines.push(`  Linked skills / experience:`);
        for (const s of roleSkills) lines.push(`    - ${s.content}`);
      }
      lines.push("");
    }
  }

  const unattributedAchievements = achievements.filter((a) => !a.roleId);
  if (unattributedAchievements.length > 0) {
    lines.push("== Unattributed achievements (from CV but not linked to a known role) ==");
    for (const a of unattributedAchievements) {
      const tag = a.inferredCompany ? ` [CV-employer: ${a.inferredCompany}]` : "";
      lines.push(`  - ${a.content}${tag}`);
    }
    lines.push("");
  }

  const unattributedSkills = skills.filter((s) => s.roleIds.length === 0);
  if (unattributedSkills.length > 0) {
    lines.push("== General skills (not attributed to a specific role) ==");
    for (const s of unattributedSkills) lines.push(`  - ${s.content}`);
    lines.push("");
  }

  const educations = factsOfKind(fb, "education");
  if (educations.length > 0) {
    lines.push("== Education ==");
    for (const e of educations) {
      lines.push(
        `  - ${e.qualification}, ${e.institution}${e.classification ? ` (${e.classification})` : ""}${
          e.startYear || e.endYear ? ` [${[e.startYear, e.endYear].filter(Boolean).join(" – ")}]` : ""
        }`
      );
      if (e.details) lines.push(`    Details: ${e.details}`);
    }
    lines.push("");
  }

  const certifications = factsOfKind(fb, "certification");
  if (certifications.length > 0) {
    lines.push("== Certifications ==");
    for (const c of certifications) {
      const meta = [c.issuer, c.year].filter(Boolean).join(", ");
      lines.push(`  - ${c.content}${meta ? ` (${meta})` : ""}`);
    }
    lines.push("");
  }

  const languages = factsOfKind(fb, "language");
  if (languages.length > 0) {
    lines.push("== Languages ==");
    for (const l of languages) lines.push(`  - ${l.language}: ${l.proficiency || "—"}`);
    lines.push("");
  }

  const interests = factsOfKind(fb, "interest");
  if (interests.length > 0) {
    lines.push("== Interests ==");
    for (const i of interests) lines.push(`  - ${i.content}`);
    lines.push("");
  }

  return lines.join("\n").trim();
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ── Output parsing & sanitisation ────────────────────────────────────────────

function parseTailoredCV(raw: string): TailoredCV | null {
  try {
    const trimmed = (raw ?? "").trim();
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start === -1 || end === -1) return null;
    return JSON.parse(trimmed.slice(start, end + 1)) as TailoredCV;
  } catch {
    return null;
  }
}

function sanitiseTailoredCV(cv: TailoredCV, fb: FactBase): TailoredCV {
  const stripEmDash = (s: string) => s.replace(/—/g, "-").replace(/—/g, "-");
  const trim = (s: string) => stripEmDash((s ?? "").toString()).trim();

  const contactFromFacts = buildContactFallback(fb);
  const contact: TailoredContact = {
    name: trim(cv.contact?.name ?? "") || contactFromFacts.name,
    email: nullable(cv.contact?.email) ?? contactFromFacts.email,
    phone: nullable(cv.contact?.phone) ?? contactFromFacts.phone,
    location: nullable(cv.contact?.location) ?? contactFromFacts.location,
    linkedin: nullable(cv.contact?.linkedin) ?? contactFromFacts.linkedin,
  };

  const roles: TailoredCV["roles"] = (cv.roles ?? []).map((r) => ({
    company: trim(r.company),
    title: trim(r.title),
    startDate: trim(r.startDate),
    endDate: r.endDate ? trim(r.endDate) : null,
    isCurrent: !!r.isCurrent,
    location: nullable(r.location),
    bullets: (r.bullets ?? []).map(trim).filter(Boolean),
  }));

  // Skills as grouped categories. Accept both the new shape and any legacy
  // flat-array output from cached generations.
  const rawSkills = (cv.skills ?? []) as unknown[];
  const skills: { category: string; items: string[] }[] = [];
  const looseFlat: string[] = [];
  for (const s of rawSkills) {
    if (typeof s === "string") {
      const t = trim(s);
      if (t) looseFlat.push(t);
    } else if (s && typeof s === "object") {
      const obj = s as { category?: unknown; items?: unknown[] };
      const cat = trim(String(obj.category ?? "")) || "Skills";
      const items = (obj.items ?? [])
        .map((it) => trim(String(it ?? "")))
        .filter(Boolean);
      if (items.length > 0) skills.push({ category: cat, items });
    }
  }
  if (skills.length === 0 && looseFlat.length > 0) {
    skills.push({ category: "Key Skills", items: looseFlat });
  }

  return {
    contact,
    summary: trim(cv.summary ?? ""),
    roles,
    education: (cv.education ?? []).map((e) => ({
      qualification: trim(e.qualification),
      institution: trim(e.institution),
      classification: nullable(e.classification),
      startYear: nullable(e.startYear),
      endYear: nullable(e.endYear),
      details: nullable(e.details),
    })),
    skills,
    certifications: (cv.certifications ?? []).map((c) => ({
      content: trim(c.content),
      issuer: nullable(c.issuer),
      year: nullable(c.year),
    })),
    languages: (cv.languages ?? []).map((l) => ({
      language: trim(l.language),
      proficiency: trim(l.proficiency),
    })),
    interests: (cv.interests ?? []).map(trim).filter(Boolean),
    jdKeywords: (cv.jdKeywords ?? []).map(trim).filter(Boolean),
    gaps: (cv.gaps ?? []).map(trim).filter(Boolean),
  };
}

function nullable(v: string | null | undefined): string | null {
  if (!v) return null;
  const trimmed = String(v).trim();
  return trimmed ? trimmed : null;
}

function buildContactFallback(fb: FactBase): TailoredContact {
  const out: TailoredContact = { name: "", email: null, phone: null, location: null, linkedin: null };
  for (const c of factsOfKind(fb, "contact")) {
    if (c.field === "name") out.name = c.content;
    else if (c.field === "email") out.email = c.content;
    else if (c.field === "phone") out.phone = c.content;
    else if (c.field === "location") out.location = c.content;
    else if (c.field === "linkedin") out.linkedin = c.content;
  }
  return out;
}

// keep imports referenced for stricter type narrowing in editors
type _FactsUsed = AchievementFact | CertificationFact | ContactFact | EducationFact | Fact | InterestFact | LanguageFact | RoleFact | SkillFact | SummaryFact;
