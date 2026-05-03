import { auth } from "@clerk/nextjs/server";
import { createServerSupabaseClient } from "@/lib/supabase-server";
import { callAI } from "@/lib/ai-router";
import { getApiKeyValues } from "@/app/actions/api-keys";
import { extractFactBase } from "./extract";
import { tailorMasterToJD } from "./master-profile";
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

// Load the user's saved Master Profile, if any.
async function loadMasterProfile(): Promise<{ summary: string } | null> {
  try {
    const { userId } = await auth();
    if (!userId) return null;
    const supabase = await createServerSupabaseClient();
    const { data } = await supabase
      .from("user_master_profile")
      .select("summary")
      .eq("user_id", userId)
      .maybeSingle();
    return data && data.summary ? { summary: data.summary } : null;
  } catch (e) {
    console.error("[loadMasterProfile] error:", e);
    return null;
  }
}

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

  // Master-aware path: if user has a saved Master Profile, tailor it to the JD
  // and inject it as the Profile section. The AI then only generates the rest
  // of the CV (Experience, Skills, Education) and is forbidden from rewriting
  // the Profile.
  let preTailoredProfile: string | null = null;
  try {
    const master = await loadMasterProfile();
    if (master && master.summary?.trim()) {
      const masterTailor = await tailorMasterToJD({
        master: master.summary,
        jdText: input.jdText,
        cvId: input.cvId,
        companyName: input.companyName,
        roleName: input.roleName,
        connectedProviders: keys,
      });
      if (masterTailor.tailored) {
        preTailoredProfile = masterTailor.tailored;
      }
      if (masterTailor.warnings) warnings.push(...masterTailor.warnings);
    }
  } catch (e) {
    console.error("[tailorCV] master tailor failed (continuing without):", e);
  }

  const systemPrompt = buildSystemPrompt();
  const userPrompt = buildUserPrompt({
    factbaseText,
    jdText: input.jdText,
    companyName: input.companyName,
    roleName: input.roleName,
    preTailoredProfile: preTailoredProfile ?? undefined,
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

  // If we have a pre-tailored Profile, force it back in (in case the AI
  // ignored the instruction and rewrote it anyway).
  if (preTailoredProfile && parsed) {
    parsed.summary = preTailoredProfile;
  }

  const sanitised = sanitiseTailoredCV(parsed, fb);

  // Post-process critic: scan for banned phrases, JD echo, and uniform-length
  // bullets. Any hit triggers a single targeted AI call to rewrite the offenders.
  const flagged = [
    ...scanBannedPhrases(sanitised),
    ...scanJDEcho(sanitised, input.jdText),
    ...scanBulletVariance(sanitised),
    ...scanProfile(sanitised),
  ];
  if (flagged.length > 0) {
    let current = sanitised;
    let lastFlagged = flagged;
    let succeeded = false;
    // Up to TWO rewrite passes: if pass 1 still leaves critical issues
    // (anchor-leak, brand-tier employer, specificity), pass 2 runs with
    // even-stronger explicit instructions.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fixed = await rewriteOffendingSections({
          cv: current,
          flagged: lastFlagged,
          jdText: input.jdText,
          factbaseText,
          connectedProviders: keys,
          attempt,
        });
        if (!fixed) break;
        const reflagged = [
          ...scanBannedPhrases(fixed),
          ...scanJDEcho(fixed, input.jdText),
          ...scanBulletVariance(fixed),
          ...scanProfile(fixed),
        ];
        current = fixed;
        if (reflagged.length === 0) {
          succeeded = true;
          break;
        }
        lastFlagged = reflagged;
      } catch (e) {
        console.error("[tailorCV] critic rewrite failed:", e);
        break;
      }
    }
    if (succeeded) {
      return {
        tailoredCV: current,
        warnings,
        jdKeywords: current.jdKeywords,
        gaps: current.gaps,
      };
    }
    if (current !== sanitised) {
      // Use the last rewrite even if not fully clean — better than the first pass.
      return {
        tailoredCV: current,
        warnings: [
          ...warnings,
          `Critic flagged ${lastFlagged.length} issue${lastFlagged.length === 1 ? "" : "s"} that two rewrite passes couldn't fully fix. Click "Tailor CV" again to regenerate.`,
        ],
        jdKeywords: current.jdKeywords,
        gaps: current.gaps,
      };
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

  const flagged = [
    ...scanBannedPhrases(sanitised),
    ...scanJDEcho(sanitised, input.jdText),
    ...scanBulletVariance(sanitised),
    ...scanProfile(sanitised),
  ];
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

export interface BannedHit {
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

  // Sprint 1 — May 2026 research additions (UK-2026 ChatGPT signature words)
  ["delve / delved", /\bdelv(?:e|ed|ing)\b/gi],
  ["embark / embarked", /\bembark(?:ed|ing|s)?\b/gi],
  ["seamless / seamlessly", /\bseamless(?:ly)?\b/gi],
  ["robust", /\brobust\b/gi],
  ["cutting-edge", /\bcutting[- ]edge\b/gi],
  ["synergised / synergies", /\bsynerg(?:ised|ize|ies|y)\b/gi],
  ["utilised", /\butilis(?:ed|e|ing)\b/gi],
  ["streamlined", /\bstreamlin(?:ed|e|ing)\b/gi],
  ["drove (verb)", /\bdrove\b/gi],
  ["forward-thinking organisation", /\bforward[- ]thinking organi[sz]ation\b/gi],
  ["innovative solutions", /\binnovative solutions?\b/gi],
  ["dynamic environment", /\bdynamic environment\b/gi],
  // Awkward corporate verbs (caught from JLR test outputs)
  ["underpin", /\bunderpin(?:s|ned|ning)?\b/gi],
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

// JD-echo: any 5-word window from the CV body that appears verbatim in the JD
// is a paste-back. Recruiters subconsciously register this as inauthentic.
function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s\-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1);
}

function ngrams(words: string[], n: number): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i + n <= words.length; i++) {
    out.add(words.slice(i, i + n).join(" "));
  }
  return out;
}

const JD_ECHO_GRAM_SIZE = 5;
// Words so common that a 5-gram including only them isn't really "echo" —
// don't penalise for these natural overlaps.
const JD_ECHO_STOP_PHRASES = new Set([
  "as well as the",
  "in order to",
  "and the team",
  "the team and",
]);

function scanJDEcho(cv: TailoredCV, jdText: string): BannedHit[] {
  const hits: BannedHit[] = [];
  if (!jdText || !jdText.trim()) return hits;
  const jdGrams = ngrams(tokens(jdText), JD_ECHO_GRAM_SIZE);

  const check = (label: string, text: string) => {
    if (!text) return;
    const cvGrams = ngrams(tokens(text), JD_ECHO_GRAM_SIZE);
    for (const g of cvGrams) {
      if (jdGrams.has(g) && !JD_ECHO_STOP_PHRASES.has(g)) {
        hits.push({ section: label, phrase: `JD echo: "${g}"` });
        return; // one hit per text segment is enough to trigger rewrite
      }
    }
  };

  check("Profile", cv.summary);
  for (let i = 0; i < cv.roles.length; i++) {
    const r = cv.roles[i];
    for (let j = 0; j < r.bullets.length; j++) {
      check(`Experience: ${r.title} bullet ${j + 1}`, r.bullets[j]);
    }
  }
  return hits;
}

// Bullet-length variance — if a role's bullets are all within ±2 words of each
// other (low variance), that's an AI cadence tell.
function scanBulletVariance(cv: TailoredCV): BannedHit[] {
  const hits: BannedHit[] = [];
  for (const r of cv.roles) {
    if (r.bullets.length < 4) continue;
    const lengths = r.bullets.map((b) => b.split(/\s+/).filter(Boolean).length);
    const mean = lengths.reduce((a, b) => a + b, 0) / lengths.length;
    const variance =
      lengths.reduce((a, b) => a + (b - mean) ** 2, 0) / lengths.length;
    const stddev = Math.sqrt(variance);
    if (mean > 0 && stddev / mean < 0.18) {
      hits.push({
        section: `Experience: ${r.title}`,
        phrase: `bullets are uniform length (mean ${mean.toFixed(0)} words, stddev ${stddev.toFixed(1)}) — vary deliberately`,
      });
    }
  }
  return hits;
}

