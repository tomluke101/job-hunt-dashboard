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

  // Post-process critic: scan for banned phrases, JD echo, and uniform-length
  // bullets. Any hit triggers a single targeted AI call to rewrite the offenders.
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

function scanProfile(cv: TailoredCV): BannedHit[] {
  return [
    ...scanProfileLength(cv),
    ...scanProfileImpliedFirstPerson(cv),
    ...scanProfileSentence2HasNumber(cv),
    ...scanProfileTricolon(cv),
    ...scanProfileEmDash(cv),
    ...scanProfileOpeningAdjectiveStack(cv),
    ...scanProfileCloseValidity(cv),
    ...scanProfileSentenceVariance(cv),
  ];
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

PROFILE RULES (HARD — these are the structural spec for the Profile section)

LENGTH:
- 3–4 sentences, 60–100 words total.
- Paragraph form only — never bullets.

VOICE — IMPLIED FIRST PERSON (NON-NEGOTIABLE):
- Never use "I", "I'm", "I've", "I am", "I have", "my", "me" anywhere in the Profile.
- Never use third-person verbs about the candidate: "Produces…", "Holds…", "Brings…", "Manages…", "Tracks…", "Delivers…", "Demonstrates…", "Possesses…", "Operates…", "Specialises…" — these read as a recruiter speaking ABOUT a person, not as the person themselves. Banned.
- The right voice is implied first person: state actions and facts directly without subject pronouns. Example: "Sole Supply Chain Analyst at Grain and Frame, running end-to-end procurement…" NOT "Tom is a Supply Chain Analyst…" NOR "I am a Supply Chain Analyst…" NOR "Produces reports for senior stakeholders…".

STRUCTURE — WHO / WHAT / HOW:
- Sentence 1 (WHO): role + experience anchor + specialism. Lead with the ROLE and the WORK, not the employer name. ONLY include the current employer's name in sentence 1 if it is a widely-recognised brand (FTSE 100, Big 4, Magic Circle, FAANG, well-known global firm). If the employer is a small business or unknown brand, omit the employer from sentence 1 — the employer name lives in the Experience section. Example (small employer, omit name): "Sole Supply Chain Analyst running end-to-end procurement and materials planning across an overseas supplier base." Example (brand-name employer, keep name): "Senior Associate at Goldman Sachs covering Strategic Supplier Management."

- Sentence 2 (WHAT): a quantified, specific achievement that proves Sentence 1. **MUST contain a number, scope, or scale-anchor** (£, %, count, growth multiple like "2x revenue", before/after delta, geography count, frequency, "from scratch", "first-ever"). This is the load-bearing sentence.

  DOMINANT SCOPE ANCHOR RULE (HARD): if the FactBase contains a single dominant scope/scale signal — e.g. "managed through 2x revenue growth", "during a £40M category build", "across 12 overseas suppliers", "at a £200M ARR business" — that anchor MUST be the centrepiece of sentence 2, not a buried clause anywhere else. Identify the single strongest scope anchor in the candidate's evidence and lead sentence 2 with it. Do not let JD-aligned-but-smaller achievements (e.g. a tracking system) outrank a bigger scope anchor.

- Sentence 3 (HOW): distinctive context, breadth, ownership, stakeholder level, or methods that deliver the achievement. NOT a list of tools. Tools belong in the Skills section. Sentence 3 should sell what makes the candidate different — sole ownership, function breadth, director-level reporting, multi-year tenure, founding-team status, etc. Examples of GOOD S3:
  - "Acts as the only person in the role, with weekly procurement and supplier-performance reporting going direct to the directors."
  - "Owns the function end-to-end across procurement, planning, logistics, and supplier management as the sole hire in the seat."
  - "Reports weekly to the senior leadership team on supplier performance, stock position, and procurement spend."
  Examples of BAD S3 (do NOT do this):
  - "Excel and Airtable underpin daily demand analysis and reporting."  (tool-led, weak verb)
  - "Skilled in Excel, Power BI, supplier management, and stakeholder reporting." (skill list — belongs in Skills)
  - "Strong analytical and process improvement capability." (vague self-claim)

- Sentence 4 (OPTIONAL CLOSE): either a NAMED target ("Targeting a Strategic Supplier Management Associate role at Goldman Sachs…") OR a fact-anchored close (degree class + uni, named credential, named credibility signal). Never generic forward-looking aspiration.

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
