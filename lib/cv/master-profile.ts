// Master Profile — the user's canonical, sector-agnostic Profile.
//
// Generated once (or refreshed when source data changes), edited by the user,
// saved permanently. Every CV generation uses Master as the starting point
// and tailors it to the specific JD.

import { callAI } from "@/lib/ai-router";
import type { Provider } from "@/lib/ai-providers";
import { extractFactBase } from "./extract";
import { factsOfKind, type FactBase } from "./factbase";
import {
  scanProfile,
  scanBannedPhrases,
  scanProfileCareerChangerMode,
  scanProfileSoleClaimVsFactBase,
  scanProfileScopeAnchorVsFactBase,
  killEmDashesDeterministic,
  killAbsorbingDeterministic,
  buildFixGuidance,
  type BannedHit,
} from "./tailor";
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

// Deterministic exclusion enforcement.
//
// Exclusions are passed as a HARD rule in the system prompt, but AI compliance
// is not 100%. This scanner catches any excluded phrase that slipped through,
// AND variants the AI paraphrased around. Two layers:
//
//   (a) Exact substring match — catches the literal exclusion verbatim.
//   (b) Token-proximity stem match — catches concept-level variants. If the
//       user excludes "supplier performance tracker", we want to catch
//       "supplier performance tracking system", "supplier performance
//       dashboard", "tracker for supplier performance", etc. We tokenise,
//       drop stop words, take 5-char prefix as a naive stem, and check if
//       all stems appear within an 8-word window of the Profile.
//
// Single-word exclusions only use (a) — proximity matching on one token is
// just substring matching of a prefix, which would over-flag.
const EXCLUSION_STOP_WORDS = new Set([
  "a", "an", "the", "of", "in", "on", "for", "and", "or", "to", "by", "with",
  "from", "at", "as", "is", "are", "was", "were", "be", "been",
]);

function exclusionStems(phrase: string): string[] {
  const stems = phrase
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((t) => t && !EXCLUSION_STOP_WORDS.has(t))
    .map((t) => t.slice(0, Math.min(5, t.length)));
  return stems;
}