// ── Profile-section critics (Sprint: Profile batch) ──────────────────────────
//
// These all run against cv.summary only. Each returns 0..n hits. A hit triggers
// the same auto-rewrite loop the banned-phrase critic already uses.

// Split a profile string into sentences. Conservative: split on `. ` followed
// by capital, plus newlines. Keeps trailing fragments.
function splitSentences(text: string): string[] {
  if (!text) return [];
  return text
    .split(/(?<=[.!?])\s+(?=[A-Z])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function wordCount(s: string): number {
  return s.split(/\s+/).filter(Boolean).length;
}

// 1. LENGTH — 60-100 words, 3-4 sentences. Outside that range → flag.
function scanProfileLength(cv: TailoredCV): BannedHit[] {
  const hits: BannedHit[] = [];
  if (!cv.summary) return hits;
  const wc = wordCount(cv.summary);
  const sc = splitSentences(cv.summary).length;
  if (wc < 50 || wc > 110) {
    hits.push({
      section: "Profile",
      phrase: `length is ${wc} words — target 60–100. Tighten or expand to fit.`,
    });
  }
  if (sc < 3 || sc > 4) {
    hits.push({
      section: "Profile",
      phrase: `${sc} sentence${sc === 1 ? "" : "s"} — target 3–4 sentences.`,
    });
  }
  return hits;
}

// 2. IMPLIED FIRST PERSON — no "I/my", no third-person self-reference verbs.
const PROFILE_FIRST_PERSON_PRONOUN = /\b(?:I|I'm|I've|I'd|I'll|me|my|mine|myself)\b/;
// Verbs that, when used as the SUBJECTLESS opener of a sentence in a Profile,
// signal third-person ("Produces reports…" / "Holds a degree…"). Any of these
// at the start of a sentence in the Profile is a violation.
const PROFILE_THIRD_PERSON_VERBS = [
  // Original list
  "Produces",
  "Holds",
  "Brings",
  "Manages",
  "Tracks",
  "Delivers",
  "Demonstrates",
  "Possesses",
  "Operates",
  "Specialises",
  "Maintains",
  "Combines",
  "Carries",
  "Owns",
  "Has",
  // Phase A additions — verbs that snuck through ("Analyses…")
  "Analyses",
  "Analyzes",
  "Investigates",
  "Runs",
  "Leads",
  "Designs",
  "Builds",
  "Implements",
  "Coordinates",
  "Generates",
  "Develops",
  "Creates",
  "Pulls",
  "Writes",
  "Reports",
  "Reviews",
  "Presents",
  "Forecasts",
  "Negotiates",
  "Sources",
  "Reduces",
  "Improves",
  "Drives",
  "Oversees",
  "Supports",
  "Handles",
  "Plans",
  "Produces",
  "Audits",
  "Reconciles",
  "Synthesises",
  "Synthesizes",
];
function scanProfileImpliedFirstPerson(cv: TailoredCV): BannedHit[] {
  const hits: BannedHit[] = [];
  if (!cv.summary) return hits;
  if (PROFILE_FIRST_PERSON_PRONOUN.test(cv.summary)) {
    hits.push({
      section: "Profile",
      phrase: `uses first-person pronoun (I / my / me). Profile must be implied first person — drop the pronoun and lead with the action or role.`,
    });
  }
  for (const sentence of splitSentences(cv.summary)) {
    const firstWord = sentence.split(/\s+/)[0]?.replace(/[^A-Za-z']/g, "");
    if (firstWord && PROFILE_THIRD_PERSON_VERBS.includes(firstWord)) {
      hits.push({
        section: "Profile",
        phrase: `sentence opens with third-person verb "${firstWord}…". Profile must be implied first person, not narrated about the candidate.`,
      });
      break; // one hit triggers regen
    }
  }
  return hits;
}

// 3. SENTENCE 2 MUST CONTAIN A NUMBER — load-bearing sentence; without quantification
// the Profile is unfounded. Accepts numbers, currencies, percentages, written
// numbers, frequencies, AND scope-language (revenue growth, supplier counts,
// before/after deltas, geography signals).
const NUMBER_HINT = new RegExp(
  [
    // Digits, currency, %
    "[\\d£$%]",
    // Cardinal & ordinal number-words
    "\\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|hundred|thousand|million|billion|first|second|third|fourth|fifth|sixth)\\b",
    // Frequency
    "\\b(?:weekly|monthly|quarterly|annually|annual|daily|dozens?|every)\\b",
    // Scope-multipliers / growth ("2x revenue", "doubled", "tripled")
    "\\b(?:doubled?|doubling|tripled?|halved?|x\\s*revenue|times|fold)\\b",
    // Before/after delta language
    "\\bfrom\\s+\\d|to\\s+\\d|increased\\s+by|reduced\\s+by|cut\\s+by|grew\\s+by",
    // Scope signals (count + noun)
    "\\bacross\\s+(?:multiple|several)?\\s*(?:overseas|global|UK|EU|US|EMEA|APAC)\\b",
    // Period framing
    "\\b(?:through|during)\\s+(?:a\\s+)?(?:period|window|phase)\\b",
    // Explicit headcount / volume
    "\\b(?:no\\.|number)\\s+of\\s+|\\bhigher\\s+volumes?|\\bwider\\s+(?:supplier|client|vendor)",
    // Growth / scale qualifiers anchored to a noun
    "\\bsignificantly\\s+higher|significantly\\s+more|materially\\s+(?:more|higher)",
    // From-scratch / first-of-its-kind (founding scope)
    "\\bfrom\\s+scratch|\\bfirst\\s+(?:ever\\s+)?\\b",
  ].join("|"),
  "i"
);
function scanProfileSentence2HasNumber(cv: TailoredCV): BannedHit[] {
  const hits: BannedHit[] = [];
  if (!cv.summary) return hits;
  const sentences = splitSentences(cv.summary);
  if (sentences.length < 2) return hits;
  const sentence2 = sentences[1];
  if (!NUMBER_HINT.test(sentence2)) {
    hits.push({
      section: "Profile",
      phrase: `sentence 2 contains no number, scope, or quantifier. The load-bearing sentence must include £/%/count/named scale (e.g. "12 overseas suppliers", "weekly", "from scratch") to anchor the claim.`,
    });
  }
  return hits;
}

// 4. NO TRICOLON IN ANY PROFILE SENTENCE — pattern is "X, Y, and Z" with 2+
// commas + "and" before the last item. Tricolons in S2 weaken the load-bearing
// sentence; tricolons elsewhere read as AI cadence. Apply broadly.
function scanProfileTricolon(cv: TailoredCV): BannedHit[] {
  const hits: BannedHit[] = [];
  if (!cv.summary) return hits;
  const sentences = splitSentences(cv.summary);
  for (let i = 0; i < sentences.length; i++) {
    const s = sentences[i];
    const commaCount = (s.match(/,/g) || []).length;
    if (commaCount >= 2 && /,\s*(?:and|&)\s+/i.test(s)) {
      hits.push({
        section: "Profile",
        phrase: `sentence ${i + 1} is a tricolon (X, Y, and Z list). Pick one or two items; do not list three.`,
      });
    }
  }
  return hits;
}

// 5. NO EM-DASH IN PROFILE — em-dash is a Claude tell.
function scanProfileEmDash(cv: TailoredCV): BannedHit[] {
  const hits: BannedHit[] = [];
  if (!cv.summary) return hits;
  if (/—/.test(cv.summary)) {
    hits.push({
      section: "Profile",
      phrase: `contains em-dash (—) — replace with comma, full stop, or restructure.`,
    });
  }
  return hits;
}

// 6. NO OPENING ADJECTIVE STACK — sentence 1 must not start with 2+ comma-separated adjectives.
const PROFILE_OPENING_ADJECTIVE_STACK_OPENERS = [
  "dedicated",
  "organised",
  "organized",
  "results-driven",
  "results-oriented",
  "passionate",
  "detail-oriented",
  "hard-working",
  "hardworking",
  "motivated",
  "dynamic",
  "innovative",
  "creative",
  "diligent",
  "ambitious",
  "driven",
  "enthusiastic",
  "proactive",
  "self-motivated",
  "highly motivated",
  "highly organised",
];
function scanProfileOpeningAdjectiveStack(cv: TailoredCV): BannedHit[] {
  const hits: BannedHit[] = [];
  if (!cv.summary) return hits;
  const first = (splitSentences(cv.summary)[0] ?? "").toLowerCase().trim();
  // Stack: starts with adjective_word + "," + ... + adjective_word
  for (const opener of PROFILE_OPENING_ADJECTIVE_STACK_OPENERS) {
    if (first.startsWith(opener + ",") || first.startsWith(opener + " and ")) {
      hits.push({
        section: "Profile",
        phrase: `sentence 1 opens with adjective stack "${opener}, …" — banned. Lead with role + context, not adjectives.`,
      });
      break;
    }
  }
  return hits;
}

// 7. CLOSE VALIDITY — last sentence must NOT be a generic forward-looking close.
// Banned close patterns. The Profile may close on either a fact (degree, named credential)
// or a NAMED target ("Targeting a [specific role] at [specific employer]"). Generic
// aspiration is not a valid close.
const PROFILE_BANNED_CLOSE_PATTERNS = [
  /\b(?:looking|seeking|eager|excited|keen) to\s+(?:apply|leverage|bring|contribute|join|use|deliver)/i,
  /\b(?:apply|bring|use|leverage|deliver) (?:my|the)?\s*(?:skills?|experience|expertise|capability|capabilities|knowledge)\s+(?:to|in|within)/i,
  /\bin (?:a |an )?(?:dynamic|innovative|fast[- ]paced|fast[- ]moving|forward[- ]thinking|high[- ]growth|growing) (?:environment|organisation|organization|company|workplace|team)/i,
  /\bsupported by (?:advanced|strong|excellent|proven) [a-z\s]+ (?:skills?|experience)/i,
];
function scanProfileCloseValidity(cv: TailoredCV): BannedHit[] {
  const hits: BannedHit[] = [];
  if (!cv.summary) return hits;
  const sentences = splitSentences(cv.summary);
  if (sentences.length === 0) return hits;
  const last = sentences[sentences.length - 1];
  for (const re of PROFILE_BANNED_CLOSE_PATTERNS) {
    if (re.test(last)) {
      hits.push({
        section: "Profile",
        phrase: `closing sentence is a generic / forward-looking aspiration. Close on a fact (degree, named credential) or a NAMED target (specific role at specific employer).`,
      });
      break;
    }
  }
  return hits;
}

// 8. SENTENCE-LENGTH VARIANCE — at least one short (<14 words) AND one long (>20 words).
// If all sentences are within 4 words of each other, that's uniform AI cadence.
function scanProfileSentenceVariance(cv: TailoredCV): BannedHit[] {
  const hits: BannedHit[] = [];
  if (!cv.summary) return hits;
  const sentences = splitSentences(cv.summary);
  if (sentences.length < 3) return hits;
  const lengths = sentences.map(wordCount);
  const min = Math.min(...lengths);
  const max = Math.max(...lengths);
  if (max - min < 6) {
    hits.push({
      section: "Profile",
      phrase: `sentence lengths are uniform (range ${min}-${max} words). Vary the cadence — at least one short (<14 words) and one longer (>20 words).`,
    });
  }
  return hits;
}

// 9. SPECIFICITY ANCHOR — Profile MUST contain at least one specific named item
// IN THE BODY (S1, S2, or S3) — not just in S4 fact close. A credential in S4
// alone passes the body-text test but leaves S1-S3 abstract. Tighten by
// requiring at least one named anchor in the load-bearing first three sentences.
const SPECIFICITY_HINTS = [
  // Specific tools / systems / platforms
  /\b(?:Airtable|SAP|Oracle|Salesforce|Workday|Tableau|Power\s?BI|Excel|Python|JavaScript|TypeScript|React|Node\.js|AWS|Azure|GCP|HubSpot|Mailchimp|Adobe|Figma|Jira|Asana|Notion|Slack|Microsoft|Google|Apple|Amazon|Meta)\b/i,
  // Built / designed / from-scratch signals
  /\b(?:from\s+scratch|in[- ]house|founding|first[- ]ever|first\s+hire|sole\s+designer|sole\s+architect)\b/i,
  // Named system patterns ("supplier scorecard", "ERP system", "tracking system", etc.)
  /\b(?:scorecard|ERP|CRM|dashboard|pipeline|playbook|framework|model|tracker|tracking system|management system)\b/i,
  // Currency-amounts / specific figures
  /(?:£|\$|€)\d|(?:\d+(?:,\d{3})*(?:\.\d+)?)(?:\s?(?:million|billion|m|bn|k|%))/i,
  // Named brand contexts in fact close
  /\b(?:Goldman\s+Sachs|JPMorgan|Morgan\s+Stanley|McKinsey|Bain|BCG|Deloitte|PwC|EY|KPMG|Siemens|Bosch|Unilever|Diageo|Apple|Google|Meta|Amazon|Microsoft|Stripe|Airbnb|Uber|OpenAI|Anthropic|Tesla|Nvidia|Netflix|Cambridge|Oxford|LSE|Imperial|Russell\s+Group)\b/i,
  // Named degree class / credential
  /\b(?:First[- ]Class|2:1|2:2|MCIPS|CFA|ACA|ACCA|CIMA|CIPS|PRINCE2|MBA|PhD)\b/i,
  // Specific scale anchors
  /\bacross\s+\d+\s+(?:countries|markets|regions|sites|locations|distribution\s+centres|stores|teams|suppliers|vendors|clients|customers|product\s+lines)\b/i,
  /\b(?:portfolio|category|book|spend)\s+(?:of|worth)\s+£/i,
];
function scanProfileSpecificityAnchor(cv: TailoredCV): BannedHit[] {
  const hits: BannedHit[] = [];
  if (!cv.summary) return hits;
  // Specificity must appear in the BODY (S1-S3), not just S4 fact-close.
  // A credential alone in S4 (e.g. "First-Class") satisfies a weaker rule but
  // leaves S1-S3 abstract — recruiters skim past abstract bodies.
  const sentences = splitSentences(cv.summary);
  const body = sentences.slice(0, 3).join(" "); // S1-S3 only
  let hasSpecificityInBody = false;
  for (const re of SPECIFICITY_HINTS) {
    if (re.test(body)) {
      hasSpecificityInBody = true;
      break;
    }
  }
  if (!hasSpecificityInBody) {
    hits.push({
      section: "Profile",
      phrase: `body (S1-S3) contains no specific named item — only abstract scope / ownership / reporting claims. At least one named anchor (built system, named brand, named project, named tool, £-figure) MUST appear in S1, S2, or S3. A credential in S4 alone does not count.`,
    });
  }
  return hits;
}

// 10. BRAND-TIER EMPLOYER ENFORCEMENT — if the current employer's name appears
// in S1 and that employer is NOT on the brand-tier list, flag it. The rule
// previously relied on the LLM to follow soft instructions; this makes it
// deterministic.
const BRAND_TIER_EMPLOYERS = new Set<string>([
  // Bulge bracket / banking
  "goldman sachs", "jpmorgan", "jp morgan", "morgan stanley", "bank of america",
  "citigroup", "citi", "barclays", "deutsche bank", "ubs", "credit suisse",
  "hsbc", "lloyds", "natwest", "santander", "blackrock",
  // MBB consulting
  "mckinsey", "bain", "bcg", "boston consulting group",
  // Big 4
  "deloitte", "pwc", "pricewaterhousecoopers", "ernst young", "ey", "kpmg",
  // Magic Circle
  "allen overy", "clifford chance", "freshfields", "linklaters",
  "slaughter and may",
  // Big Tech / FAANG
  "apple", "microsoft", "google", "alphabet", "meta", "facebook",
  "amazon", "netflix", "tesla", "nvidia",
  // Household-name scaleups
  "stripe", "airbnb", "uber", "openai", "anthropic", "spotify",
  "shopify", "snowflake", "databricks",
  // Industrial / FMCG household
  "siemens", "bosch", "rolls-royce", "rolls royce", "bae systems",
  "unilever", "diageo", "nestle", "p&g", "procter gamble", "innocent",
  // Telco / utility household UK
  "bt", "vodafone", "ee", "british gas", "centrica",
]);

function scanProfileBrandTierEmployer(cv: TailoredCV): BannedHit[] {
  const hits: BannedHit[] = [];
  if (!cv.summary) return hits;
  const sentences = splitSentences(cv.summary);
  if (sentences.length === 0) return hits;
  const s1Lower = sentences[0].toLowerCase();

  // Check current-role employer from the TailoredCV's first role.
  const currentEmployer = cv.roles[0]?.company?.toLowerCase().trim();
  if (!currentEmployer) return hits;

  // Only flag if the employer name appears in S1 AND the employer is not brand-tier.
  if (s1Lower.includes(currentEmployer) && !BRAND_TIER_EMPLOYERS.has(currentEmployer)) {
    hits.push({
      section: "Profile",
      phrase: `S1 contains current employer name "${cv.roles[0]?.company}" — not on the brand-tier list. Omit the employer name from S1; it lives in the Experience section.`,
    });
  }
  return hits;
}

// 12. OUTCOME SIGNAL — somewhere in S2 or S3 there must be at least one
// outcome-flavoured signal: an explicit £-amount, %, count, before/after delta,
// recovered/saved/cut figure, or a verb-noun outcome ("recovered refunds",
// "switched providers", "absorbed wider complexity"). Pure capability claims
// without any delivery/outcome are forgettable.
const OUTCOME_HINTS = [
  // Money / numeric outcomes
  /(?:£|\$|€)\s?\d/,
  /\b\d+(?:\.\d+)?\s?(?:%|million|billion|m|bn|k)\b/i,
  // Before/after deltas
  /\bfrom\s+\d.*\bto\s+\d/i,
  /\b(?:cut|saved|recovered|reduced|grew|increased|raised|halved|doubled|tripled)\s+(?:by|from|to|on)?\s*(?:£|\$|€)?\s?\d/i,
  // Outcome verb + noun
  /\b(?:recovered|switched|consolidated|cut|saved|reduced|halved|doubled|tripled|absorbed|raised|launched|shipped|closed)\s+\w+/i,
  // Named scale outcomes
  /\bacross\s+\d+\s+(?:countries|markets|regions|sites|locations|distribution\s+centres|stores|teams|suppliers|vendors|clients|customers|product\s+lines)\b/i,
  /\bscal(?:ed|ing)\s+(?:the\s+function|the\s+team|operations|to|by|through)/i,
  /\b(?:on[- ]time|sla|p99|latency)\b/i,
];
function scanProfileOutcomeSignal(cv: TailoredCV): BannedHit[] {
  const hits: BannedHit[] = [];
  if (!cv.summary) return hits;
  const sentences = splitSentences(cv.summary);
  if (sentences.length < 2) return hits;
  // Look in S2-S3 only — S1 is role/scope, S4 is fact close.
  const middle = sentences.slice(1, 3).join(" ");
  let hasOutcome = false;
  for (const re of OUTCOME_HINTS) {
    if (re.test(middle)) {
      hasOutcome = true;
      break;
    }
  }
  if (!hasOutcome) {
    hits.push({
      section: "Profile",
      phrase: `S2-S3 contain no outcome signal — only capability/ownership descriptions. Add at least one outcome anchor: £-amount, %, count, before/after delta, or a recovered/saved/switched/cut/scaled outcome verb. Pure "built X, owns Y" without delivery is forgettable.`,
    });
  }
  return hits;
}

// 13. SCOPE-ANCHOR-LEAK — growth multiples, currency-amounts, percentages,
// count+noun signals must appear in S2 only, NEVER in S1. S1 is for role +
// work scope; the scale signal is the centrepiece of S2.
const SCOPE_ANCHOR_LEAK_PATTERNS = [
  /\b\d+x\s+(?:revenue|growth|scale|users|throughput)\b/i,
  /\b(?:doubled?|tripled?|halved?|quadrupled?)\b/i,
  /\b(?:£|\$|€)\s?\d/i,
  /\b\d+(?:\.\d+)?\s?(?:million|billion|m|bn|k|%)\b/i,
  /\bduring\s+(?:a\s+)?period\s+of\s+\d/i,
  /\bduring\s+(?:a\s+)?period\s+of\s+\d+x\b/i,
  /\bthrough\s+(?:a\s+)?period\s+of\s+\d+x\b/i,
];
function scanProfileScopeAnchorLeak(cv: TailoredCV): BannedHit[] {
  const hits: BannedHit[] = [];
  if (!cv.summary) return hits;
  const sentences = splitSentences(cv.summary);
  if (sentences.length === 0) return hits;
  const s1 = sentences[0];
  for (const re of SCOPE_ANCHOR_LEAK_PATTERNS) {
    if (re.test(s1)) {
      hits.push({
        section: "Profile",
        phrase: `S1 contains a scope anchor (growth multiple / £-figure / %-amount / "during a period of Nx ..."). The scope anchor must live in S2 only — remove it from S1 and lead S1 with role + work scope only.`,
      });
      break;
    }
  }
  return hits;
}

// 14. STRONG-S2-NUMBER — frequency adverbs alone ("weekly", "daily") are NOT
// sufficient as the S2 scope anchor. S2 must contain a substantial number/scale
// signal: digit+unit, currency, growth multiple, count of named entities, or
// before/after delta.
const SUBSTANTIAL_S2_NUMBER = [
  /\b\d+x\b/i,
  /\b(?:£|\$|€)\s?\d/,
  /\b\d+(?:\.\d+)?\s?(?:million|billion|m|bn|k|%)\b/i,
  /\b(?:doubled?|tripled?|halved?|quadrupled?)\b/i,
  /\bfrom\s+\d.*\bto\s+\d/i,
  /\bacross\s+\d+\s+(?:countries|markets|regions|sites|locations|distribution\s+centres|stores|teams|suppliers|vendors|clients|customers|product\s+lines|categories)\b/i,
  /\b(?:cut|saved|recovered|reduced|grew|increased|raised)\s+(?:by|from|to|on)?\s*(?:£|\$|€)?\s?\d/i,
  /\b(?:revenue|spend|book|portfolio|category)\s+(?:growth|of)\b/i,
  /\b(?:scaled|grew|expanded)\s+(?:to|through|by)\s+\d/i,
  /\b\d+\s+(?:overseas|global|UK|EU|US|EMEA|APAC)?\s*(?:countries|markets|sites|teams|suppliers|vendors|clients|customers|product\s+lines)\b/i,
];
function scanProfileSubstantialS2Number(cv: TailoredCV): BannedHit[] {
  const hits: BannedHit[] = [];
  if (!cv.summary) return hits;
  const sentences = splitSentences(cv.summary);
  if (sentences.length < 2) return hits;
  const s2 = sentences[1];
  for (const re of SUBSTANTIAL_S2_NUMBER) {
    if (re.test(s2)) return hits; // pass — has a substantial scale signal
  }
  hits.push({
    section: "Profile",
    phrase: `S2 has no substantial scope anchor (only frequency adverbs like "weekly" don't count). S2 must contain a real scale signal: growth multiple ("Nx"), £/$/€-figure, %-amount, named count of entities ("12 overseas suppliers"), or before/after delta.`,
  });
  return hits;
}

// 15. S3 STRENGTH — S3 must contain a named specific item (system/brand/
// project/tool/outcome/count) — NOT just generic scope-descriptions like
// "from purchase-order through to delivery" or "end-to-end procurement".
// Generic scope phrases describe what every candidate in this role does.
// S3 must surface what makes THIS candidate distinctive: a named built system,
// a named outcome figure, a named brand collaborator, a named count of entities.
function scanProfileS3Strength(cv: TailoredCV): BannedHit[] {
  const hits: BannedHit[] = [];
  if (!cv.summary) return hits;
  const sentences = splitSentences(cv.summary);
  if (sentences.length < 3) return hits;
  const s3 = sentences[2];
  // Check for at least one NAMED specific item (the strict specificity hints).
  let hasNamedSpecific = false;
  for (const re of SPECIFICITY_HINTS) {
    if (re.test(s3)) {
      hasNamedSpecific = true;
      break;
    }
  }
  // Also accept count + named entity (e.g. "12 overseas suppliers", "3 distribution centres")
  if (/\b\d+\s+(?:overseas|global|UK|EU|US|EMEA|APAC)?\s*(?:countries|markets|regions|sites|locations|distribution\s+centres|stores|teams|suppliers|vendors|clients|customers|product\s+lines|categories)\b/i.test(s3)) {
    hasNamedSpecific = true;
  }
  // Also accept named-collaborator patterns ("with the company director", "alongside the [named] team")
  if (/\b(?:alongside|with)\s+the\s+(?:company\s+director|CEO|CFO|CTO|founder|founding\s+team|VP|head\s+of)/i.test(s3)) {
    hasNamedSpecific = true;
  }
  if (!hasNamedSpecific) {
    hits.push({
      section: "Profile",
      phrase: `S3 contains no NAMED specific item — only generic scope/ownership/reporting language. Generic phrases like "from purchase-order through to delivery" or "owning the function end-to-end" describe what every candidate at this level does. S3 must surface a named built system, named outcome figure, named brand collaborator, or named count of entities — the thing that makes THIS candidate distinctive.`,
    });
  }
  return hits;
}

// 11. ANCHOR-LEAK — sole/ownership claim words must appear in S3 only, not S1
// or S2. Deterministic enforcement.
const SOLE_OWNERSHIP_KEYWORDS = /\b(?:sole|only\s+(?:person|analyst|hire|owner|engineer|manager|specialist)|single[- ]handed|founding|first\s+hire|first[- ]ever)\b/i;
function scanProfileAnchorLeak(cv: TailoredCV): BannedHit[] {
  const hits: BannedHit[] = [];
  if (!cv.summary) return hits;
  const sentences = splitSentences(cv.summary);
  if (sentences.length < 2) return hits;
  if (SOLE_OWNERSHIP_KEYWORDS.test(sentences[0])) {
    hits.push({
      section: "Profile",
      phrase: `S1 contains a sole/ownership claim word ("sole" / "only [role]" / "founding" / etc.). The ownership claim must live in S3 only — remove it from S1.`,
    });
  }
  if (SOLE_OWNERSHIP_KEYWORDS.test(sentences[1])) {
    hits.push({
      section: "Profile",
      phrase: `S2 contains a sole/ownership claim word ("sole" / "only [role]" / "founding" / etc.). The ownership claim must live in S3 only — remove it from S2.`,
    });
  }
  return hits;
}

export function scanProfile(cv: TailoredCV): BannedHit[] {
  return [
    ...scanProfileLength(cv),
    ...scanProfileImpliedFirstPerson(cv),
    ...scanProfileSentence2HasNumber(cv),
    ...scanProfileTricolon(cv),
    ...scanProfileEmDash(cv),
    ...scanProfileOpeningAdjectiveStack(cv),
    ...scanProfileCloseValidity(cv),
    ...scanProfileSentenceVariance(cv),
    ...scanProfileSpecificityAnchor(cv),
    ...scanProfileBrandTierEmployer(cv),
    ...scanProfileAnchorLeak(cv),
    ...scanProfileOutcomeSignal(cv),
    ...scanProfileScopeAnchorLeak(cv),
    ...scanProfileSubstantialS2Number(cv),
    ...scanProfileS3Strength(cv),
  ];
}

// ── Targeted rewrite of offending sections ────────────────────────────────────

// Map each flagged issue to a specific, actionable fix instruction so the model
// knows HOW to fix it, not just that it's wrong. Generic "fix the flagged stuff"
// prompts result in the model regenerating the same shape.
export function buildFixGuidance(flagged: BannedHit[], cv: TailoredCV): string {
  const lines: string[] = [];
  for (const f of flagged) {
    const where = f.section;
    const what = f.phrase;
    let fix = "";
    if (/tricolon/i.test(what)) {
      fix = "Pick the TWO strongest items from the 3-item list and drop the third. Use 'X and Y' (no third item). Do NOT replace with another tricolon.";
    } else if (/third-person verb/i.test(what)) {
      fix = "Restart the sentence with either a gerund ('Owning…', 'Running…', 'Building…') or a noun-form ('Sole [role]', 'As the only person in the role…') — NEVER a verb ending in -s.";
    } else if (/first-person pronoun/i.test(what)) {
      fix = "Drop 'I/my/me' entirely. Lead with the action or role: 'Built X…' not 'I built X…'.";
    } else if (/sentence 2 contains no number/i.test(what)) {
      fix = "Lead Sentence 2 with the dominant scope anchor from the FactBase (e.g. '2x revenue growth', 'across 12 overseas suppliers', '£40M category'). The number is the centrepiece, not a clause.";
    } else if (/em-dash/i.test(what)) {
      fix = "Replace every em-dash (—) with a comma, full stop, or restructure the sentence. Em-dashes are a Claude tell.";
    } else if (/adjective stack/i.test(what)) {
      fix = "Restart Sentence 1 with role + context. Drop ALL leading adjectives ('Dedicated', 'Results-driven', 'Passionate', etc.).";
    } else if (/closing sentence is a generic/i.test(what)) {
      fix = "Replace the close with either a fact-anchored close (degree + classification + university) OR a NAMED target close ('Targeting [specific role] at [specific employer/sector]'). Drop any 'seeking to leverage' / 'in a dynamic environment' phrasing.";
    } else if (/uniform length/i.test(what)) {
      fix = "Rewrite at least one sentence to be shorter (<14 words) and one to be longer (>20 words). Variance is a quality signal.";
    } else if (/length is .* words/i.test(what)) {
      fix = "Adjust to 60-100 words across 3-4 sentences. Cut filler if too long; add a load-bearing claim if too short.";
    } else if (/translating data/i.test(what) || /actionable/i.test(what)) {
      fix = "Drop the buzz phrase entirely. Use the concrete verb of what was actually done (analysed, reported, surfaced).";
    } else if (/spearhead|leverage|orchestrate|champion|pioneer|drove|underpin/i.test(what)) {
      fix = "Replace the banned verb with a plain, concrete alternative: built, designed, ran, led, delivered, reduced, recovered, switched, negotiated.";
    } else if (/JD echo/i.test(what)) {
      fix = "Reword to use individual JD terms in your own factual statements; do NOT copy 4+ word phrases from the JD verbatim.";
    } else if (/contains no specific named item/i.test(what)) {
      fix = "Replace one abstract claim with a SPECIFIC named item from the FactBase: a built system (e.g. 'Airtable ERP', 'supplier scorecard'), a named brand from a previous role (e.g. 'Siemens DISW', 'Goldman Sachs'), a recovered £-amount, a named tool (e.g. 'Power BI'), or a named credential. The Profile must include at least ONE specific named anchor.";
    } else if (/S1 contains current employer name/i.test(what)) {
      fix = "Remove the current employer's name from sentence 1 entirely. The employer name lives in the Experience section. Replace 'X at [Employer]' with just 'X' (no employer mention) OR add a real scale/sector descriptor instead (e.g. 'at a £10M consumer-goods business' — only if you have a real scale signal).";
    } else if (/sole\/ownership claim word/i.test(what)) {
      fix = "Remove the word 'sole' / 'only [role]' / 'founding' / 'first hire' from this sentence. The ownership claim moves to S3 only. Restructure the sentence around the work scope or scope anchor instead.";
    } else if (/no outcome signal/i.test(what)) {
      fix = "Add an outcome anchor in S2 or S3. From the FactBase pull a £-amount, %-improvement, count, before/after delta, or named outcome verb (recovered/saved/switched/cut/scaled/closed/shipped). Pair it with the existing capability claim so the sentence reads as 'did X, achieving outcome Y'.";
    } else if (/scope anchor.*S2 only|S1 contains a scope anchor/i.test(what)) {
      fix = "Remove ALL scope-anchor language from S1 — no '2x revenue', no '£X', no 'doubled', no 'during a period of...growth'. Move the scope anchor to S2 as the centrepiece. S1 must lead with role + work scope only.";
    } else if (/no substantial scope anchor/i.test(what)) {
      fix = "Replace the frequency word in S2 with a real scale signal from the FactBase: growth multiple (e.g. '2x revenue'), £/$/€-figure, %, named count ('12 overseas suppliers'), or before/after delta. S2 must combine this scope anchor with a specific named action.";
    } else if (/reporting claim.*without a paired specific/i.test(what)) {
      fix = "Pair the reporting claim with a specific anchor: a named system ('via the supplier scorecard built from scratch'), a named scope detail ('owning the function from purchase-order through to delivery'), or a named count ('across 12 overseas suppliers'). Reporting cadence alone is filler.";
    } else if (/uniform length/i.test(what) || /bullets are uniform/i.test(what)) {
      fix = "Vary bullet length: at least one short bullet (10-13 words), one medium (15-20), and one longer (22-28).";
    } else if (/invented sector descriptor/i.test(what)) {
      fix = "DELETE the sector descriptor from S1 entirely. Do NOT replace it with another descriptor. S1 must lead with role + work scope only — e.g. 'Supply Chain Analyst working across procurement and supplier performance to keep operations running efficiently.' If you absolutely cannot avoid mentioning the employer's nature, use ONLY language that already appears verbatim in the FactBase.";
    } else {
      fix = "Rewrite to follow the system prompt rules.";
    }
    lines.push(`- [${where}] ${what}\n  → FIX: ${fix}`);
  }
  // Suppress unused-arg warning if cv ever stops being read
  void cv;
  return lines.join("\n");
}

async function rewriteOffendingSections(args: {
  cv: TailoredCV;
  flagged: BannedHit[];
  jdText: string;
  factbaseText: string;
  connectedProviders: Partial<Record<string, string>>;
  attempt?: number;
}): Promise<TailoredCV | null> {
  const { cv, flagged, jdText, factbaseText, connectedProviders, attempt = 0 } = args;
  const flaggedList = flagged.map((f) => `  - [${f.section}] phrase: "${f.phrase}"`).join("\n");

  // Build per-issue-type fix instructions so the model knows EXACTLY how to fix
  // each flagged item, not just that it's flagged.
  const fixGuidance = buildFixGuidance(flagged, cv);

  // Second attempt gets stronger language because the first rewrite failed.
  const escalatedHeader = attempt >= 1
    ? `THIS IS THE SECOND REWRITE ATTEMPT — the previous rewrite STILL failed the critic. Be ruthless. Do not produce another output that contains any of the flagged phrases or patterns. If a word is banned in a sentence, the corrected sentence must not contain that word at all.

`
    : "";

  const fixupPrompt = `${escalatedHeader}Your previous CV output failed the critic. Each flagged issue below comes with the EXACT fix to apply. Apply every fix.

FLAGGED ISSUES AND FIXES:
${fixGuidance}

GLOBAL RULES (re-apply on rewrite):
- Profile: 3-4 sentences, 60-100 words. Implied first person (no I/my, no third-person -s verbs at sentence start). Strict sentence-role separation: S1=role+work, S2=dominant scope anchor (anchor appears HERE only), S3=ownership/distinctive (appears HERE only), S4=close.
- Anchors-appear-once: scope anchor in S2 only, sole/ownership claim in S3 only, role title in S1 only. No repetition across sentences.
- No tricolons (X, Y, and Z) in any Profile sentence — use 2 items max.
- No em-dashes in Profile.
- No banned phrases or JD echo anywhere in the CV.
- Truth Contract: every claim must still trace to the FactBase.

Previous (flawed) output:
${JSON.stringify(cv)}

JOB DESCRIPTION:
${jdText.trim()}

CANDIDATE FACTBASE:
${factbaseText}

Return ONLY the corrected JSON, fully rewritten.`;

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

PROFILE EVIDENCE-SELECTION LOGIC (HARD — applies to every Profile generation):

This is the MOST IMPORTANT step before writing the Profile. Do this BEFORE choosing a sentence shape.

Step 1 — Inventory: read EVERY achievement, skill, and work-history fact in the FactBase. Do not skip any. The user's strongest material may not be the most obviously JD-relevant on first glance.

Step 2 — Score each item on these six dimensions (0-3 each):
  (a) Direct JD keyword match — does the JD ask for this exact thing?
  (b) Concrete quantified outcome — does the item have a number, £-figure, before/after, scope anchor?
  (c) Distinctiveness — is this uncommon for someone at this stage / in this sector?
  (d) Builder / from-scratch signal — did the user build, design, found, or rebuild something?
  (e) Brand / scale signal — named brand, named client, named scale (£M, headcount, geography)?
  (f) Reframability — could this be re-angled to land for the JD even if not a direct keyword match?

Step 3 — Pick the top 2-4 items by combined score. The Profile is a 4-sentence highlight reel: it can hold 2-4 strong signals max.

CRITICAL: do NOT default to "most JD-keyword-matched" alone. A skill that scores 2/3 on direct match but 3/3 on distinctiveness + 3/3 on builder signal often beats a 3/3 direct match that's bland. Recruiters remember distinctive details.

REFRAMING — actively consider how non-obvious skills can be made JD-relevant:
- "AI tools introduction at [previous employer]" can be reframed as "early adopter of enterprise AI tooling" for any forward-looking role.
- "Conversion-rate optimisation testing" can be reframed as "commercial / analytical thinking applied across functions" for a broader analyst role.
- "Built an internal task-tracking app" can be reframed as "builder mindset / shipped working software without engineering support" for any role valuing initiative.
- A graduate's "society treasurer" role can be reframed as "P&L responsibility for a £X budget" for finance-tier applications.

The Profile should surface the user's BEST evidence for THIS JD, not just the most obviously matching evidence. Reframable distinctive material often wins.

WHAT NOT TO DO:
- Do not block out a strong skill because it's not on the JD's keyword list — if it's reframable and distinctive, it earns its place.
- Do not invent reframings. Every reframing must trace to a real skill / achievement in the FactBase. Truth contract still applies.
- Do not stuff more than 2-4 items into the Profile. Stronger material that didn't make the Profile lives in the Experience bullets.

EMPLOYER-DESCRIPTOR IN S1 (REFINED):
If the employer is not on the brand-tier list, you MAY include a sector-descriptor IF it adds real signal. Real signals only:
- Sector + named scale ("at a £10M consumer-goods business", "at a 200-person SaaS scale-up")
- Sector + market position ("at a top-3 UK home-decor retailer")
- Sector + named market context ("at an FMCG export business serving EU and US")

Decorative descriptors are BANNED:
- "growing" / "fast-growing" / "thriving" — banned
- "innovative" / "forward-thinking" / "dynamic" — banned
- "leading" / "best-in-class" / "world-class" — banned
- Any pure adjective + sector with no scale/position signal — banned

If you don't have a real scale/position signal, OMIT the descriptor entirely. The employer name lives in Experience.
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

PROFILE RULES (HARD — these are the structural spec for the Profile section)

LENGTH:
- 3–4 sentences, 60–100 words total.
- Paragraph form only — never bullets.

VOICE — IMPLIED FIRST PERSON (NON-NEGOTIABLE):
- Never use "I", "I'm", "I've", "I am", "I have", "my", "me" anywhere in the Profile.
- Never use third-person verbs about the candidate: "Produces…", "Holds…", "Brings…", "Manages…", "Tracks…", "Delivers…", "Demonstrates…", "Possesses…", "Operates…", "Specialises…" — these read as a recruiter speaking ABOUT a person, not as the person themselves. Banned.
- The right voice is implied first person: state actions and facts directly without subject pronouns. Example: "Sole Supply Chain Analyst at Grain and Frame, running end-to-end procurement…" NOT "Tom is a Supply Chain Analyst…" NOR "I am a Supply Chain Analyst…" NOR "Produces reports for senior stakeholders…".

PROFILE TEMPLATE BY USER SITUATION (CRITICAL — pick the right template):

Determine which template to use by inspecting the candidate's most recent role/sector against the target JD:

(a) ACHIEVEMENT-LED — same-sector mid-career. Candidate's current sector matches or closely adjacent to JD sector, and they have 1+ years in the role. **Default for most users.**
(b) CAREER-CHANGER — current sector differs significantly from JD sector (e.g. marketing → supply chain, law → tech, finance → product). The bridge IS the story.
(c) STACK-LED — JD is engineering/data/product/devops/ML. Stack and named tools are credentials.
(d) BRAND-LED — JD is creative/marketing/content. Named brands and engagement metrics lead.
(e) GRADUATE-LED — candidate has under 12 months full-time experience. Degree + classification + university lead.

Pick ONE template. If genuinely ambiguous, default to (a) Achievement-Led. The user may also override via their CV preferences.

— TEMPLATE (a) ACHIEVEMENT-LED —

STRICT SENTENCE-ROLE SEPARATION (each sentence does ONE job, no overlap):
S1 = WHO. Role + work breadth + sector context. NO scope anchor. NO sole/ownership claim.
S2 = WHAT. Dominant scope anchor PAIRED with a specific named action. NEVER one without the other. The number/scale lives HERE only.

S2 PAIRING RULE (HARD): S2 must combine BOTH:
  (i) A scope anchor — number, £/$/€-figure, growth multiple ("2x revenue"), count, named scale
  (ii) A specific named action that delivered or operated within that scope — built/designed/launched a NAMED system; recovered a NAMED amount; switched a NAMED provider; joined a NAMED brand
Single-signal S2 (scope only OR specifics only) is insufficient.
GOOD S2 (paired): "Scaled the function through a period of 2x revenue growth, building a supplier scorecard from scratch to absorb wider product complexity."
GOOD S2 (paired): "Closed £4.2M in indirect-spend savings across 31 contracts by consolidating fragmented vendor base from 180 to 47."
GOOD S2 (paired): "Shipped the user-facing checkout for a 1.4M-user fintech, sustaining sub-200ms latency at 3x peak traffic."
BAD S2 (scope only, no specifics): "Scaled the function through a period of 2x revenue growth." [WRONG — no specific named action]
BAD S2 (specifics only, no scope): "Built an Airtable-based ERP system and a supplier scorecard." [WRONG — no scope/scale/number]
BAD S2 (neither): "Managed end-to-end procurement across the business." [WRONG]
S3 = DISTINCTIVE. ONE ownership/breadth/stakeholder claim, not two. The single most JD-relevant distinctive claim lives HERE, nowhere else. Pick the strongest single ownership signal (e.g. "sole [role]", "founding [function]", "first [discipline] hire", "owning [function] from [scope] to [scope]"). Do NOT cram two ownership claims into one sentence — that produces meandering S3s. The other ownership signals belong in the Experience section.
S4 = CLOSE. Fact (degree+classification+uni) OR named target ("Targeting [specific role] at [specific employer/sector]").

ANCHORS-APPEAR-ONCE RULE (HARD):
- The dominant scope anchor (e.g. "2x revenue growth", "£40M category", "12 overseas suppliers") appears in S2 ONLY. Do NOT mention it in S1 or S3.
- The sole/ownership claim (e.g. "Sole [role]", "only person in the role", "single-handedly") appears in S3 ONLY. Do NOT mention it in S1 or S2.
- The role title appears in S1 ONLY (it can be implicit later but never repeated as a claim).
- Each Profile claim has ONE home. Repetition across sentences is banned — every word should be earning new information.

GOOD EXAMPLES — 5 sectors, all rules followed (anchors-appear-once, no tricolons, implied first person, strict sentence-role separation):

(i) PROCUREMENT / OPERATIONS (achievement-led):
S1: "Procurement Analyst running supplier negotiation and category management across packaging and indirect spend."
S2: "Cut £2.1m from indirect-spend categories in 12 months, consolidating fragmented vendor base from 180 to 47 suppliers."
S3: "Sole category lead for indirect spend across the business, with weekly category-spend reporting to the CFO."
S4: "Chartered Member of CIPS (MCIPS), 2:1 Economics from Durham University."

(ii) SOFTWARE ENGINEERING (stack-led):
S1: "Full-stack engineer with 5 years building React and Node systems for B2B SaaS."
S2: "Shipped the user-facing checkout for a 1.4M-user fintech, sustaining sub-200ms latency at 3x peak traffic."
S3: "Founding engineer at the company, owning all production deploys and on-call rotation."
S4: "Targeting a senior platform-engineering role at a Series-B fintech."

(iii) MARKETING / CREATIVE (brand-led):
S1: "Senior Brand Marketer with 6 years across Unilever, Diageo, and Innocent Drinks."
S2: "Led the 2024 Diageo flagship campaign across UK and Ireland, lifting brand-aided recall 18 points."
S3: "Single point of contact for the agency relationship across paid, earned, and owned channels."
S4: "Targeting a Director of Brand role at a challenger consumer business."

(iv) CAREER-CHANGER (teacher → data analyst):
S1: "Secondary maths teacher of 4 years now training as a data analyst, with two completed projects in Python and SQL."
S2: "Brings analytical rigour, structured stakeholder communication, and curriculum-data analysis from previous role."
S3: "Built and shipped a 6-month dataset-modelling project on UK education attainment as part of a recognised conversion programme."
S4: "Targeting an analyst role at an education-tech business."

(v) GRADUATE (degree-led):
S1: "First-Class Economics graduate from the University of Bristol, top decile of the cohort."
S2: "Completed a 12-month placement at PwC Audit, contributing to FTSE-250 audit engagements during reporting season."
S3: "Strongest in financial modelling, structured client-facing communication, and Excel/Power BI."
S4: "Targeting a graduate Investment Banking analyst role at a London-based bank."

Note across ALL FIVE:
- Scope anchor in S2 only, never repeated.
- Distinctive / ownership claim in S3 only, never repeated.
- Role title or candidate identity stated once in S1.
- No tricolons in any sentence.
- Implied first person — no "I/my", no third-person -s verbs at sentence start.
- Each claim has one home; no information is repeated across sentences.

BAD EXAMPLES — common failure modes to avoid:

(i) Scope anchor in S1 instead of S2 (anchor-leak):
"Procurement Analyst running supplier negotiation across £2.1m of indirect spend." [WRONG — that anchor belongs in S2]

(ii) Tricolon in any sentence:
"Cutting costs, consolidating suppliers, and improving compliance across the business." [WRONG — 3-item list with "and"]

(iii) Adjective stack opener:
"Results-driven, detail-oriented Procurement Analyst with a passion for data." [WRONG — banned adjectives, no role/scope]

(iv) Third-person -s verb opener in S3:
"Owns category strategy across indirect spend." [WRONG — "Owns" is third-person; use "Owning…" gerund or "Sole owner of…" noun-form]

(v) Generic forward-looking close:
"Seeking a dynamic environment where I can leverage my skills." [WRONG — generic aspiration; close must be a fact OR a NAMED target]

(vi) Skill-list S3 (this is a Skills-section job, not Profile):
"Excel, SQL, Power BI, and stakeholder management." [WRONG — skill list belongs in Skills section, not Profile S3]

(vii) Repeated claim across sentences:
S2 mentions "£2.1m of cost cut" and S3 also says "having cut £2.1m" — WRONG, anchor appears in S2 only.

— TEMPLATE (b) CAREER-CHANGER —
S1: anchor the pivot honestly. Format: "[Old credential / current discipline] now running [new function] at [scope]". Example: "Marketing graduate now running end-to-end supply chain at a small overseas-supplier business as the sole analyst."
S2: 2-3 NAMED transferable skills tied to the JD requirements (e.g. data analysis, stakeholder management, structured reporting, supplier negotiation). Specific, JD-aligned, evidence-backed — not generic.
S3: dominant achievement from current role that proves the transferable skills (the bridge).
S4: optional fact close OR named target.

— TEMPLATE (c) STACK-LED —
S1: years + stack + specialism. Example: "Full-stack engineer with 5 years building React/Node/AWS systems for B2B SaaS."
S2: scale/scope (users, QPS, ARR, transactions, named clients).
S3: distinctive engineering achievement or context (open-source, founding engineer, on-call, named system).
S4: optional GitHub/portfolio anchor or named target.

— TEMPLATE (d) BRAND-LED —
S1: role + named brands or named clients.
S2: engagement/conversion/audience metric.
S3: distinctive method, signature campaign, or sector specialism.
S4: portfolio URL or named target.

— TEMPLATE (e) GRADUATE-LED —
S1: degree + classification + university + cohort signal (top of cohort, dean's list).
S2: strongest placement/internship/project achievement WITH measurable outcome.
S3: target-role context + 2-3 transferable skills.
S4: target role/sector close.

EMPLOYER NAME IN S1 (HARD RULE — applies to all templates):
ONLY include the current employer's name in S1 if it is a widely-recognised brand. The acceptable list:
- FTSE 100 / S&P 500 / EuroStoxx 50
- FAANG / Big Tech (Apple, Microsoft, Google, Meta, Amazon, Netflix, Tesla, Nvidia)
- MBB consulting (McKinsey, Bain, BCG)
- Magic Circle law (Allen & Overy, Clifford Chance, Freshfields, Linklaters, Slaughter and May)
- Big 4 (Deloitte, PwC, EY, KPMG)
- Bulge Bracket banks (Goldman Sachs, JPMorgan, Morgan Stanley, BofA, Citi, etc.)
- Globally household-name unicorns (Stripe, Airbnb, Uber, OpenAI, Anthropic, etc.)

If the employer is NOT on this level of recognition, OMIT the employer name from S1. The employer name belongs in the Experience section. This is non-negotiable. A small or unknown employer in S1 weakens the candidate.

DOMINANT SCOPE ANCHOR RULE (HARD — applies to S2 of templates a, b, c):
If the FactBase contains a single dominant scope/scale signal — e.g. "managed through 2x revenue growth", "during a £40M category build", "across 12 overseas suppliers", "$100M ARR business" — that anchor MUST be the centrepiece of sentence 2, not a buried clause anywhere else. Do not let JD-aligned-but-smaller achievements (e.g. a tracking system) outrank a bigger scope anchor.

S3 OWNERSHIP-LED RULE (HARD — applies to template (a)):
S3 must surface what makes the candidate distinctive — sole ownership, function breadth, director-level reporting, multi-year tenure, founding-team status. NOT a list of tools or a skills mention.

GOOD S3 examples (implied first person, no third-person -s verbs):
- "Owning the supply chain function end-to-end as the only person in the role, with weekly reporting direct to the directors."  (gerund opener)
- "Sole owner of the function across procurement, planning, logistics, and supplier management."  (noun-form opener)
- "Acts as the only Supply Chain Analyst across the business, reporting weekly to senior leadership."  (compound verb opener — "Acts as" is OK)
- "As the only person in the role, the function spans procurement, planning, and supplier management with weekly senior-leadership reporting."  (descriptive opener)

BAD S3 (do NOT do these):
- "Excel and Airtable underpin daily demand analysis and reporting."  (tool-led, banned verb)
- "Skilled in Excel, Power BI, supplier management, and stakeholder reporting."  (skill list — belongs in Skills section, not Profile)
- "Strong analytical and process improvement capability."  (vague self-claim)
- "Owns the function end-to-end…"  (BANNED: "Owns" is a third-person -s verb at sentence start. Use "Owning…" instead.)

NO TRICOLON IN ANY PROFILE SENTENCE (HARD):
Tricolon = a list of 3 items separated by commas with "and" before the last item. Banned in S1, S2, S3, AND S4. Always pick one or two; never three.

GOOD: "running procurement and planning across an overseas supplier base" (2 items)
GOOD: "scaled the function through 2x revenue growth, building a supplier scorecard from scratch" (2 distinct claims)
BAD:  "running procurement, planning, and supplier performance" (tricolon)
BAD:  "managing higher purchase order volumes, greater product complexity, and a wider supplier base" (tricolon)

If you find yourself listing three things, prune to one or two and let other strengths land in the Experience section.

BANNED STRUCTURAL PATTERNS:
- NO tricolons in sentence 2 — i.e. "built X, designed Y, and resolved Z". Pick the strongest single achievement; do not list three.
- NO em-dashes anywhere in the Profile (em-dash is a Claude tell). Use commas, full stops, or restructure.
- NO opening adjective stack — sentence 1 must NOT start with "Dedicated, organised and detail-oriented…" or any 2+ adjective comma-separated opener. Lead with role + context.
- NO three sentences of identical length. Vary cadence: at least one short (<14 words) and one longer (>20 words) per Profile.

BANNED CLOSES:
- "Looking to apply / bring / leverage / contribute…"
- "Seeking to leverage…"
- "Eager to contribute / apply / bring…"
- "Excited to apply / join…"
- "with strong [X] capability"
- "with a passion for [Y]"
- "with proven [Z]"
- Generic environment language: "fast-paced", "fast-moving", "dynamic", "innovative", "forward-thinking", "high-growth" + environment/organisation/company/workplace/team.
- Trailing add-ons that just list extra credentials with "supported by…" — these read as patched-on rather than a real close.

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
  preTailoredProfile?: string;
}): string {
  const { factbaseText, jdText, companyName, roleName, preTailoredProfile } = args;
  const targetLine = [companyName && `Target company: ${companyName}`, roleName && `Target role: ${roleName}`]
    .filter(Boolean)
    .join("\n");

  const profileSection = preTailoredProfile
    ? `=== PRE-TAILORED PROFILE (MUST USE VERBATIM) ===
The user's Master Profile has already been tailored to this JD by a separate process. Use the following text VERBATIM as the "summary" field of your output. DO NOT rewrite, edit, summarise, or alter this text in any way:

${preTailoredProfile}

`
    : "";

  return `${targetLine ? targetLine + "\n\n" : ""}=== JOB DESCRIPTION ===
${jdText.trim()}

=== CANDIDATE FACTBASE ===
${factbaseText}

${profileSection}=== TASK ===
Produce a UK-conventional, ATS-safe, JD-tailored CV using ONLY the FactBase above.
- Pick the bullets and skills with the highest JD relevance.
- Rewrite each chosen bullet using the XYZ formula where possible, but stay strictly within what the FactBase supports.
${preTailoredProfile
  ? "- The Profile (\"summary\" field) is PRE-DETERMINED above. Copy it verbatim into the output. Do not modify it."
  : "- Build a 3–4 line summary that anchors on the candidate's most JD-relevant existing experience."}
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
