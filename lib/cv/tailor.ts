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

  return {
    tailoredCV: sanitised,
    warnings,
    jdKeywords: sanitised.jdKeywords,
    gaps: sanitised.gaps,
  };
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

BANNED PHRASES (these scream ChatGPT)
"results-driven professional", "proven track record", "demonstrated ability to", "rapidly masters", "fast-paced environment", "in today's [X] world", "best-in-class", "world-class", "cross-functional excellence", "value-add", "data-driven analysis and strategic implementation", "strategic communication and collaborative problem-solving", "driving measurable improvements", "hits the ground running"

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
- Skills: organise into 2–4 categories (e.g. "Technical", "Tools", "Domain"). Items use exact JD vocabulary where evidence exists in the FactBase. Do not list skills that have no FactBase backing.
- Each skill item should be a short noun phrase ("Power BI", "supplier negotiation", "SAP S/4HANA migration"), not a sentence.

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

  const skills: TailoredCV["skills"] = (cv.skills ?? [])
    .map((s) => ({
      category: trim(s.category) || "Skills",
      items: (s.items ?? []).map(trim).filter(Boolean),
    }))
    .filter((s) => s.items.length > 0);

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