function proximityStemsPresent(
  text: string,
  stems: string[],
  windowSize: number
): boolean {
  if (stems.length === 0) return false;
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  // Slide a window of size `windowSize` across the text; if every stem appears
  // as a prefix of any word inside the window, flag as a match.
  for (let start = 0; start < words.length; start++) {
    const end = Math.min(start + windowSize, words.length);
    const window = words.slice(start, end);
    const allFound = stems.every((s) =>
      s.length >= 3 && window.some((w) => w.startsWith(s))
    );
    if (allFound) return true;
  }
  return false;
}

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

    // (a) Exact substring match.
    if (summaryLower.includes(needle)) {
      hits.push({
        section: "Profile",
        phrase: `Profile contains the excluded phrase "${e}". Remove it entirely. The user has explicitly forbidden this in any Profile generation, regardless of JD relevance.`,
      });
      continue;
    }

    // (b) Variant match — token-proximity stem check. Only for multi-word
    // exclusions; single-word exclusions are handled by exact match alone.
    const stems = exclusionStems(needle);
    if (stems.length < 2) continue;
    if (proximityStemsPresent(args.summary, stems, 8)) {
      hits.push({
        section: "Profile",
        phrase: `Profile contains a concept-level variant of the excluded phrase "${e}" — the model paraphrased around the literal text but the underlying concept is still present. Remove ALL near-paraphrases of "${e}" (e.g. variants that swap one word but keep the underlying claim).`,
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

// Server-side automatic FactBase-fit assessment for a target role family.
// Used by generateMasterProfileFromFactBase when the caller didn't supply a
// fit value (typical on regenerate — the gap modal only ran on first
// generation, so the fit assessment from there isn't available).
//
// Without this, regenerated Masters for irrelevant role families silently
// drop back to non-career-changer mode and the pivot / bridge / named-
// target scanners don't fire. With this, every Master generation for a
// target-family Master runs through proper career-changer mode (or
// confirms "strong" fit and uses the standard prompt).
//
// Cost: one extra AI call (~3-5s) per generation when target family is
// set. Worth it for correctness.
async function assessFactBaseFitForFamily(args: {
  factbaseText: string;
  targetRoleFamily: string;
  targetSector?: string;
  connectedProviders: Partial<Record<Provider, string>>;
}): Promise<{
  fit: "strong" | "transferable" | "minimal";
  transferableAngles: string[];
} | null> {
  const { factbaseText, targetRoleFamily, targetSector, connectedProviders } = args;
  if (!targetRoleFamily.trim()) return null;

  const systemPrompt = `You assess how well a candidate's FactBase supports a target role family.

Output a single JSON object:
{
  "fit": "strong" | "transferable" | "minimal",
  "transferableAngles": ["<short noun-phrase>", ...]
}

FIT LEVELS:
- "strong" — Direct evidence of ${targetRoleFamily} work in the candidate's roles, achievements, or skills. The candidate has DONE this kind of work.
- "transferable" — NO direct evidence for ${targetRoleFamily}, but multiple reframable transferable skills exist (analytical structure, stakeholder communication, project delivery, data work, written reasoning, etc.). The candidate is a career-changer pivoting in.
- "minimal" — Essentially zero overlap. No direct evidence AND limited transferable signal.

TRANSFERABLE-ANGLES (when fit is "transferable" or "minimal"):
List 2-4 short noun-phrase angles the candidate has that DO carry transferable signal for ${targetRoleFamily}. Examples for Supply Chain → Legal: ["analytical structure from supplier-performance work", "contract handling via supplier negotiation", "stakeholder reporting at director level", "First-Class academic record"].

For "strong" fit, return transferableAngles: [].

Output ONLY the JSON object.`;

  const userPrompt = `=== CANDIDATE FACTBASE ===
${factbaseText || "(empty FactBase)"}

=== TARGET ROLE FAMILY ===
${targetRoleFamily.trim()}${targetSector?.trim() ? ` (sector: ${targetSector.trim()})` : ""}

=== TASK ===
Assess FactBase fit for the target family. Return ONLY the JSON object.`;

  try {
    const result = await callAI({
      task: "cv-tailor",
      connectedProviders,
      systemPrompt,
      prompt: userPrompt,
    });
    const trimmed = result.text.trim();
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start === -1 || end === -1) return null;
    const parsed = JSON.parse(trimmed.slice(start, end + 1)) as {
      fit?: unknown;
      transferableAngles?: unknown;
    };
    const fit: "strong" | "transferable" | "minimal" =
      parsed.fit === "strong" || parsed.fit === "transferable" || parsed.fit === "minimal"
        ? parsed.fit
        : "strong";
    const transferableAngles: string[] = Array.isArray(parsed.transferableAngles)
      ? parsed.transferableAngles
          .filter((a): a is string => typeof a === "string" && a.trim().length > 0)
          .map((a) => a.trim())
          .slice(0, 6)
      : [];
    return { fit, transferableAngles };
  } catch (e) {
    console.error("[assessFactBaseFitForFamily] error:", e);
    return null;
  }
}

// Build a sector-agnostic Profile from the FactBase. No JD — produces the user's
// strongest unconditional version of themselves, applying all the same rules
// (implied first person, scope-anchor in S2, distinctive S3, fact close).
export async function generateMasterProfileFromFactBase(opts: {
  cvId?: string;
  connectedProviders: Partial<Record<Provider, string>>;
  wizardContext?: WizardContextLib;
  exclusions?: string[];
  // Optional — when provided, the Profile is tailored to this JD instead of
  // sector-agnostic. Used by the full-CV bypass / no-Master path so the
  // generated Profile gets the Master-grade prompt + critic loop AND the JD
  // context for vocabulary alignment. The sector-agnostic Master generator
  // (Profile page) omits this.
  targetJdText?: string;
  // Optional — target role family for this Master (e.g. "Procurement",
  // "Consulting", "Product Management"). When set, the AI surfaces FactBase
  // evidence relevant to this family and reframes vocabulary. Different
  // from targetJdText: this is a sector-level intent that persists with the
  // Master, not a JD-specific tailoring.
  targetRoleFamily?: string;
  targetSector?: string;
  // Optional — FactBase fit assessment for the target family. When
  // "transferable" or "minimal", the prompt FORCES the CAREER-CHANGER
  // template — no risk of the model accidentally producing achievement-led
  // framing for a candidate whose FactBase doesn't actually support direct
  // claims in the target family. Defaults to "strong" (normal generation).
  factbaseFitForFamily?: "strong" | "transferable" | "minimal";
  // Optional — transferable-angle hints surfaced by the gap detector. Fed
  // into the prompt as guidance on what to lead with when the career-
  // changer template fires.
  transferableAngles?: string[];
}): Promise<MasterProfileGenerationResult> {
  // (function body continues below — assessFactBaseFitForFamily helper is
  // defined just above this in the file for use during generation.)
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
  const trimmedRoleFamily = opts.targetRoleFamily?.trim() ?? "";
  const trimmedSector = opts.targetSector?.trim() ?? "";

  // FACT-BASE FIT ASSESSMENT — CRITICAL FOR CAREER-CHANGER MODE.
  //
  // The career-changer scanners (pivot signal in S1, S2 bridge to family,
  // named-target close in S4) only fire when factbaseFitForFamily is
  // "transferable" or "minimal". The caller (e.g. MasterCard) sometimes
  // passes this value when the gap modal ran, but on REGENERATE the gap
  // modal is skipped and the caller has no fit value to pass — which
  // silently drops back to "strong" and the career-changer scanners
  // don't fire. The result: regenerated Masters for irrelevant role
  // families lose pivot framing, family bridge, named target close.
  //
  // FIX: when a target family IS set but the caller didn't provide
  // factbaseFitForFamily, run a silent fit assessment server-side. This
  // costs one extra ~5s AI call per regenerate but guarantees the
  // career-changer scanners fire correctly on every generation, not just
  // the first one after the gap modal.
  let fit: "strong" | "transferable" | "minimal" = opts.factbaseFitForFamily ?? "strong";
  let transferableAngles = (opts.transferableAngles ?? [])
    .map((a) => a.trim())
    .filter(Boolean);
  if (trimmedRoleFamily && opts.factbaseFitForFamily === undefined) {
    try {
      const assessment = await assessFactBaseFitForFamily({
        factbaseText,
        targetRoleFamily: trimmedRoleFamily,
        targetSector: trimmedSector,
        connectedProviders: opts.connectedProviders,
      });
      if (assessment) {
        fit = assessment.fit;
        transferableAngles = assessment.transferableAngles;
      }
    } catch (e) {
      console.warn(
        "[generateMasterProfileFromFactBase] silent fit assessment failed — defaulting to 'strong':",
        e
      );
    }
  }

  const systemPrompt = buildMasterSystemPrompt(
    opts.exclusions ?? [],
    trimmedRoleFamily,
    trimmedSector,
    fit,
    transferableAngles
  );
  const trimmedJd = opts.targetJdText?.trim() ?? "";
  const jdBlock = trimmedJd
    ? `\n=== TARGET JOB DESCRIPTION (tailor Profile vocabulary to this — but never invent claims to match it) ===\n${trimmedJd}\n`
    : "";
  // Target-family block — sits in the user prompt as well as in the system
  // prompt so the model has TWO independent reminders. The system-prompt
  // version has the rules; the user-prompt version makes the target salient
  // alongside the FactBase content.
  const targetBlock = trimmedRoleFamily
    ? `\n=== TARGET ROLE FAMILY ===\nThis Master is being drafted for someone targeting **${trimmedRoleFamily}** roles${trimmedSector ? ` in **${trimmedSector}**` : ""}. Surface FactBase claims that map onto ${trimmedRoleFamily} capabilities; reframe vocabulary using terms recognised in that field. The Truth Contract still holds — never invent ${trimmedRoleFamily}-specific experience the FactBase doesn't support; if evidence is thin, use the strongest reframable claims you DO have.\n`
    : "";
  const taskLine = trimmedJd
    ? "Produce the candidate's Profile for the JD above. Surface FactBase claims that align with the JD's vocabulary and emphasis; never invent claims to match the JD. Apply ALL Profile rules. Return ONLY the JSON object: { \"summary\": string }."
    : trimmedRoleFamily
    ? `Produce the candidate's Master Profile, framed for ${trimmedRoleFamily} roles. Lead with the FactBase evidence most relevant to that family. Apply ALL Profile rules. Return ONLY the JSON object: { "summary": string }.`
    : "Produce the candidate's Master Profile — the strongest, sector-agnostic version of themselves. No specific job description to tailor to. Apply ALL Profile rules. Return ONLY the JSON object: { \"summary\": string }.";
  const userPrompt = `=== CANDIDATE FACTBASE ===
${factbaseText || "(empty — use the wizard answers below as primary input)"}

${wizardText ? `=== USER-PROVIDED CONTEXT (wizard answers — treat as truth) ===\n${wizardText}\n\n` : ""}${targetBlock}${jdBlock}=== TASK ===
${taskLine}`;

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
    // isMaster gates a couple of scanner behaviours; pass false when this is
    // a JD-tailored generation so the critic treats it as a JD Profile, not
    // a sector-agnostic Master.
    isMaster: !trimmedJd,
    jdText: trimmedJd || undefined,
    exclusions: opts.exclusions ?? [],
    // Pass career-changer mode context so the critic loop runs the pivot-
    // signal / S2-bridge / named-target-close scanners when applicable.
    targetRoleFamily: trimmedRoleFamily || undefined,
    factbaseFitForFamily: fit,
  });

  return { summary, warnings };
}

// Adapt an existing Master Profile to a specific JD. Emphasis-aware:
// rewrites the Profile to lead with the FactBase claims that match the JD's
// weight, while preserving universal anchors (brand-tier prior employer,
// degree + classification + university, current role title). The Adapt path
// can pull in FactBase claims that aren't in the Master and drop Master
// claims that aren't JD-relevant — both within Truth Contract limits.
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
  // Optional target role family for this Master. When set, Adapt uses it as
  // additional context for selecting which FactBase claims to emphasise.
  // The JD is still the primary tailoring signal; the family adds register.
  targetRoleFamily?: string | null;
  targetSector?: string | null;
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

  // Load FactBase so the AI can pull JD-relevant claims that aren't yet in
  // the Master. Without this, Adapt is stuck rephrasing only what the Master
  // already mentions — which is the entire reason emphasis didn't shift on
  // the GS test (the candidate's most JD-relevant evidence sat in FactBase
  // but never in Master).
  const fbResult = await extractFactBase({ cvId: opts.cvId });
  if (fbResult.error || !fbResult.factBase) {
    warnings.push(
      "Could not load your FactBase — Adapt will work from the Master alone."
    );
  }
  const factbaseText = fbResult.factBase
    ? serialiseFactBaseForMaster(fbResult.factBase)
    : "(unavailable)";

  // Extract universal anchors from the Master deterministically. These are
  // credibility signals that DON'T change per JD — brand-tier prior
  // employers and the education close. The AI is told to preserve them; if
  // any go missing in the output, we fall back to verbatim Master.
  const universalAnchors = extractUniversalAnchors(opts.master);

  const trimmedFamily = opts.targetRoleFamily?.trim() ?? "";
  const trimmedSector = opts.targetSector?.trim() ?? "";

  const systemPrompt = buildAdaptEmphasisSystemPrompt({
    exclusions: opts.exclusions ?? [],
    universalAnchors,
    targetRoleFamily: trimmedFamily,
    targetSector: trimmedSector,
  });
  const familyContextBlock = trimmedFamily
    ? `\n=== MASTER'S TARGET ROLE FAMILY ===\nThis Master is framed for **${trimmedFamily}** roles${trimmedSector ? ` in **${trimmedSector}**` : ""}. Treat this as the family register for the Adapt: vocabulary and emphasis should match ${trimmedFamily}, narrowed further by the JD.\n`
    : "";
  const userPrompt = `=== JOB DESCRIPTION ===
${opts.jdText.trim()}
${familyContextBlock}
=== CANDIDATE'S MASTER PROFILE (their best universal version — re-emphasise per the JD; preserve universal anchors) ===
${opts.master}

=== CANDIDATE FACTBASE (every claim they have evidence for — pull JD-aligned claims from here into the Profile) ===
${factbaseText}

${opts.companyName ? `Target company: ${opts.companyName}\n` : ""}${opts.roleName ? `Target role: ${opts.roleName}\n` : ""}
=== TASK ===
Produce a JD-tailored Profile for this candidate. Pick the 2-3 claims (from Master OR FactBase) that best match the JD's weight, restructure S1-S3 around them, and preserve the universal anchors listed in the system prompt. Apply ALL Profile rules. Return ONLY the JSON object: { "summary": string }.`;

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

  // Run the full Profile critic loop on the adapted text — same rules and
  // rewrite pipeline used by the dedicated Master generator. JD context lets
  // the critic apply JD-aware scanners.
  if (fbResult.factBase) {
    tailored = await runProfileScannersAndRewrite({
      summary: tailored,
      factbaseText,
      factbaseFromFactBase: fbResult.factBase,
      connectedProviders: opts.connectedProviders,
      systemPrompt,
      isMaster: false,
      jdText: opts.jdText,
      exclusions: opts.exclusions ?? [],
      // Adapt does NOT have a factbaseFitForFamily signal (that's a Master-
      // generation concept). Pass the Master's target family for completeness
      // but leave fit as "strong" — Adapt operates on an existing Master
      // that already has the user's chosen framing baked in.
      targetRoleFamily: trimmedFamily || undefined,
      factbaseFitForFamily: "strong",
    });
  }

  // Universal-anchor preservation check (lighter than full entity check).
  // If the Master named a brand-tier prior employer, the adapted Profile
  // must keep it. If the Master had a degree close, the adapted Profile
  // must keep degree + uni. These don't change per JD.
  const missingAnchors = universalAnchors.filter(
    (a) => !tailored!.toLowerCase().includes(a.toLowerCase())
  );
  if (missingAnchors.length > 0) {
    warnings.push(
      `Adapt dropped universal anchor${missingAnchors.length === 1 ? "" : "s"} (${missingAnchors.slice(0, 3).map((a) => `"${a}"`).join(", ")}) — using your Master verbatim instead.`
    );
    return { tailored: opts.master, warnings };
  }

  // Deterministic exclusion-rule enforcement. Run AFTER the critic in case
  // an excluded phrase slipped past the rewrite loop (defensive — the loop
  // already enforces this via scanExcludedPhrases).
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

  return { tailored, warnings };
}

// Extract anchors from the Master that don't change per JD: brand-tier
// prior employers, role titles (the user's actual past/current titles), and
// the degree close. The Adapt critic uses these as the minimum survival bar
// — Adapt may restructure S2/S3 freely, but must keep these credibility
// signals because they're truth-grounded facts.
//
// Returns short substrings (e.g. "Siemens DISW", "Birmingham City University",
// "First-Class", "Project Coordinator") that must each appear in the adapted
// output. Substring matching is case-insensitive.
function extractUniversalAnchors(master: string): string[] {
  const anchors = new Set<string>();

  // Brand-tier prior employers — small explicit list. Match anywhere in the
  // Master; if found, must survive into the Adapted Profile.
  const BRAND_TIER = [
    "Siemens", "Goldman Sachs", "McKinsey", "BCG", "Bain", "Apple", "Google",
    "Meta", "Amazon", "Netflix", "Microsoft", "Stripe", "Anthropic", "OpenAI",
    "JLR", "Jaguar Land Rover", "Unilever", "Diageo", "Innocent Drinks",
    "PwC", "Deloitte", "EY", "KPMG", "JPMorgan", "Morgan Stanley", "Barclays",
    "HSBC", "Lloyds", "NatWest", "BP", "Shell", "Rolls-Royce", "BAE",
    "Bloomberg", "Refinitiv", "ICE", "Citi", "Citigroup", "UBS", "Credit Suisse",
    "Linklaters", "Clifford Chance", "Slaughter and May", "Allen & Overy",
    "Freshfields", "Herbert Smith Freehills",
  ];
  for (const brand of BRAND_TIER) {
    if (master.toLowerCase().includes(brand.toLowerCase())) {
      // Preserve the exact substring as written in the Master (e.g. "Siemens DISW").
      const idx = master.toLowerCase().indexOf(brand.toLowerCase());
      // Try to grab the brand + 1-2 trailing capitalised tokens (e.g. "DISW").
      const slice = master.slice(idx);
      const m = slice.match(/^[\w&-]+(?:\s+[A-Z][\w&-]*){0,2}/);
      anchors.add(m ? m[0] : brand);
    }
  }

  // Role titles. The user's actual title is a TRUTH-CONTRACT fact — Adapt
  // must not soften "Project Coordinator" into "programme coordination" or
  // "Marketing Manager" into "marketing leadership". Extract capitalised
  // phrases ending in a role-title noun and pin them as anchors.
  const ROLE_TITLE_ENDINGS = [
    "Coordinator", "Analyst", "Engineer", "Manager", "Director", "Lead",
    "Officer", "Specialist", "Consultant", "Advisor", "Adviser", "Strategist",
    "Designer", "Developer", "Architect", "Owner", "Founder", "Editor",
    "Writer", "Planner", "Buyer", "Researcher", "Scientist", "Marketer",
    "Accountant", "Auditor", "Banker", "Trader", "Broker", "Lawyer",
    "Solicitor", "Barrister", "Paralegal", "Nurse", "Teacher", "Tutor",
    "Therapist", "Pharmacist", "Programmer", "Tester", "Surveyor",
    "Controller", "Treasurer", "Secretary", "Operator", "Technician",
    "Coordinator", "Associate", "Assistant", "Partner", "Principal",
    "Executive", "Apprentice", "Intern", "Graduate",
  ];
  const titleRegex = new RegExp(
    `\\b([A-Z][a-z]+(?:\\s+[A-Z][a-z]+){0,3}\\s+(?:${ROLE_TITLE_ENDINGS.join("|")}))\\b`,
    "g"
  );
  for (const m of master.matchAll(titleRegex)) {
    anchors.add(m[1]);
  }

  // Degree close: degree class + degree type + university.
  // Degree class: "First-Class", "Upper Second", "2:1", "2.1", "First", etc.
  // We pin the strongest discriminators: classification phrase and university name.
  const classMatch = master.match(
    /\b(First[- ]Class|Upper Second|Lower Second|Distinction|Merit|2[:.][12]|First|Second[- ]Class)\b/i
  );
  if (classMatch) anchors.add(classMatch[0]);

  // University / institution: "X University", "University of Y", "City University".
  const uniMatch =
    master.match(/\b(?:University of [A-Z][\w]+(?:\s+[A-Z][\w]+){0,3})\b/) ||
    master.match(/\b([A-Z][\w]+(?:\s+[A-Z][\w]+){0,3}\s+(?:University|College|School|Institute))\b/);
  if (uniMatch) anchors.add(uniMatch[0]);

  // Degree type — BA, BSc, MA, MSc, MBA, etc.
  const degMatch = master.match(
    /\b(BA|BSc|BEng|MA|MSc|MEng|MBA|MFin|MPhil|PhD|ACA|ACCA|CFA|MRICS|FRICS)\b/
  );
  if (degMatch) anchors.add(degMatch[0]);

  return Array.from(anchors);
}

// ── Emphasis-aware Adapt system prompt ──────────────────────────────────────
// Used by the per-CV "Adapt to this JD" button. The model is given BOTH the
// Master (the user's universal best) AND the FactBase (every claim they have
// evidence for) and asked to RE-EMPHASISE the Profile around the JD's
// weight. Universal anchors (brand-tier prior employer, degree close) MUST
// survive. S2 scope anchor and S3 distinctive claim can shift between
// FactBase claims to better fit the JD.
function buildAdaptEmphasisSystemPrompt(opts: {
  exclusions: string[];
  universalAnchors: string[];
  targetRoleFamily?: string;
  targetSector?: string;
}): string {
  const { exclusions, universalAnchors, targetRoleFamily = "", targetSector = "" } = opts;

  const exclusionsBlock = exclusions.length > 0
    ? `\n\nUSER EXCLUSIONS (HARDEST RULE — never include any of these phrases OR concept-level paraphrases of them in the Profile, regardless of JD relevance):
${exclusions.map((e) => `- ${e}`).join("\n")}

CONCEPT-LEVEL EXCLUSION (CRITICAL): the user is excluding the CONCEPT each phrase represents, not just the literal text. If "supplier performance tracker" is excluded, you must also avoid:
- "supplier performance tracking system"
- "supplier performance dashboard"
- "tracker for supplier performance"
- "system to track supplier performance"
- any other phrasing that captures the same underlying claim.
Paraphrasing around the literal text to dodge the exclusion is NOT compliance. If the underlying concept is excluded, drop the claim entirely and pick a different one from the FactBase.
`
    : "";

  const anchorsBlock = universalAnchors.length > 0
    ? `\n\nUNIVERSAL ANCHORS — these EXACT substrings must appear verbatim in the output Profile (they're credibility signals that travel across applications):\n${universalAnchors.map((a) => `- "${a}"`).join("\n")}\n`
    : "";

  const familyBlock = targetRoleFamily
    ? `\n\nMASTER'S TARGET ROLE FAMILY: ${targetRoleFamily}${targetSector ? ` (sector: ${targetSector})` : ""}.
The candidate has explicitly framed this Master for ${targetRoleFamily} roles. The JD is the primary tailoring signal, but the family adds register: vocabulary, framing, and emphasis should match ${targetRoleFamily} expectations. If the JD points the other way (different family from the Master), prefer the JD signal — but flag implicitly that the Master may be a poor fit by surfacing only the most transferable claims.

If ${targetRoleFamily} is a niche or custom family (not a household-name profession), treat it as authoritative — use your general knowledge of that field's CV-writing register, vocabulary, and recruiter expectations. Don't second-guess the user's chosen target.
`
    : "";

  return `You take a candidate's Master Profile + their FactBase + a specific JD, and produce a JSON object: { "summary": string } — a Profile RE-EMPHASISED around the JD's weight.

YOUR JOB IS TO RE-EMPHASISE. The Master is the candidate's universally strongest Profile. For a specific JD, a different subset of their FactBase claims may carry more weight. Pick the 2-3 claims (from Master OR FactBase) that best match the JD's priorities, and structure the Profile around them.

PROCESS (follow exactly):
1. Read the JD. List its top 3-5 requirements / themes / vocabulary.
2. Read the Master AND the FactBase. The Master shows the user's curated best wording; the FactBase shows ALL claims they have evidence for — including ones not yet in the Master.
3. Score each FactBase claim against JD weight:
   (a) Direct keyword/concept match against JD
   (b) Concrete outcome / scope / quantified anchor
   (c) Distinctiveness — how uncommon is this claim?
   (d) Reframability — how cleanly does it map onto JD vocabulary?
4. Pick the top 2-3 claims for the Profile body (S2 + S3). These may differ from the Master's S2/S3 if the JD demands different emphasis. It is EXPECTED and CORRECT for the Adapt output to differ structurally from the Master when the JD calls for it.
5. Use JD vocabulary wherever it accurately describes the candidate's claim. Don't change the underlying concept, just the word.
6. Build the Profile around the picked claims, applying all standard Profile rules.

WHAT CAN CHANGE FROM THE MASTER:
- Which scope anchor lives in S2 (the Master may say "2x revenue growth"; for a JD about supplier risk you might pick "12 overseas suppliers" or "£X recovered" instead — if those are in the FactBase).
- Which distinctive claim lives in S3 (e.g. ERP co-design in the Master, swapped for supplier scorecard or weekly senior reporting if the JD asks for those).
- Sector context in S1.
- Vocabulary throughout — use JD terminology when it matches the candidate's actual work.
- You MAY drop a Master claim to make room for a stronger JD-aligned FactBase claim.
- You MAY pull in a FactBase claim that wasn't in the Master.

WHAT MUST NOT CHANGE:
- Universal anchors (listed below) — these are credibility signals that travel across every application and must appear verbatim.
- Truth Contract — every claim must trace to the Master OR the FactBase. Never invent.
- Named entities — when you USE them, preserve verbatim. Don't swap "ERP" for "supplier tracker" or "Siemens" for "JLR". (You can choose to use a different entity in a different sentence, but each entity's spelling and meaning must match the FactBase.)
- Numerical claims — preserve scale exactly. "2x growth" stays "2x growth", never "3x" or "significant".
- Current role identity — the Master's role title (e.g. "Supply Chain Analyst") must lead S1.
- ROLE TITLES (HARDEST): if the Master names a specific role title (e.g. "Project Coordinator", "Marketing Manager", "Software Engineer"), preserve that EXACT title verbatim. NEVER soften "Project Coordinator placement" into "programme coordination" or "Marketing Manager" into "marketing leadership". Role titles are truth-grounded facts — soften the title and you mis-represent the candidate. If the Master mentions a "placement", "internship", "secondment", "scheme", or "rotation", preserve that word too — it's part of the role description.

EMPLOYER-NAME RULE (HARD):
- Brand-tier employers (FTSE 100, S&P 500, FAANG, MBB, Magic Circle, Big 4, household-name) MAY appear in S1 or S4 — they're credibility signals.
- Non-brand-tier employers (small businesses, scale-ups, niche firms) MUST NOT appear in the Profile body. They live in the Experience section. Writing "Scaled [SmallBusinessName]'s supply chain through 2x growth" is WRONG — write "Scaled the supply chain through 2x growth" instead. The recruiter learns the employer name from the Experience section heading; repeating it in the Profile wastes precious words and reads clunky.
- Possessive employer constructions ("X's supply chain", "Y's procurement function") are particularly bad — drop the possessive and refer to the function generically ("the supply chain", "the function").${anchorsBlock}${familyBlock}

PROFILE RULES (HARD — same as Master generation):

LENGTH: 60-100 words, 3-5 sentences, paragraph not bullets. Each sentence must be readable in one breath (≤22 words). If you need 5 short tight sentences instead of 3 long compound ones, use 5. Total word count matters more than sentence count; tight readability matters more than either.

VOICE — IMPLIED FIRST PERSON: never "I/my/me"; never third-person -s verbs about the candidate at sentence start ("Produces", "Holds", "Manages"). State actions directly.

STRUCTURE — STRICT SENTENCE-ROLE SEPARATION:
S1 = role + work breadth + sector context. NO scope anchor. NO sole/ownership claim.
S2 = dominant scope anchor PAIRED with ONE specific named action. Single-signal S2 is insufficient. Pick ONE action — never jam multiple actions into S2.
S3 = ONE distinctive claim with ONE specific named item. Pick the strongest signal for this JD: ownership ("Sole [role]"), named system ("ERP", "supplier scorecard"), or named outcome ("recovered £40k of refunds"). DO NOT chain two distinct actions into S3 (e.g. "switched logistics partners AND recovered refunds" is two actions — pick one). Two-action S3 is multi-action jam and reads as muddled.
S4 = fact-anchored close (degree+classification+university) OR named target. Never generic aspiration.

ANCHORS-APPEAR-ONCE: scope anchor in S2 only; sole/ownership in S3 only; role title in S1 only.

NO TRICOLONS (no "X, Y, and Z" lists). NO em-dashes. NO opening adjective stack. NO closing aspiration ("seeking to leverage…"). NO defensive hedge openings ("Outside a formal X,", "Despite no formal Y,", "Without formal Z," — the action stands as evidence; the hedge signals deficit instead of strength).

BANNED VOCABULARY: spearhead, leverage, orchestrate, championed, drove, pioneered, synergise, utilise, streamline, robust, seamless, cutting-edge, results-driven, passionate, dynamic, proven, demonstrated, hands-on, forward-thinking, fast-paced, world-class, best-in-class, value-add, absorbing.

UK ENGLISH throughout: organise, specialise, analyse, optimise, programme, colour. Never American spellings.

CRITICAL — DO NOT default to "the Master is already good, return it verbatim". The Master was generated WITHOUT this JD in context. With the JD now in context, the right Profile may emphasise different claims. Be honest about which FactBase claims best match THIS JD's weight, and structure the Profile around them. Only return the Master verbatim if you've genuinely audited the FactBase and the Master's existing emphasis is already optimal for this JD.${exclusionsBlock}

Return ONLY the JSON object: { "summary": string }.`;
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
  // Career-changer mode context. When targetRoleFamily is set AND
  // factbaseFitForFamily is "transferable" or "minimal", the critic
  // additionally runs the career-changer scanners (pivot signal in S1,
  // S2 bridge to family, named-target close in S4). These are deterministic
  // enforcement of rules the prompt alone doesn't reliably hold.
  targetRoleFamily?: string;
  factbaseFitForFamily?: "strong" | "transferable" | "minimal";
}): Promise<string> {
  const {
    summary,
    factbaseText,
    factbaseFromFactBase,
    connectedProviders,
    systemPrompt,
    isMaster,
    jdText,
    exclusions = [],
    targetRoleFamily = "",
    factbaseFitForFamily = "strong",
  } = args;
  const careerChangerActive =
    !!targetRoleFamily.trim() &&
    (factbaseFitForFamily === "transferable" || factbaseFitForFamily === "minimal");

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
      // scanBannedPhrases catches AI-tell vocabulary the structural Profile
      // scanners don't cover: "actionable [X]", "spearhead", "leverage",
      // "delve", "robust", etc. Without this, banned phrases sail through
      // the Adapt + Master Profile critic loops untouched.
      ...scanBannedPhrases(stub),
      ...scanProfileSectorInvention({ summary: current, factbaseText }),
      ...scanExcludedPhrases({ summary: current, exclusions }),
      // Career-changer scanners — deterministic enforcement of pivot
      // signal in S1, family-bridge clause in S2, and named-target close
      // in S4. Only run when career-changer mode is active (target family
      // set AND FactBase fit is transferable/minimal). The prompt alone
      // doesn't reliably hold these rules — the scanner does.
      ...(careerChangerActive
        ? scanProfileCareerChangerMode(stub, targetRoleFamily)
        : []),
      // Sole-vs-FactBase: catches "Built from scratch" / "Sole builder" /
      // "single-handedly" claims when the FactBase contains collaborative
      // wording. Truth Contract enforcement — model can't inflate shared
      // work into solo authorship to make claims sound stronger.
      ...scanProfileSoleClaimVsFactBase(stub, factbaseText),
      // Scope-anchor enforcer: if the FactBase contains a quantified scope
      // anchor (Nx growth, £X, N suppliers, N%, etc.) and the Profile body
      // surfaces none of them, flag and force rewrite. Catches the recurring
      // career-changer regression where the model drops the scope anchor
      // to make room for the bridge clause.
      ...scanProfileScopeAnchorVsFactBase(stub, factbaseText),
    ];
    if (flagged.length === 0) {
      // Final safety net — even if no flags, run deterministic em-dash kill
      // to catch any em-dash variant that snuck past the scanner edge cases
      // (the scanner is regex-based and we'd rather guarantee no em-dash
      // ships than rely on perfect scanner coverage).
      return killAbsorbingDeterministic(killEmDashesDeterministic(current));
    }

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
  // Final deterministic kills guarantee neither em-dash variants NOR
  // "absorbing/absorbed" ship even when the model couldn't fix across
  // MAX_ATTEMPTS rewrites. These are the absolute backstops for the two
  // most persistent Claude tells in CV generation.
  void isMaster;
  return killAbsorbingDeterministic(killEmDashesDeterministic(current));
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
  // High-frequency banned verbs that the model keeps producing despite the
  // critic — these get their own buckets so the single-rule fallback at
  // attempt 3+ specifically targets them with concrete restructuring guidance
  // (see buildFixGuidance).
  if (/\babsorb(?:ing|ed|s)?\b/.test(p)) return "absorbing";
  if (/\bactionable\b/.test(p)) return "actionable";
  if (/sector descriptor .* no scale or position signal/.test(p)) return "descriptor-without-scale";
  // Career-changer scanner buckets — when these recur across attempts the
  // focused-rule fallback can apply each rule individually rather than
  // overwhelming the model with the full multi-rule prompt.
  if (/lacks an explicit pivot signal/.test(p)) return "pivot-signal";
  if (/s2 does not bridge/.test(p)) return "s2-bridge";
  if (/lacks a named-target close/.test(p)) return "named-target-close";
  if (/self-contradiction.*sole/.test(p)) return "sole-vs-co";
  if (/profile claims sole authorship.*factbase contains collaborative/i.test(p)) return "sole-vs-factbase";
  if (/profile body has no quantified scope anchor/i.test(p)) return "scope-anchor-missing";
  if (/possessive non-brand-tier employer/i.test(p)) return "possessive-employer";
  if (/passive 'exposure to'|familiarity with|working knowledge of/i.test(p)) return "passive-exposure";
  if (/abstract noun stack/i.test(p)) return "abstract-noun-stack";
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
function buildMasterSystemPrompt(
  exclusions: string[] = [],
  targetRoleFamily: string = "",
  targetSector: string = "",
  factbaseFitForFamily: "strong" | "transferable" | "minimal" = "strong",
  transferableAngles: string[] = []
): string {
  const exclusionsBlock = exclusions.length > 0
    ? `\n\nUSER EXCLUSIONS (HARDEST RULE — never include these in the Profile, regardless of FactBase content or how relevant they seem):\n${exclusions.map((e) => `- ${e}`).join("\n")}\n`
    : "";

  // Target-family block. When the user has declared a target role family,
  // the Master is framed for that family — surfacing FactBase evidence
  // that maps onto it and using its vocabulary. The Truth Contract still
  // holds: never fabricate experience to fit the target. If FactBase
  // evidence is thin for the target family, use the strongest reframable
  // claims that DO exist.
  const targetFamilyBlock = targetRoleFamily
    ? `

TARGET ROLE FAMILY (CRITICAL — shapes EVERY structural choice):
This Master is being drafted for someone targeting **${targetRoleFamily}** roles${targetSector ? ` in the **${targetSector}** sector` : ""}.

How to apply this target:
1. EMPHASIS: surface the FactBase claims most relevant to ${targetRoleFamily}. If the candidate has supply-chain experience but is targeting consulting, lead with the analytical + stakeholder-reporting + structured-problem-solving angles, not the operational procurement angles. Different family = different emphasis on the same FactBase.
2. VOCABULARY: use ${targetRoleFamily}-recognised terms wherever they accurately describe the candidate's actual work. NEVER substitute a ${targetRoleFamily} term for something the candidate didn't actually do.
3. TRUTH CONTRACT (HARDEST): you may REFRAME existing claims; you may NOT INVENT ${targetRoleFamily}-specific experience. If the FactBase doesn't support a specific ${targetRoleFamily} capability, do not claim it. Use the strongest reframable evidence the candidate DOES have.
4. REFRAMING EXAMPLES (illustrative — apply the same logic to the candidate's real claims):
   - Supply Chain → Consulting: "managed supplier relationships across 12 overseas markets" → "structured stakeholder coordination across 12 international counterparties"
   - Marketing → Product Management: "led a brand launch campaign" → "led a cross-functional launch from positioning to GTM execution"
   - Teaching → Data Analytics: "designed and delivered a 6-month curriculum" → "designed and delivered a structured 6-month analytical programme"
5. CREDIBILITY ANCHORS: brand-tier prior employers (Siemens, McKinsey, Goldman, etc.) and First-Class degrees travel across families — always surface them.
6. NO FALSE CONFIDENCE: if the candidate has zero ${targetRoleFamily}-relevant experience, the honest Profile reflects that — lead with transferable skills + clear career-changer framing (template B below). Do NOT pretend the candidate has done ${targetRoleFamily} work they haven't.
7. CUSTOM / NICHE FAMILY HANDLING: if ${targetRoleFamily} isn't a household-name family (e.g. "Investment Banking", "Marketing" are well-known; "Underwater Welding Inspection", "Equestrian Sports Management" are niche), treat the candidate's chosen target as AUTHORITATIVE. Use your general knowledge of that field's CV-writing register — what recruiters in that field scan for, what vocabulary they use, what credentials matter — and apply it. Don't second-guess the user's chosen target or default to a generic Profile.
`
    : "";

  // FORCED CAREER-CHANGER block. When the upstream gap detector classifies
  // the FactBase fit for the target family as "transferable" or "minimal",
  // we explicitly REQUIRE the Career-Changer template — no risk of the
  // model accidentally picking Achievement-Led and producing a confident-
  // sounding Profile for a role the candidate hasn't actually done. This is
  // the "Supply Chain → Law" honest-pivot handling.
  const careerChangerBlock =
    targetRoleFamily && (factbaseFitForFamily === "transferable" || factbaseFitForFamily === "minimal")
      ? `

CAREER-CHANGER MODE (FORCED — gap detector classified FactBase fit for ${targetRoleFamily} as "${factbaseFitForFamily}"):
The candidate does NOT have direct ${targetRoleFamily} experience in their FactBase. They are PIVOTING into ${targetRoleFamily}. You MUST use the CAREER-CHANGER template (template B below), not Achievement-Led. Failing to do so produces a Profile that misrepresents the candidate.

Mandatory career-changer structure:
- S1 = current role + EXPLICIT PIVOT signal toward ${targetRoleFamily}, AND surface the brand-tier prior-employer bridge where one exists. Example: "Supply Chain Analyst pivoting to ${targetRoleFamily}, building on a placement at Siemens DISW." (Siemens DISW is the credibility bridge — keep it.) Without brand-tier prior employer: "Marketing Manager moving into ${targetRoleFamily}, with [transferable angle] from current role."
- S2 = transferable skills with the candidate's scope anchor, phrased AS THE BRIDGE from current work to ${targetRoleFamily}. The scope anchor (2x growth, £40M, 12 suppliers) stays, but the ACTION paired with it must explicitly frame what transfers to ${targetRoleFamily}. The recruiter must see in S2 WHY the candidate's existing work makes them credible for ${targetRoleFamily}.

  NOT acceptable (pure operational — doesn't bridge): "Scaled the supply chain through 2x revenue growth, managing higher PO volumes."

  Acceptable shapes for S2 (DO NOT COPY THESE PHRASINGS VERBATIM — they are structural illustrations only; write your own naturally-phrased version using the candidate's actual FactBase):
  • Scope anchor + active-verb work clause with ${targetRoleFamily}-relevant terms drawn from the FactBase (contracts, compliance, regulatory, etc. for Legal targets).
  • Scope anchor as one short sentence, ${targetRoleFamily}-bridge clause as a second short sentence.

  CRITICAL: do NOT write phrases like "the operational counterpart of [family] practice" or other tagline-style summaries. These read as model-tells. Frame the bridge as concrete work the candidate does, in natural English.
- S3 = ONE distinctive transferable claim with a NAMED specific item — built system, named brand collaborator, recovered amount, specific deliverable. This is the candidate's proof of CAPABILITY (which transfers) even though they lack DOMAIN expertise (which doesn't).
- S4 = fact-anchored close (degree + classification + uni + sub-details) PLUS named target: "Targeting a [specific ${targetRoleFamily} role] at [employer-type appropriate to the candidate's level]." Example: "First-Class Business with Marketing BA from Birmingham City University, averaging over 80% in the final year and finishing top of the cohort. Targeting a graduate solicitor training contract."

HARD RULES IN CAREER-CHANGER MODE:
- NEVER claim domain expertise the candidate doesn't have. No "experienced in legal practice", "with ${targetRoleFamily} background", etc.
- ALWAYS explicitly frame the pivot in S1 — the recruiter MUST be able to tell within the first sentence that this is a career-changer Profile, not a confused domain-expert one. Pivot signals: "pivoting to", "moving into", "transitioning to", "career-changing into", "applying [current skills] to ${targetRoleFamily}".
- BRAND-TIER PRIOR EMPLOYER (STRONG PREFERENCE — same rule as non-career-changer Profiles): if the FactBase contains a brand-tier prior employer (Siemens, McKinsey, Goldman, FAANG, Big 4, Magic Circle, etc.), prefer to surface it as a career-narrative bridge in S1 or as part of the S4 close. Career-changer mode does NOT suppress this — a brand-tier prior employer is even more valuable in a pivot Profile because it tells the recruiter the candidate is hireable across orgs. You may still omit it if including it creates a structural problem (word count overflow, sentence-role conflict), but the default is INCLUDE.
- S2 BRIDGE-FRAMING (HARD): S2 must NOT be the standard non-career-changer S2. The action paired with the scope anchor must explicitly frame the bridge to ${targetRoleFamily}. If you produce an S2 that reads as pure current-domain operational work with no bridge to ${targetRoleFamily}, the Profile reverts to looking confused — like the candidate doesn't know they're pivoting. The bridge can be a single clause ("with daily exposure to [X relevant to ${targetRoleFamily}]") but it must be there.
- Use the transferable angles below as your guide — these are the strongest bridges from the candidate's FactBase to ${targetRoleFamily}.
${
  transferableAngles.length > 0
    ? `\nTRANSFERABLE ANGLES (from gap detector — lead with these):\n${transferableAngles.map((a) => `- ${a}`).join("\n")}\n`
    : ""
}
The CAREER-CHANGER template is HONEST positioning, not weakness. It tells the recruiter: "I haven't done ${targetRoleFamily} yet, but here's why my actual experience prepares me for it." That framing converts when it's true — and never converts when it's hidden behind fake confidence.
`
      : "";

  return `You produce a UK CV "Profile" section — the 3-4 sentence summary at the top of a CV. The output is a JSON object: { "summary": string }.

Apply ALL of these rules. Every rule is hard.${exclusionsBlock}${targetFamilyBlock}${careerChangerBlock}

USER-WIZARD-CONTEXT HANDLING (CRITICAL for SaaS UX):
When wizard / gap-question answers appear in the user prompt (under "USER-PROVIDED CONTEXT"), the user's answers may be terse, fragmentary, mis-capitalised, or written in casual register — e.g. "i deal with supplier contracts sometimes", "no", "commercial law", "yeah at uni i did a module on it". These are NORMAL real-world inputs, not failures.

RULES:
- TREAT every user answer as authoritative TRUTH, even when it's short.
- EXTRACT maximum signal from terse input. "i deal with supplier contracts" → surface "supplier contract review and negotiation" as a real claim in the Profile. "commercial law" as a target preference → frame the close as "Targeting a commercial law role".
- NEVER reject user input as "too short" or "unclear". If the user wrote anything, USE it — that's their answer.
- ELABORATE the user's terse phrasing into proper CV register in the Profile. Their answer is signal; your job is to convert signal into polished CV language without losing or inverting the meaning.
- DO NOT add details the user didn't provide. If they wrote "i deal with supplier contracts sometimes", DON'T expand to "I review and negotiate supplier contracts across 12 international counterparties weekly" — only "supplier contract review" is grounded. Stay within the user's actual signal; just polish the language.
- If the user answered "no" or "n/a" or skipped a question, that's also data — don't surface a claim about that dimension.

UK ENGLISH (NON-NEGOTIABLE):
- British spelling throughout: organise, specialise, analyse, optimise, programme, colour, behaviour, fulfil, recognise, centre, favourite, labour.
- UK conventions: "First-Class" (degree class), "BA / BSc / MEng / MSc" (post-nominal letters), pound sterling for money.
- Never use American spellings like organize, specialize, analyze, color, behavior, etc.

LENGTH: 60-100 words, 3-5 sentences, paragraph not bullets. Each sentence must be readable in one breath (≤22 words). If you need 5 short tight sentences instead of 3 long compound ones, use 5. Total word count matters more than sentence count; tight readability matters more than either.

VOICE — IMPLIED FIRST PERSON (NON-NEGOTIABLE):
- Never use "I", "I'm", "I've", "my", "me".
- Never use third-person verbs about the candidate at sentence start: "Produces…", "Holds…", "Brings…", "Manages…", "Owns…", "Runs…", "Analyses…", "Leads…", "Designs…", "Builds…" etc.
- Implied first person — state actions and facts directly.

HUMAN-READABILITY (HARD — write like a human, not like a system):

1. ONE-BREATH SENTENCE TEST: every sentence in the body must be readable IN ONE BREATH by a recruiter scanning the Profile. If the sentence needs a comma, em-dash, semicolon, or parenthetical aside to keep going, IT IS TOO LONG. Split into two sentences. Hard cap is 22 words per body sentence; aim for 12-18.

   BAD (45-word run-on): "Daily review of supplier contracts covering delivery performance and liability terms, revisiting contract language when disputes or shipment discrepancies arise and recovering refunds on damaged stock through that process, scaling these responsibilities through a period of 2x revenue growth as supplier and order complexity increased."
   GOOD (two sentences, ~16 words each): "Reviews supplier contracts daily for delivery and liability terms, recovering refunds on damaged stock during disputes. Scaled this work through 2x revenue growth as supplier complexity increased."

2. NO NOMINALISATIONS — prefer the active verb / active gerund over the noun-form of the verb. The candidate DOES things; describe the doing with verbs, not noun phrases. THIS RULE ALSO APPLIES INSIDE COMPOUND SENTENCES, not just at sentence start.

   BAD: "with daily review of supplier contracts for delivery and liability terms" (nominalised — "review" as noun, hidden inside "with daily X of Y" construction)
   GOOD: "reviewing supplier contracts daily for delivery and liability terms" (active gerund)
   GOOD: "with supplier contracts reviewed daily for delivery and liability terms" (also acceptable — passive but still verb-form)

   BAD: "Daily review of supplier contracts" (sentence-start nominalisation)
   GOOD: "Reviews supplier contracts daily" (active verb)

   BAD: "Ongoing management of overseas suppliers"
   GOOD: "Manages overseas suppliers" / "Managing overseas suppliers"

   BAD: "Continuous oversight of procurement workflows"
   GOOD: "Oversees procurement workflows" (or restructure entirely)

   THE DEAD GIVEAWAY PATTERNS to find-and-replace in your output:
   - "with [adv] [noun-form] of X" → "with X [verb-formed-from-noun-form]" (e.g. "with daily review of contracts" → "with contracts reviewed daily" OR full restructure to "reviewing contracts daily")
   - "[Adverb] [noun-form] of X" at sentence start → "[Verb-form] X [adverb]"
   - "[Adjective] [noun-form] of X" → restructure to verb-led claim

3. NO PARENTHETICAL ASIDES via em-dash, semicolon, or stacked subordinate clauses. If you find yourself reaching for "— scaling these responsibilities through…" or "; covering all of…", the structure is wrong. Make the parenthetical content its own sentence, or drop it.

4. NO "X-ING THESE Y AS Z" patterns ("scaling these responsibilities through 2x revenue growth as supplier complexity increased"). Stiff and over-engineered. Restructure as a separate clean sentence with subject + verb + object.

5. CONVERSATIONAL REGISTER — imagine reading the Profile aloud at a job interview. If a sentence sounds stilted, stiff, or over-engineered when read aloud, rewrite it until it sounds like something a human would actually say. Test: would the candidate themselves say this in conversation? If no, rewrite.

6. PREFER VERBS OVER NOUN STACKS — three abstract nouns in a row is always wrong. "Primary operational data structure" is three nouns; "the team's main system for stock reconciliation" is concrete. Replace abstract-noun stacks with concrete descriptions.

STRUCTURE — STRICT SENTENCE-ROLE SEPARATION:
S1 = role + work breadth + sector context. NO scope anchor. NO sole/ownership claim.
S2 = the dominant scope anchor PAIRED with a specific named action that delivered it. The number/scale lives HERE only. Single-signal S2 is insufficient.
S3 = ONE distinctive ownership/breadth claim with a NAMED specific item (system/brand/project/tool/outcome/count). Generic scope phrases like "from X through to Y" or "end-to-end ownership" are insufficient.
S4 = close. Fact-anchored (degree+classification+university) OR named target. Never generic forward-looking aspiration.

SCOPE-ANCHOR PRESERVATION (HARD — common AI failure):
When the FactBase contains a quantified scope anchor — Nx revenue growth, £X spend / revenue / saved / recovered, N suppliers / countries / sites / staff managed, N% delta — the Profile body (S2 specifically) MUST surface it. Quantified scope is the single most credible recruiter signal at any candidate level; dropping it to make room for sector reframing or bridge clauses is a generator weakness.

Examples:
- FactBase has "scaled supply chain through 2x revenue growth" → S2 MUST include "2x revenue growth" (or equivalent number-bearing phrasing). NOT acceptable: an S2 that describes the work without the 2x.
- FactBase has "recovered £40k in supplier refunds" → S2 or S3 MUST include "£40k" (or "tens of thousands in supplier refunds" if exact figure isn't certain).
- FactBase has "12 overseas suppliers" → S2 or S3 MUST name the count, not just "overseas suppliers".

When generating a career-changer Profile (target family differs from current), the scope anchor STILL appears in S2, paired with a bridge clause to the target family. Both at once. Example: "Scaled the supply chain through 2x revenue growth, with daily review of supplier contracts for delivery and liability terms." The scope anchor (2x) AND the bridge (contract review) coexist. Dropping the scope anchor to make room for the bridge is a generator error.

If a scope number is in the FactBase but absent from the Profile body, the post-generation assessor will flag it as a high-impact missing surface — the generator should pre-empt this by including the number from the first pass.

S4 DEGREE-DETAIL PRESERVATION (HARD):
When the FactBase contains degree-detail items beyond the bare "First-Class BA from [Uni]" — such as average percentage ("averaging over 80% in the final year"), cohort position ("finishing top of the cohort"), Dean's list, distinction-in-thesis, scholarship — SURFACE THEM in S4. These are credibility multipliers that travel across every application and cost only 6-10 words. Word count is rarely the constraint at 60-100 words; trim S1-S3 filler before dropping a degree sub-detail.

EXAMPLES:
- FactBase has "First-Class BA, BCU, avg 80%, top of cohort" → S4 should be: "First-Class Business with Marketing BA from Birmingham City University, averaging over 80% in the final year and finishing top of the cohort." (NOT: "First-Class Business with Marketing BA from Birmingham City University." — that drops 14 words of credibility detail.)
- FactBase has "Distinction MSc, LSE, dissertation top 5%" → S4 should be: "Distinction MSc Economics from LSE, dissertation graded in the top 5% of the cohort."
- FactBase has only "First-Class BA, BCU" (no extra detail) → S4 is the short form: "First-Class Business with Marketing BA from Birmingham City University."

The rule: if the detail exists in the FactBase, it belongs in S4 unless including it would force the Profile over 100 words AFTER trimming non-credibility filler from S1-S3.

ANCHORS-APPEAR-ONCE:
- Scope anchor (numbers/scale) lives in S2 only — NOT in S1, NOT in S3.
- Sole/ownership keywords ("sole", "only [role]", "founding") live in S3 only — NOT in S1, NOT in S2.
- Each claim has ONE home. No repetition across sentences.

EMPLOYER-NAME RULE: include current employer name in S1 only if brand-tier (FTSE 100, S&P 500, FAANG, MBB, Magic Circle, Big 4, household-name). Otherwise omit — employer lives in Experience section.

EMPLOYER-SECTOR-DESCRIPTOR RULE (HARD — common AI failure mode):
If the current employer is NOT brand-tier, you MAY include a sector descriptor in S1 ("at a [descriptor]") ONLY IF the descriptor carries a REAL SIGNAL — meaning at least one of:
- £/$/€-figure scale: "at a £10M D2C consumer-goods business"
- Counted entities: "at a 200-person SaaS scale-up", "at a 12-country FMCG operator"
- Top-N market position: "at a top-3 UK home-decor retailer", "at the UK's largest pet-food brand"
- Named geographic market context: "at an FMCG export business serving EU and US"
- FTSE/listed / brand-adjacent signal: "at a FTSE-listed insurer", "at a private-equity-backed scale-up"

Decorative descriptors are BANNED — even if grounded in FactBase:
- "at a D2C eyewear brand" — BANNED (no scale, no position, no named market)
- "at a growing / innovative / leading / dynamic / best-in-class / forward-thinking [sector]" — BANNED (adjective filler)
- "at an independent / boutique / established [sector]" — BANNED (descriptor without signal)
- "at a [sector] company" — BANNED (no signal at all)

If you don't have a real scale / position / market signal in the FactBase, OMIT the descriptor entirely. Lead S1 with role + work scope only ("Supply Chain Analyst working across procurement and demand planning across an overseas supply base…"). Adding a decorative descriptor to "round out" S1 is a known AI tell and burns words without adding recruiter signal.

BRAND-TIER PRIOR-EMPLOYER RULE (STRONG PREFERENCE): if the FactBase contains a brand-tier prior employer (FTSE 100, S&P 500, FAANG, MBB, Magic Circle, Big 4, household-name unicorn — e.g. Siemens, Goldman Sachs, McKinsey, JLR, PwC, Apple, Google, Stripe, Anthropic), prefer to surface it in the Profile — typically as a career-narrative bridge in S1 ("…building on a placement at Siemens DISW") or as part of the close in S4. It's a credibility signal that travels across applications. You may omit it ONLY when including it would create a structural problem (e.g. forced word-count overflow, breaking sentence-role separation) — not as a default choice.

PRIOR-EMPLOYER ROLE-TITLE PRESERVATION (HARD): when surfacing a brand-tier prior employer, preserve the specific role title from the FactBase. Adds credibility specificity at minimal word cost.

GOOD: "building on a Project Coordinator placement at Siemens DISW" (preserves role title)
BAD: "building on a placement at Siemens DISW" (lost the role title — reads as anonymous association with the brand, weaker signal)

If the FactBase records "Project Coordinator placement at Siemens DISW" or "Summer Analyst internship at Goldman Sachs" or "Spring Week at McKinsey", the Profile must use the same role-title wording. Don't drop the role to save 2 words — the role is half the signal.

PRIOR-EMPLOYER REFRAMING (HARD — Truth Contract):
When surfacing a prior employer (especially placements, internships, sandwich years, brief rotations), describe the role using WORDS THAT APPEAR IN THE FACTBASE. Do NOT upgrade the role into a sophisticated deliverable to make it fit the target family.

Concrete examples of what's BANNED:
- FactBase says "Project Coordinator placement at Siemens DISW" + target family is Data → BANNED to write "analysing programme engagement data for senior stakeholders at Siemens DISW" (this invents a specific Data deliverable that may not be in the FactBase).
- FactBase says "Summer internship at McKinsey" + target family is Product Management → BANNED to write "led cross-functional product launches at McKinsey".
- FactBase says "Spring week at Goldman Sachs" + target family is Trading → BANNED to write "executed live trades on the desk at Goldman Sachs".

What IS allowed:
- Preserve the FactBase's wording for the role: "Project Coordinator placement at Siemens DISW" stays as "Project Coordinator placement at Siemens DISW" (or "placement at Siemens DISW").
- If the FactBase EXPLICITLY says the candidate did X at the prior employer, you may surface that X using the same words.
- Use the prior employer as a NAMED brand anchor without re-describing the activities ("building on a placement at Siemens DISW. …").

When in doubt, name the employer and leave the role activities at the FactBase wording — the recruiter understands a Siemens placement carries weight regardless of how you frame the day-to-day.

S2 PAIRING RULE: S2 must contain BOTH (i) a scope anchor (£/$/€-figure, growth multiple, count of named entities, before/after delta) AND (ii) a specific named action (built/designed/launched a NAMED system, recovered a NAMED amount, switched a NAMED provider).

S3 STRENGTH RULE: S3 must contain a NAMED specific item — named system, named brand collaborator, named outcome, named count. Generic ownership/scope phrases ("end-to-end", "from purchase order through to delivery") are insufficient.

OUTCOME-SIGNAL RULE: S2 or S3 must contain at least one outcome anchor — £-amount, %-improvement, count, before/after delta, or outcome verb (recovered/saved/switched/cut/scaled/closed/shipped).

NO TRICOLONS in any sentence (no "X, Y, and Z" lists). Use 2 items max.
NO em-dashes. Use commas, full stops, or restructure.
NO opening adjective stack ("Dedicated, organised…").
NO closing aspiration ("seeking to leverage…", "in a dynamic environment…").

NO DEFINITE-ARTICLE AI-Y PHRASINGS — when the candidate's specific employer is not in the Profile, refer to the function generically using indefinite or possessive constructions, NEVER "the [adj] [noun]" generic phrasings that read as AI-generated:
- BANNED: "the overseas supply base" / "the wider supplier base" / "the business" (as standalone noun phrase) / "the function" (as standalone subject).
- GOOD alternatives: "an overseas supplier base" / "overseas suppliers" / "wider supplier base" (no definite article) / "supplier and order data across overseas suppliers" / restructure to attach the noun to a specific verb / count.
- The rule: "the X base" / "the wider X" reads AI-generic because there's no antecedent. Either name the specific count ("12 overseas suppliers"), use indefinite article ("an overseas supplier base"), or drop the article entirely ("across overseas suppliers").

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
