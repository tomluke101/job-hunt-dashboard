import { auth } from "@clerk/nextjs/server";
import { createServerSupabaseClient } from "@/lib/supabase-server";
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
import {
  generateMasterProfileFromFactBase,
  scanExcludedPhrases,
} from "./master-profile";

// Load the user's global Profile-exclusions list. Returns [] if missing /
// column not migrated yet / unauthenticated. Used everywhere a Profile is
// generated so excluded phrases never surface, regardless of which path
// produced the Profile.
async function loadUserExclusions(): Promise<string[]> {
  try {
    const { userId } = await auth();
    if (!userId) return [];
    const supabase = await createServerSupabaseClient();
    const { data } = await supabase
      .from("user_profile")
      .select("profile_exclusions")
      .eq("user_id", userId)
      .maybeSingle();
    if (!data) return [];
    const raw = (data as { profile_exclusions?: unknown }).profile_exclusions;
    if (!Array.isArray(raw)) return [];
    return raw.filter((e): e is string => typeof e === "string" && !!e.trim());
  } catch (e) {
    console.error("[loadUserExclusions] error:", e);
    return [];
  }
}

// Load the user's saved Master Profile. If masterId is provided, loads that
// specific one; otherwise loads the default Master.
async function loadMasterProfile(masterId?: string): Promise<{ summary: string; name: string } | null> {
  try {
    const { userId } = await auth();
    if (!userId) return null;
    const supabase = await createServerSupabaseClient();
    let query = supabase
      .from("user_master_profile")
      .select("summary, name")
      .eq("user_id", userId);
    if (masterId) {
      query = query.eq("id", masterId);
    } else {
      query = query.eq("is_default", true);
    }
    const { data } = await query.maybeSingle();
    return data && data.summary ? { summary: data.summary, name: data.name ?? "My Master" } : null;
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
  // Optional — which Master to use. If omitted (and bypassMaster is false),
  // the user's default Master is used. Lets the UI pass the explicit
  // selection from the picker.
  masterId?: string;
  // When true, skip Master loading entirely — the AI generates a Profile
  // from FactBase + JD with no verbatim Master to restore. Used when the
  // user explicitly bypasses their saved Masters for a cross-domain JD.
  // We need this as a distinct flag so undefined masterId doesn't silently
  // fall back to the default Master.
  bypassMaster?: boolean;
  // Target role family for the BYPASS path's Profile generation. Lets the
  // CV builder say "this JD is a Consulting role, generate a Consulting-
  // framed Profile from FactBase" — without needing the user to save a
  // new Master first. When a Master is being used (bypassMaster=false),
  // the Master's own saved target family is the source of truth and this
  // field is ignored.
  targetRoleFamily?: string;
  targetSector?: string;
  // Optional wizard / gap-modal answers. When the CV Builder shows the
  // gap-detection modal in bypass mode and the user answers, these are
  // packed into the Profile generation as wizardContext.anythingElse so
  // the AI has stronger FactBase material. Same pattern as Master gen.
  wizardAnswers?: Array<{ question: string; answer: string }>;
  // Family-fit assessment from the bypass-mode gap modal — drives whether
  // the career-changer template fires in Profile generation.
  factbaseFitForFamily?: "strong" | "transferable" | "minimal";
  transferableAngles?: string[];
  // Skills audit answers from the CV Builder pre-flight checklist modal.
  // confirmedSkills = JD-required skills the user has but weren't yet in
  // their FactBase / Library. vagueSpecifications = named tools that
  // replace generic Library items. additionalSkills = free-text additions.
  // All three flow into Skills generation as truth-contract-grounded inputs.
  skillsAuditAnswers?: {
    confirmedSkills?: string[];
    vagueSpecifications?: Array<{ vagueItem: string; specifics: string[] }>;
    additionalSkills?: string[];
  };
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

  // Pull user-level Profile exclusions ONCE up front. Exclusions are user-
  // global (not per-Master) and must apply on every Profile-producing path:
  // the dedicated Master generator, the no-Master fallback, AND the full-CV
  // tailor (this function). Before this fix, the full-CV path didn't fetch
  // them, so excluded phrases could surface freely in the Profile.
  const exclusions = await loadUserExclusions();

  // Master-aware path: if user has a saved Master Profile, use it VERBATIM as
  // the Profile section. The AI generates the rest of the CV (Experience,
  // Skills, Education) and is told to copy the Profile word-for-word. The
  // critic-rewrite step is also forbidden from touching it (see the
  // restore-verbatim block after the rewrite loop below).
  //
  // Why verbatim by default: the user has curated their Master deliberately —
  // including specific named systems, employer references, and exclusions.
  // Per-JD adaptation by AI introduces drift (substituted named systems,
  // invented credentials, dropped claims). Verbatim is predictable, fast, and
  // honours the user's choices. Per-JD adaptation is opt-in via the per-CV
  // "Adapt to this JD" button (Phase 2) — not the default.
  // If the chosen Master has actual content, use it verbatim as the Profile.
  // If it's empty (e.g. user created a blank Master and hasn't filled it in),
  // we fall through to the AI-generated Profile path — same as having no
  // Master saved.
  let preTailoredProfile: string | null = null;
  // bypassMaster forces the no-Master AI path even if the user has a default
  // Master saved. Used for cross-domain JDs where the saved Master is the
  // wrong starting point. Without this flag, undefined masterId would fall
  // back to the default Master and silently restore it verbatim.
  if (!input.bypassMaster) {
    try {
      const master = await loadMasterProfile(input.masterId);
      if (master && master.summary?.trim()) {
        preTailoredProfile = master.summary.trim();
      }
      // Empty summary → no preTailoredProfile → AI generates Profile fresh.
    } catch (e) {
      console.error("[tailorCV] master profile load failed (continuing without):", e);
    }
  }

  // When no Master backs this run (bypass mode OR the user has no Master
  // saved), generate the Profile via the DEDICATED Master generator first,
  // then use it as the verbatim Profile for the rest of the CV. Reasons:
  // - The full-CV prompt produces 6 sections in one JSON call; Profile
  //   quality is materially weaker than a dedicated single-section call.
  // - The dedicated generator runs a Profile-specific critic loop with up
  //   to 6 attempts and a single-rule fallback for stubborn issues — far
  //   stronger than the full-CV 4-pass mixed critic.
  // - Master-grade prompt covers anchors-appear-once, S2 pairing, identity
  //   anchoring, sole-vs-collaborative attribution, no false-causal-links,
  //   and more — rules the full-CV prompt doesn't fully replicate.
  // The result becomes preTailoredProfile and the full-CV pass copies it
  // verbatim — same code path that handles users with a saved Master.
  if (!preTailoredProfile) {
    try {
      const profileResult = await generateMasterProfileFromFactBase({
        cvId: input.cvId,
        connectedProviders: keys,
        exclusions,
        targetJdText: input.jdText,
        // For the BYPASS / no-Master path, the caller can supply an explicit
        // target role family (e.g. fit-scoring detected "Data/Analytics" for
        // a user with only Procurement Masters). The dedicated Profile
        // generator uses this to frame the Profile for that career
        // direction — same FactBase, different emphasis + vocabulary.
        targetRoleFamily: input.targetRoleFamily,
        targetSector: input.targetSector,
        // Wizard answers from the bypass-mode gap modal in the CV Builder.
        // Packed into the Profile generation as wizardContext.anythingElse
        // so the AI has stronger FactBase material before running the
        // critic loop. Same pattern as the Master gen flow on /profile.
        wizardContext:
          input.wizardAnswers && input.wizardAnswers.length > 0
            ? {
                stage: null,
                anythingElse: input.wizardAnswers
                  .map((a) => `Q: ${a.question}\nA: ${a.answer}`)
                  .join("\n\n"),
              }
            : undefined,
        // Family-fit assessment from the bypass-mode gap detector. Drives
        // whether the career-changer template fires in the Profile prompt.
        // Skipping this on bypass means the silent server-side fit
        // assessment kicks in (which works but costs an extra AI call).
        factbaseFitForFamily: input.factbaseFitForFamily,
        transferableAngles: input.transferableAngles,
      });
      if (profileResult.summary?.trim()) {
        preTailoredProfile = profileResult.summary.trim();
      } else if (profileResult.error) {
        console.warn(
          "[tailorCV] dedicated Profile gen failed, falling back to inline:",
          profileResult.error
        );
      }
    } catch (e) {
      console.error("[tailorCV] dedicated Profile gen threw, falling back to inline:", e);
    }
  }

  const systemPrompt = buildSystemPrompt(exclusions);
  const userPrompt = buildUserPrompt({
    factbaseText,
    jdText: input.jdText,
    companyName: input.companyName,
    roleName: input.roleName,
    preTailoredProfile: preTailoredProfile ?? undefined,
    skillsAuditAnswers: input.skillsAuditAnswers,
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

  // Post-process critic: scan for banned phrases, JD echo, uniform-length
  // bullets, Profile-rule violations, AND user-level Profile exclusions. Any
  // hit triggers a single targeted AI call to rewrite the offenders.
  const flagged = [
    ...scanBannedPhrases(sanitised),
    ...scanJDEcho(sanitised, input.jdText),
    ...scanBulletVariance(sanitised),
    ...scanProfile(sanitised),
    ...scanSkills(sanitised),
    ...scanExcludedPhrases({ summary: sanitised.summary, exclusions }),
  ];
  if (flagged.length > 0) {
    let current = sanitised;
    let lastFlagged = flagged;
    let succeeded = false;
    // Up to FOUR rewrite passes: each pass gets stronger language than the
    // last so stubborn issues (multi-action S2, anchor leaks, brand-tier
    // employer drops) actually get fixed.
    for (let attempt = 0; attempt < 4; attempt++) {
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
          ...scanSkills(fixed),
          ...scanExcludedPhrases({ summary: fixed.summary, exclusions }),
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
      // Restore verbatim Master if user has one — the critic must not silently
      // mutate the Profile the user explicitly saved.
      if (preTailoredProfile) current.summary = preTailoredProfile;
      return {
        tailoredCV: current,
        warnings,
        jdKeywords: current.jdKeywords,
        gaps: current.gaps,
      };
    }
    if (current !== sanitised) {
      if (preTailoredProfile) current.summary = preTailoredProfile;
      // Use the last rewrite even if not fully clean — better than the first pass.
      return {
        tailoredCV: current,
        warnings: [
          ...warnings,
          ...formatFlaggedWarnings(lastFlagged),
        ],
        jdKeywords: current.jdKeywords,
        gaps: current.gaps,
      };
    }
    warnings.push(...formatFlaggedWarnings(flagged));
  }

  if (preTailoredProfile) sanitised.summary = preTailoredProfile;
  return {
    tailoredCV: sanitised,
    warnings,
    jdKeywords: sanitised.jdKeywords,
    gaps: sanitised.gaps,
  };
}

// Convert flagged BannedHits into specific user-facing warnings. Names the
// section AND surfaces a short snippet of the offending phrase so the user
// knows exactly what to fix manually rather than just being told there's a
// vague "AI-tell".
function formatFlaggedWarnings(flagged: BannedHit[]): string[] {
  if (flagged.length === 0) return [];
  // Group by section for compact display.
  const bySection = new Map<string, string[]>();
  for (const f of flagged) {
    const section = f.section || "Output";
    // Trim phrase to a readable hint.
    const cleaned = f.phrase.replace(/\s+/g, " ").trim();
    const hint =
      cleaned.length > 140 ? cleaned.slice(0, 137) + "…" : cleaned;
    const list = bySection.get(section) ?? [];
    list.push(hint);
    bySection.set(section, list);
  }
  const messages: string[] = [];
  for (const [section, hints] of bySection) {
    const dedup = Array.from(new Set(hints));
    const top = dedup.slice(0, 4);
    const more = dedup.length - top.length;
    messages.push(
      `Critic flagged ${dedup.length} issue${dedup.length === 1 ? "" : "s"} in ${section}: ${top.map((h) => `"${h}"`).join("; ")}${more > 0 ? `; +${more} more` : ""}. Click "Tailor CV" again to regenerate, or ignore if intentional.`
    );
  }
  return messages;
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
  // Exclusions apply equally on refine — without this, a refine pass could
  // re-introduce an excluded phrase that the initial tailor avoided.
  const exclusions = await loadUserExclusions();
  const systemPrompt = buildSystemPrompt(exclusions);
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
    ...scanSkills(sanitised),
    ...scanExcludedPhrases({ summary: sanitised.summary, exclusions }),
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
  // Widened to catch any "actionable X" — the model paraphrased to
  // "actionable visibility" / "actionable clarity" to dodge the original
  // narrow list. "Actionable" is itself the AI tell; the noun after it
  // doesn't matter.
  ["actionable [X]", /\bactionable\s+\w+/gi],
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
  // "absorbing" / "absorbs" — the model leans on this as a soft euphemism
  // for "managed" when describing scope absorption (e.g. "absorbing higher
  // PO volumes"). It reads as AI-tell hedging. The Adapt prompt bans it but
  // until now no deterministic scanner enforced it on the full-CV path.
  ["absorbing / absorbed", /\babsorb(?:ing|ed|s)\b/gi],
  // "hands-on" — adjective AI-tell. Listed in the Master prompt's banned
  // vocabulary but no deterministic scanner enforced it; model used "hands-
  // on contract-review work" and slipped past the critic.
  ["hands-on", /\bhands[\s-]on\b/gi],
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

export function scanBannedPhrases(cv: TailoredCV): BannedHit[] {
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
// Deterministic "absorbing" kill — final post-critic safety net for the
// model's strongest scope-claim verb bias. After the critic loop finishes,
// if "absorbing" / "absorbed" / "absorbs" survived (because the model
// genuinely cannot escape this bias in 6 rewrites), this replaces with
// "managing" / "managed" / "manages" programmatically. Guarantees the
// banned verb never ships.
//
// Why deterministic kill is justified here: this is the highest-frequency
// Claude tell in CV-generation contexts. The prompt bans it. The scanner
// catches it. The critic loop tries to rewrite. The model keeps producing
// it. Same pattern as em-dashes. Brute-force replace is the only reliable
// guarantee.
//
// Replacement choice: "managing" is the universal safe substitute. Real
// human CV writers say "managing higher PO volumes", not "absorbing higher
// PO volumes" — the swap reads natural in every context where "absorbing"
// appears as scope-claim filler.
export function killAbsorbingDeterministic(text: string): string {
  if (!text) return text;
  return text
    .replace(/\babsorbing\b/g, "managing")
    .replace(/\bAbsorbing\b/g, "Managing")
    .replace(/\babsorbed\b/g, "managed")
    .replace(/\bAbsorbed\b/g, "Managed")
    .replace(/\babsorbs\b/g, "manages")
    .replace(/\bAbsorbs\b/g, "Manages");
}

// Deterministic em-dash kill — final post-critic safety net. After the
// critic loop finishes, if any em-dash variant survived (because the model
// kept producing them despite all six rewrite attempts), this strips them
// programmatically. Replaces with ". " + capitalised next word, which
// converts the parenthetical aside into its own sentence — the cleanest
// non-em-dash equivalent. Guarantees no em-dash variant ships, no matter
// what the model does.
//
// Catches all four variants:
//   — (U+2014 em-dash)
//   – (U+2013 en-dash)
//   -- (double-hyphen)
//   space-hyphen-space ( - ) used as faux em-dash
//
// Safe for compound words ("First-Class", "Co-designed") because those have
// no leading/trailing spaces around the hyphen.
export function killEmDashesDeterministic(text: string): string {
  if (!text) return text;
  // Single regex that matches all em-dash variants (with surrounding
  // whitespace handled) and produces a placeholder we can split on.
  const PLACEHOLDER = "EMDASHSPLIT";
  const replaced = text.replace(
    /\s*[—–]\s*|\s+--\s+|\s+-\s+/g,
    PLACEHOLDER
  );
  const parts = replaced.split(PLACEHOLDER);
  if (parts.length === 1) return text;
  let out = parts[0].trimEnd();
  for (let i = 1; i < parts.length; i++) {
    const next = parts[i].trimStart();
    if (!next) continue;
    // End previous segment with period if not already a sentence terminator.
    if (!/[.!?]$/.test(out)) out += ".";
    // Capitalise first letter of next segment.
    out += " " + next[0].toUpperCase() + next.slice(1);
  }
  return out;
}

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
  if (sc < 3 || sc > 5) {
    hits.push({
      section: "Profile",
      phrase: `${sc} sentence${sc === 1 ? "" : "s"} — target 3-5 sentences. Each must be one-breath readable; if you can't fit a claim into one breath, split into another short sentence.`,
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
  "Produces", "Holds", "Brings", "Manages", "Tracks", "Delivers",
  "Demonstrates", "Possesses", "Operates", "Specialises", "Maintains",
  "Combines", "Carries", "Owns", "Has",
  // Phase A additions — verbs that snuck through ("Analyses…")
  "Analyses", "Analyzes", "Investigates", "Runs", "Leads", "Designs",
  "Builds", "Implements", "Coordinates", "Generates", "Develops", "Creates",
  "Pulls", "Writes", "Reports", "Reviews", "Presents", "Forecasts",
  "Negotiates", "Sources", "Reduces", "Improves", "Drives", "Oversees",
  "Supports", "Handles", "Plans", "Audits", "Reconciles", "Synthesises",
  "Synthesizes",
  // Phase B additions — caught from May 2026 GS Adapt tests ("Prepares…")
  "Prepares", "Compiles", "Drafts", "Files", "Submits", "Identifies",
  "Conducts", "Performs", "Engages", "Collaborates", "Partners", "Liaises",
  "Communicates", "Monitors", "Assesses", "Evaluates", "Measures",
  "Examines", "Validates", "Verifies", "Approves", "Schedules",
  "Organises", "Organizes", "Hosts", "Attends", "Trains", "Mentors",
  "Advises", "Consults", "Guides", "Helps", "Recommends", "Proposes",
  "Pitches", "Sells", "Procures", "Purchases", "Receives", "Distributes",
  "Allocates", "Assigns", "Delegates", "Hires", "Onboards", "Updates",
  "Refreshes", "Migrates", "Rebuilds", "Optimises", "Optimizes",
  "Enhances", "Restructures", "Rewrites", "Reorganises", "Reorganizes",
  "Automates", "Digitises", "Digitizes", "Accelerates", "Extends",
  "Expands", "Scales", "Grows", "Increases", "Boosts", "Doubles",
  "Triples", "Halves", "Drops", "Saves", "Recovers", "Reclaims",
  "Returns", "Refunds", "Mitigates", "Protects", "Absorbs", "Excels",
  "Outperforms", "Heads", "Chairs", "Anchors", "Champions", "Pioneers",
  "Spearheads", "Launches", "Releases", "Publishes", "Posts", "Rolls",
  "Refactors", "Modernises", "Modernizes", "Streamlines", "Simplifies",
  "Cuts", "Saves", "Captures", "Captains", "Steers", "Pilots", "Tests",
  "Ships", "Closes", "Wins", "Trains", "Coaches", "Counsels", "Briefs",
];

// Allowlist of capitalised words that CAN legitimately open a Profile body
// sentence even though they end in -s/-es. These are nouns / adjectives /
// proper nouns / role descriptors, not third-person verbs.
const PROFILE_S_OPEN_ALLOWLIST = new Set([
  "Sole", "Solo", "Founding", "First", "Senior", "Junior", "Lead", "Head",
  "Chief", "Principal", "Associate", "Acting", "Assistant", "Deputy",
  "Strong", "Practical", "Targeting", "Combining", "Building", "Owning",
  "Running", "Designing", "Leading", "Scaling", "Recovering", "Switching",
  "Drafting", "Producing", "Coordinating", "Working", "Reporting",
  "Analysing", "Analyzing", "Managing", "Owning", "Awarded", // Awarded handled by separate scanner
  "Supply", "Strategic", "Tactical", "Procurement", "Marketing",
  "Sales", "Operations", "Engineering", "Finance", "Risk", "Compliance",
  "Customer", "Client", "Brand", "Product", "Programme", "Program",
  "Project", "Process", "Platform", "Data", "Software", "Systems",
  "First-Class", "Upper-Second", "Lower-Second",
  "Trained", "Educated", "Holding", "Bringing", "Awarded",
  "Targets", // numerical close: "Targets a [role] at [employer]" — rare but legitimate
]);

// Fallback regex catching ANY capitalised word ending in -s/-es at a body
// sentence start that isn't on the allowlist. The explicit verb list above
// is exhaustive of common cases; this catches the long tail.
const PROFILE_S_OPEN_FALLBACK = /^([A-Z][a-z]+(?:es|s))\b/;
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
    const firstWord = sentence.split(/\s+/)[0]?.replace(/[^A-Za-z'-]/g, "");
    if (!firstWord) continue;

    // (a) Explicit deny-list match — known third-person verbs.
    if (PROFILE_THIRD_PERSON_VERBS.includes(firstWord)) {
      hits.push({
        section: "Profile",
        phrase: `sentence opens with third-person verb "${firstWord}…". Profile must be implied first person, not narrated about the candidate.`,
      });
      break;
    }

    // (b) Fallback regex — any capitalised -s/-es ending at sentence start
    // that ISN'T on the allowlist. Catches the long tail of unlisted verbs
    // (Liaises, Recommends, Champions, etc.). The allowlist exempts legit
    // sentence openers (Sole, Targeting, role descriptors, proper nouns).
    if (
      PROFILE_S_OPEN_FALLBACK.test(firstWord) &&
      !PROFILE_S_OPEN_ALLOWLIST.has(firstWord)
    ) {
      hits.push({
        section: "Profile",
        phrase: `sentence opens with third-person -s/-es verb "${firstWord}…" — reads as a recruiter speaking ABOUT the candidate, not as the candidate. Restart with a gerund ("Producing…"), past-tense ("Produced…"), or noun-form ("Sole [role] producing…"). NEVER a verb ending in -s.`,
      });
      break;
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
  // True tricolon = three short noun-phrase items separated by commas / and.
  // Each item bounded to 1-4 words to avoid flagging compound verb clauses
  // ("X, building Y from scratch that recovered refunds and guided Z" — that's
  // one main action with a nested participial clause, not a list).
  const ITEM = "[A-Za-z][\\w-]*(?:\\s+[\\w-]+){0,3}"; // 1-4 words
  // Oxford: "X, Y, and Z" — three short noun-phrase items separated by
  // commas with a final ", and Z".
  const oxford = new RegExp(
    `${ITEM}\\s*,\\s*${ITEM}\\s*,\\s*and\\s+${ITEM}`,
    "i"
  );
  // Non-Oxford: "X, Y and Z" — three short noun-phrase items where the
  // last two are joined by "and" (no Oxford comma). Requires a sentence-
  // terminating punctuation after the third item so we only flag tricolons
  // that ARE the structural close of a clause. Functional-list patterns
  // like "manage X, Y and Z across the business" (where Z is followed by a
  // prepositional phrase, not punctuation) are real enumerations of items,
  // not AI-cliché tricolons — those slip through deliberately.
  const nonOxford = new RegExp(
    `${ITEM}\\s*,\\s*${ITEM}\\s+and\\s+${ITEM}\\s*(?:[.!?,]|$)`,
    "i"
  );
  for (let i = 0; i < sentences.length; i++) {
    const s = sentences[i];
    if (oxford.test(s) || nonOxford.test(s)) {
      hits.push({
        section: "Profile",
        phrase: `sentence ${i + 1} is a tricolon (X, Y, and Z list). Pick one or two items; do not list three.`,
      });
    }
  }
  return hits;
}

// 5. NO EM-DASH IN PROFILE — em-dash is a Claude tell. Catches multiple
// variants: em-dash (—), en-dash (–), double-hyphen (--), and space-hyphen-
// space ( - ) used as a parenthetical separator (which reads as a faux em-
// dash). All forbidden; replace with comma, period, or restructure.
function scanProfileEmDash(cv: TailoredCV): BannedHit[] {
  const hits: BannedHit[] = [];
  if (!cv.summary) return hits;
  // Em-dash (U+2014) or en-dash (U+2013).
  if (/[—–]/.test(cv.summary)) {
    hits.push({
      section: "Profile",
      phrase: `contains em-dash or en-dash. Em-dash is a Claude tell. Replace EVERY em-dash with a comma, period, or restructure the sentence. Do not substitute en-dash, double-hyphen, or space-hyphen-space as a workaround.`,
    });
  }
  // Double-hyphen as em-dash substitute.
  if (/--/.test(cv.summary)) {
    hits.push({
      section: "Profile",
      phrase: `contains double-hyphen (--) used as an em-dash substitute. Same Claude tell. Replace with comma, period, or restructure.`,
    });
  }
  // Space-hyphen-space as faux em-dash. We carve out the case where the
  // hyphen is part of a compound word ("First-Class", "2x-revenue", etc.)
  // by requiring whitespace on BOTH sides of a bare hyphen.
  if (/\s-\s/.test(cv.summary)) {
    hits.push({
      section: "Profile",
      phrase: `contains space-hyphen-space ( - ) used as an em-dash substitute. Replace with comma, period, or restructure. If the hyphen is part of a compound word, the spaces around it are wrong.`,
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

// 10a. SECTOR-DESCRIPTOR WITHOUT SCALE — catches "at a D2C eyewear brand",
// "at an innovative consumer business", "at a growing fintech" and similar
// decorative descriptors that occupy S1 real estate without adding any
// recruiter signal. The prompt's EMPLOYER-DESCRIPTOR rule says descriptors
// are allowed ONLY when they carry a real scale / position / market signal
// (£-figure, count, top-N, FTSE-listed, named geographic market). This
// scanner enforces the rule deterministically.
function scanProfileEmployerDescriptorWithoutScale(cv: TailoredCV): BannedHit[] {
  const hits: BannedHit[] = [];
  if (!cv.summary) return hits;
  const sentences = splitSentences(cv.summary);
  if (sentences.length === 0) return hits;

  // First: catch possessive employer constructions ANYWHERE in the Profile
  // body ("Grain and Frame's supply chain", "Acme Ltd's procurement
  // function"). These violate the EMPLOYER-NAME RULE — non-brand-tier
  // employers should never appear in the Profile body. Scope to S1+S2+S3
  // (the body) — S4 sometimes has legitimate possessive constructions in
  // degree-context.
  const employerForPossessiveCheck = cv.roles[0]?.company?.trim() ?? "";
  if (employerForPossessiveCheck) {
    const body = sentences.slice(0, 3).join(" ");
    const employerLower = employerForPossessiveCheck.toLowerCase();
    const bodyLower = body.toLowerCase();
    // Look for "[Employer]'s" or "[Employer]'s" with curly apostrophe.
    const possessiveRegex = new RegExp(
      `\\b${employerLower.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}['’]s\\b`,
      "i"
    );
    if (possessiveRegex.test(bodyLower)) {
      hits.push({
        section: "Profile",
        phrase: `Profile body contains "${employerForPossessiveCheck}'s [X]" — possessive non-brand-tier employer name. The employer name lives in the Experience section, not the Profile. Drop the possessive and refer to the function generically: "the supply chain" / "the function" / "the procurement team". Repeating the employer name in the Profile wastes precious words and reads clunky.`,
      });
    }
  }

  const s1 = sentences[0];

  // Match "at a/an/the [content]" up to next punctuation (comma, period, etc).
  // Skip proper-noun-only patterns ("at Siemens DISW" — no article) since
  // those are employer names handled by scanProfileBrandTierEmployer.
  const descriptorMatch = s1.match(/\bat\s+(?:a|an|the)\s+([^.,!?;]+)/i);
  if (!descriptorMatch) return hits;
  const descriptor = descriptorMatch[1].trim();

  // Skip if the descriptor IS the employer name itself (e.g. "at the BBC" — "BBC"
  // is the employer, not a sector descriptor; "the" is the article).
  const currentEmployer = cv.roles[0]?.company?.toLowerCase().trim() ?? "";
  if (currentEmployer && descriptor.toLowerCase().startsWith(currentEmployer)) {
    return hits;
  }

  // Scale signals — any of these legitimises a sector descriptor.
  const hasScale =
    // Any digit (covers £X, $X, NX, N-person, N%)
    /\d/.test(descriptor) ||
    // Currency symbol (without digit — rare but possible)
    /[£$€]/.test(descriptor) ||
    // Scale words (million / billion / thousand etc.)
    /\b(?:million|billion|bn|tn|thousand|hundreds\s+of\s+thousands)\b/i.test(descriptor) ||
    // Brand-tier / known-scale tokens
    /\b(?:FTSE\s*(?:100|250)?|S&P|FAANG|MBB|Big\s*4|Magic\s*Circle|unicorn|listed)\b/i.test(descriptor) ||
    // "top-N" / "top N" rank
    /\btop[\s-]\d/i.test(descriptor) ||
    // Counted entities ("12-person team", "20-employee firm", "5-country footprint")
    /\b\d+[-\s]?(?:person|employee|staff|country|countries|market|markets|region|regions|site|sites|location|locations|store|stores|client|clients|customer|customers|user|users|seller|sellers|product)/i.test(descriptor) ||
    // Named geographic markets (the prompt's "named market context" allowance —
    // e.g. "an FMCG export business serving EU and US")
    /\b(?:UK|US|EU|EMEA|APAC|North\s+America|Latin\s+America|MENA|sub-Saharan|cross-border|multi-country|multi-region)\b/.test(descriptor);

  if (!hasScale) {
    hits.push({
      section: "Profile",
      phrase: `S1 ends with a sector descriptor ("at a ${descriptor}") that carries NO scale or position signal — it's decorative filler that wastes words without adding recruiter signal. Either ADD a real signal (£/$/€-figure, count of entities, "top-N", FTSE/listed, named geographic market — e.g. "at a £10M D2C consumer-goods business" or "at a top-3 UK fintech") OR REMOVE the descriptor entirely and lead S1 with role + work scope only ("Supply Chain Analyst working across procurement and demand planning…").`,
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

  // Even when a named item appears, flag generic OUTCOME language that
  // doesn't quantify or name a result. "improving delivery performance",
  // "improved data visibility", "cutting cost", "boosting efficiency",
  // "replacing the previous approach", "replacing fragmented records",
  // "improving how data is X" — these read as filler. A strong outcome is:
  //   - A £/% number ("recovered £40k", "cut 18 suppliers")
  //   - A named thing recovered/switched/saved ("refunds on damaged stock",
  //     "logistics provider", "ERP system")
  //   - An OTIF/specific KPI name
  // We flag generic outcome patterns unless paired with a number.
  //
  // Verb forms include BOTH gerund ("improving") AND past participle
  // ("improved") — past participles appear as adjectives modifying the
  // noun ("through improved data visibility") and dodge gerund-only
  // detectors.
  const genericOutcomePatterns = [
    // Gerund + outcome-noun. Suffix list covers the soft "X visibility / X
    // structure / X access" family that the model uses to dodge harder
    // banned patterns (e.g. "improving data structure and access across the
    // business" instead of "improving data visibility").
    /\b(?:improving|boosting|enhancing|optimising|optimizing|driving|elevating|uplifting|strengthening|streamlining)\s+(?:delivery|operational|business|team|process|cost|cost\s+\w+|service|quality|reporting|data|stakeholder|workflow|operations?|decision[-\s]making)\s+(?:performance|efficiency|metrics|outcomes|results|capability|visibility|accuracy|reliability|transparency|clarity|consistency|structure|access|quality|governance|integrity|hygiene|cohesion)\b/i,
    // Past-participle + outcome-noun ("improved data visibility")
    /\b(?:improved|boosted|enhanced|optimised|optimized|elevated|uplifted|strengthened|streamlined)\s+(?:delivery|operational|business|team|process|cost|service|quality|reporting|data|stakeholder|workflow|operations?|decision[-\s]making)\s+(?:performance|efficiency|metrics|outcomes|results|capability|visibility|accuracy|reliability|transparency|clarity|consistency|structure|access|quality|governance|integrity|hygiene|cohesion)\b/i,
    // "improving how X is Y" / "changing the way X is Y" — abstract verbal
    // construct with no quantified result.
    /\b(?:improving|changing|transforming|overhauling)\s+(?:how|the\s+way)\s+\w+\s+(?:is|are|gets?)\s+\w+/i,
    // "replacing the [X] approach" / "replacing the business's previous
    // approach" / "replacing fragmented records" / "replacing manual
    // processes" — abstract before/after framing without a specific delta.
    // Captures any combo of articles + possessives + AI-tell adjective +
    // generic-system-noun. Articles/possessives can repeat 0-4 times (e.g.
    // "the business's", "our existing", "its outdated") with each consuming
    // its own trailing space, so the regex correctly handles both "replacing
    // the previous approach" and "replacing the business's previous approach".
    /\breplacing\s+(?:(?:the|an?|our|its|business[']?s)\s+){0,4}(?:previous|legacy|existing|outdated|prior|old|fragmented|manual|paper[-\s]based|spreadsheet[-\s]based|ad[-\s]hoc|patchy|disjointed|siloed|inconsistent)\s+(?:approach(?:es)?|method(?:s)?|system(?:s)?|process(?:es)?|way(?:s)?|records?|workflows?|spreadsheets?|tooling|setup(?:s)?|infrastructure|reporting)\b/i,
    /\bcutting\s+cost\b(?!\s+(?:by|of|across|on)\s+\d)/i,
    /\breducing\s+(?:cost|spend|overhead|risk)\b(?!\s+(?:by|of|across|on)\s+\d)/i,
    // "cutting / reducing [generic noun] across [generic-place noun]" without
    // a number. e.g. "cutting manual data handling across the team",
    // "reducing manual processes across the business". These are vague soft
    // outcomes the model uses to gesture at impact without committing to a
    // measurable claim.
    /\b(?:cutting|reducing|eliminating)\s+(?:manual|repetitive|duplicate|administrative|admin|back-?office|back\s+office|paper-?based|spreadsheet-?based|ad[-\s]hoc)\s+(?:data\s+handling|processing|process(?:es)?|workflows?|task\s+handling|tasks?|reporting|reconciliation|entry|inputs?|work)\s+across\s+(?:the\s+)?(?:team|business|function|department|office|company)\b(?!.{0,40}\d)/i,
    // "through improved X" / "via improved X" — the causal-bridge variant
    // that connects an outcome to a generic improvement.
    /\b(?:through|via|with)\s+improved\s+(?:delivery|operational|business|team|process|cost|service|quality|reporting|data|stakeholder|workflow|decision[-\s]making)\s+(?:performance|efficiency|metrics|outcomes|results|capability|visibility|accuracy|reliability|transparency|clarity|consistency)\b/i,
  ];
  for (const re of genericOutcomePatterns) {
    if (re.test(s3)) {
      hits.push({
        section: "Profile",
        phrase: `S3 contains a generic outcome phrase ("${(s3.match(re) ?? [""])[0]}") with no quantified result. Replace with a NAMED specific outcome: a £/% figure ("recovered £40k of refunds"), a named thing acted on ("recovered refunds on damaged stock", "switched the logistics provider"), or a named KPI ("OTIF lifted to 96%"). Generic verbs paired with generic outcomes ("improving delivery performance", "cutting cost") are filler.`,
      });
      break;
    }
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

// 16. STRUCTURAL HEDGE — "during a period of …" wedges the scope anchor into
// a subordinate clause instead of leading S2 with it. Reads as AI fluff. Same
// for "through a period of", "in a period of", "amid a period of". The anchor
// should be the SUBJECT of the verb, not a temporal qualifier on a different verb.
// Note: matches even with adjectives between "a" and "period" — "during a
// SUSTAINED period of N", "during a EXTENDED period of N", etc.
const STRUCTURAL_HEDGE_PATTERNS = [
  /\b(?:during|through|in|amid|across|over)\s+(?:a\s+(?:\w+\s+){0,3})?period\s+of\b/i,
  // "Supported X by ..." / "Helped support X" — passive scaffolding around the
  // anchor instead of leading with the verb.
  /\bsupported\s+\d+x\s+(?:revenue|growth)/i,
  // "amid increased complexity" / "in a scaling environment" — abstraction
  // without a real anchor.
  /\bin\s+a\s+(?:scaling|growing|fast[- ]paced|fast[- ]moving|dynamic|complex|evolving)\s+(?:environment|business|company|setting|market)/i,
  // Defensive opener — "Outside a formal X / Despite no X / Without formal X"
  // — small-business limitation hedges. The action should stand alone as
  // evidence; the hedge signals the candidate had to work around a deficit.
  // Reframe to lead with the action.
  /^\s*(?:Outside|Despite\s+no|Despite\s+lacking|Without\s+(?:a\s+)?formal|Absent\s+(?:a\s+)?formal|In\s+the\s+absence\s+of)\b[^,.]*[,.]/i,
  /(?:^|[.!?]\s+)(?:Outside|Despite\s+no|Despite\s+lacking|Without\s+(?:a\s+)?formal|Absent\s+(?:a\s+)?formal|In\s+the\s+absence\s+of)\b[^,.]*,/i,
];
function scanProfileStructuralHedge(cv: TailoredCV): BannedHit[] {
  const hits: BannedHit[] = [];
  if (!cv.summary) return hits;
  for (const re of STRUCTURAL_HEDGE_PATTERNS) {
    const m = cv.summary.match(re);
    if (m) {
      hits.push({
        section: "Profile",
        phrase: `Profile contains a structural hedge ("${m[0]}"). This wedges the scope anchor into a subordinate clause instead of leading S2 with it. Lead S2 with the anchor as the subject — "Scaled the function through 2x revenue growth" not "Switched logistics partners during a period of 2x revenue growth".`,
      });
      break;
    }
  }
  return hits;
}

// 17. MULTI-ACTION JAM — S2 should pair ONE scope anchor with ONE specific
// named action. Jamming three actions ("Scaled X and switched Y, cutting Z")
// muddles the message. Count past-tense action verbs in S2; if more than 2,
// flag.
const PAST_TENSE_ACTION_VERBS = [
  "built",
  "designed",
  "launched",
  "delivered",
  "shipped",
  "scaled",
  "switched",
  "cut",
  "saved",
  "recovered",
  "negotiated",
  "rebuilt",
  "rolled",
  "led",
  "ran",
  "owned",
  "absorbed",
  "consolidated",
  "halved",
  "doubled",
  "tripled",
  "modelled",
  "rebalanced",
  "drove",
  "spun",
  "transformed",
  "automated",
  "streamlined",
  "drafted",
  "closed",
  "won",
];
// Gerund-form action verbs. Counted alongside past-tense action verbs because
// a sentence like "Scaled X, analysing Y and switching Z" is just as jammed
// as "Scaled X, analysed Y and switched Z". The gerund form is how the model
// dodges the past-tense scanner.
const GERUND_ACTION_VERBS_RE = /\b(?:cutting|building|switching|scaling|recovering|saving|delivering|shipping|launching|negotiating|driving|rolling|consolidating|automating|streamlining|analysing|analyzing|producing|managing|coordinating|orchestrating|designing|leading|owning|running|tracking|reporting|monitoring|reviewing|overseeing|directing|supporting|enabling|maintaining|drafting|presenting|covering|handling|absorbing|processing|reconciling|forecasting)\b/g;

function scanProfileMultiActionJam(cv: TailoredCV): BannedHit[] {
  const hits: BannedHit[] = [];
  if (!cv.summary) return hits;
  const sentences = splitSentences(cv.summary);

  // Run on S2 AND S3 — both should be single-action. The model dodges the
  // single-S2 check by spilling jammed actions into S3 instead.
  for (const idx of [1, 2]) {
    if (idx >= sentences.length) continue;
    const sentence = sentences[idx].toLowerCase();
    let actionCount = 0;
    const seen = new Set<string>();
    for (const v of PAST_TENSE_ACTION_VERBS) {
      const re = new RegExp(`\\b${v}\\b`, "g");
      if (re.test(sentence) && !seen.has(v)) {
        seen.add(v);
        actionCount += 1;
      }
    }
    GERUND_ACTION_VERBS_RE.lastIndex = 0;
    const gerunds = sentence.match(GERUND_ACTION_VERBS_RE) ?? [];
    const total = actionCount + gerunds.length;
    if (total > 2) {
      const expectation =
        idx === 1
          ? "S2 must pair ONE scope anchor with ONE specific named action."
          : "S3 must contain ONE distinctive claim with ONE specific named item.";
      hits.push({
        section: "Profile",
        phrase: `Sentence ${idx + 1} contains ${total} action verbs jammed into one sentence — muddles the message. ${expectation} Pick the strongest action and drop the others (move them to bullets in Experience).`,
      });
    }
  }
  return hits;
}

// Per-sentence word cap on body sentences (S2 + S3). Strong CV Profiles use
// 12-22 words per body sentence. Sentences over 26 words are almost always
// multi-action jam in disguise — even if the multi-action scanner missed
// them, the length itself is a quality signal.
function scanProfileBodySentenceLength(cv: TailoredCV): BannedHit[] {
  const hits: BannedHit[] = [];
  if (!cv.summary) return hits;
  const sentences = splitSentences(cv.summary);
  for (const idx of [1, 2]) {
    if (idx >= sentences.length) continue;
    const wordCount = sentences[idx].split(/\s+/).filter(Boolean).length;
    if (wordCount > 26) {
      hits.push({
        section: "Profile",
        phrase: `Sentence ${idx + 1} is ${wordCount} words — too long for a Profile body sentence. Body sentences should be 12-22 words each. Long sentences usually mean multiple claims jammed together. Pick the ONE strongest claim and let it stand alone; the others belong in Experience bullets.`,
      });
    }
  }
  return hits;
}

// Cross-sentence theme repetition. Catches keyword-stuffing patterns where
// the model leans on one JD term across multiple sentences. Profiles with
// "supplier performance" appearing in S1, S2, AND S3 read as repetitive and
// signal-poor. Each Profile claim should live in one sentence with varied
// register. Flags any 2-word noun phrase appearing in 3+ sentences.
const THEME_STOP_WORDS = new Set([
  "a", "an", "the", "of", "in", "on", "for", "and", "or", "to", "by", "with",
  "from", "at", "through", "across", "into", "over", "under", "as", "is", "are",
  "was", "were", "be", "been", "this", "that", "these", "those", "their",
  "his", "her", "its", "our", "my", "your", "any", "all", "some", "such",
  "supply", // "supply" alone is too generic (e.g. "supply chain" + "supply base") — let "supply chain" through but downweight "supply"
]);

function scanProfileThemeRepetition(cv: TailoredCV): BannedHit[] {
  const hits: BannedHit[] = [];
  if (!cv.summary) return hits;
  const sentences = splitSentences(cv.summary);
  if (sentences.length < 3) return hits;

  function extractPhrases(s: string): string[] {
    const words = s
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, " ")
      .split(/\s+/)
      .filter(Boolean);
    const phrases: string[] = [];
    for (let i = 0; i < words.length - 1; i++) {
      const a = words[i];
      const b = words[i + 1];
      if (THEME_STOP_WORDS.has(a) || THEME_STOP_WORDS.has(b)) continue;
      if (a.length < 4 || b.length < 4) continue;
      phrases.push(`${a} ${b}`);
    }
    return phrases;
  }

  const phraseSentences = new Map<string, Set<number>>();
  for (let i = 0; i < sentences.length; i++) {
    const phrases = new Set(extractPhrases(sentences[i]));
    for (const p of phrases) {
      if (!phraseSentences.has(p)) phraseSentences.set(p, new Set());
      phraseSentences.get(p)!.add(i);
    }
  }

  for (const [phrase, sentenceSet] of phraseSentences) {
    if (sentenceSet.size >= 3) {
      hits.push({
        section: "Profile",
        phrase: `Phrase "${phrase}" appears in ${sentenceSet.size} sentences — keyword-stuffing. Each Profile claim should live in one sentence with varied register. Drop or rephrase repeated phrases so the Profile reads as distinct evidence, not the same theme repeated.`,
      });
      break;
    }
  }

  // Brand-tier names should appear in ONE sentence only. Surfacing "Siemens
  // DISW" or "Goldman Sachs" twice in a 4-sentence Profile reads as
  // credibility-stuffing — the recruiter already saw it the first time.
  // Catches: any 2-word capitalised phrase in the Master/output appearing
  // in more than one sentence.
  const brandSentences = new Map<string, Set<number>>();
  for (let i = 0; i < sentences.length; i++) {
    const matches = sentences[i].matchAll(/\b([A-Z][a-z]+(?:\s+[A-Z][A-Za-z]+){0,2})\b/g);
    for (const m of matches) {
      const brand = m[1];
      // Skip sentence-initial words (start-of-sentence cap doesn't imply proper noun).
      if (sentences[i].trimStart().startsWith(brand)) continue;
      // Skip very-common multi-word phrases that begin with a cap inside
      // titles ("Supply Chain Analyst", "Project Coordinator" etc.) by
      // requiring at least one short uppercase-cluster token (DISW, BCU,
      // GSK, etc.) OR a known brand-tier name.
      const hasAcronymCluster = /\b[A-Z]{3,}\b/.test(brand);
      const KNOWN_BRANDS = /\b(?:Siemens|Goldman|McKinsey|JLR|Unilever|Diageo|PwC|Deloitte|KPMG|JPMorgan|Stripe|Anthropic|OpenAI|Apple|Google|Meta|Amazon|Microsoft|Bloomberg)\b/;
      if (!hasAcronymCluster && !KNOWN_BRANDS.test(brand)) continue;
      if (!brandSentences.has(brand)) brandSentences.set(brand, new Set());
      brandSentences.get(brand)!.add(i);
    }
  }
  for (const [brand, sentenceSet] of brandSentences) {
    if (sentenceSet.size >= 2) {
      hits.push({
        section: "Profile",
        phrase: `Brand name "${brand}" appears in ${sentenceSet.size} sentences. Brand-tier credibility signals should surface ONCE — the recruiter caught it the first time. Drop the second mention; the action stands on its own without re-anchoring to the brand.`,
      });
      break;
    }
  }
  return hits;
}

// 18a. S1 FLUFF VERBS — "specialising in", "focusing on", "dedicated to",
// "focused on", "centred on" are connective tissue that doesn't add information.
// State the work scope plainly. Also catches "supporting X" as a passive
// scaffolding verb when the user did the X.
function scanProfileS1Fluff(cv: TailoredCV): BannedHit[] {
  const hits: BannedHit[] = [];
  if (!cv.summary) return hits;
  const sentences = splitSentences(cv.summary);
  if (sentences.length === 0) return hits;
  const s1 = sentences[0];
  const fluffPatterns: Array<{ re: RegExp; phrase: string }> = [
    { re: /\bspecialising\s+in\b/i, phrase: "specialising in" },
    { re: /\bspecializing\s+in\b/i, phrase: "specializing in" },
    { re: /\bfocusing\s+on\b/i, phrase: "focusing on" },
    { re: /\bfocused\s+on\b/i, phrase: "focused on" },
    { re: /\bcentred\s+on\b/i, phrase: "centred on" },
    { re: /\bcentered\s+on\b/i, phrase: "centered on" },
    { re: /\bdedicated\s+to\b/i, phrase: "dedicated to" },
    { re: /\bcommitted\s+to\b/i, phrase: "committed to" },
    { re: /\bpassionate\s+about\b/i, phrase: "passionate about" },
  ];
  for (const { re, phrase } of fluffPatterns) {
    if (re.test(s1)) {
      hits.push({
        section: "Profile",
        phrase: `S1 contains "${phrase}" — connective fluff. State the work scope plainly: "Marketing analyst at [employer] working across content and performance" not "...specialising in content and performance".`,
      });
      break;
    }
  }
  return hits;
}

// 18. PASSIVE-AWARDED CLOSE — "Awarded a [degree] from [uni]" reads as passive
// CV-speak. Strong fact closes lead with the degree itself: "First-Class BSc
// Economics from LSE". Same for "Graduated with...", "Holds a...", "Earned
// a...", "Achieved a..." which are all introducer-verbs.
function scanProfileAwardedClose(cv: TailoredCV): BannedHit[] {
  const hits: BannedHit[] = [];
  if (!cv.summary) return hits;
  const sentences = splitSentences(cv.summary);
  if (sentences.length === 0) return hits;
  const last = sentences[sentences.length - 1];
  const passivePatterns: Array<{ re: RegExp; verb: string }> = [
    { re: /^awarded\s+a/i, verb: "Awarded a" },
    { re: /^holds?\s+a/i, verb: "Holds a" },
    { re: /^graduated\s+(?:with|from)/i, verb: "Graduated with" },
    { re: /^earned\s+a/i, verb: "Earned a" },
    { re: /^achieved\s+a/i, verb: "Achieved a" },
    { re: /^completed\s+a/i, verb: "Completed a" },
    { re: /^obtained\s+a/i, verb: "Obtained a" },
    { re: /^received\s+a/i, verb: "Received a" },
    { re: /^attained\s+a/i, verb: "Attained a" },
    { re: /^secured\s+a/i, verb: "Secured a" },
  ];
  for (const { re, verb } of passivePatterns) {
    if (re.test(last)) {
      hits.push({
        section: "Profile",
        phrase: `Final sentence opens with "${verb} ..." — passive CV-speak / introducer verb. Lead with the degree itself: "First-Class BSc Economics from LSE, top of the cohort" — no introducer verb.`,
      });
      break;
    }
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
    ...scanProfileEmployerDescriptorWithoutScale(cv),
    ...scanProfileAnchorLeak(cv),
    ...scanProfileOutcomeSignal(cv),
    ...scanProfileScopeAnchorLeak(cv),
    ...scanProfileSubstantialS2Number(cv),
    ...scanProfileS3Strength(cv),
    ...scanProfileStructuralHedge(cv),
    ...scanProfileMultiActionJam(cv),
    ...scanProfileBodySentenceLength(cv),
    ...scanProfileThemeRepetition(cv),
    ...scanProfileS1Fluff(cv),
    ...scanProfileAwardedClose(cv),
    ...scanProfileSoleVsCoContradiction(cv),
    ...scanProfilePassiveExposure(cv),
    ...scanProfileAbstractNounStack(cv),
  ];
}

// ── Passive exposure scanner (universal) ────────────────────────────────
// Catches "Daily exposure to X" / "Exposure to X" / "Familiarity with X" /
// "Awareness of X" — passive constructions that claim PROXIMITY to a thing
// without claiming ACTION on it. A CV recruiter reads "Daily exposure to
// supplier contracts" as "I'm near contracts" not "I review contracts".
// Active reframing is mandatory: "Reviewing supplier contracts daily" /
// "Handles supplier contract review" / "Manages supplier disputes".
//
// Scope: S1-S3 body only. S4 close is exempt (rare and usually appropriate
// for academic framing).
function scanProfilePassiveExposure(cv: TailoredCV): BannedHit[] {
  const hits: BannedHit[] = [];
  if (!cv.summary) return hits;
  const sentences = splitSentences(cv.summary);
  if (sentences.length === 0) return hits;
  const body = sentences.slice(0, 3).join(" ");

  const patterns = [
    /\b(?:daily|weekly|monthly|regular|frequent|ongoing)\s+exposure\s+to\b/i,
    /\bexposure\s+to\s+\w+(?:\s+\w+){0,5}\s+(?:work|practice|process(?:es)?|terms?|matters?|cases?|disputes?)/i,
    /\bfamiliarity\s+with\s+\w+(?:\s+\w+){0,4}/i,
    /\b(?:strong|good|broad)\s+awareness\s+of\s+\w+/i,
    /\bworking\s+knowledge\s+of\s+\w+/i, // soft cv-tell
    // "provided/provides/giving exposure to" — the disguised nominalisation
    // regression. "X provided daily exposure to Y" is just "doing X gave me
    // experience with Y" dressed up as a noun phrase. Same Claude tell as
    // bare "Daily exposure to X" but harder to spot mid-sentence.
    /\b(?:provided|provides|providing|gave|gives|giving|brought|brings|bringing)\s+(?:daily|weekly|monthly|regular|frequent|ongoing|early|hands-on|first-hand)?\s*exposure\s+to\b/i,
    /\b(?:provided|provides|providing|gave|gives|giving)\s+\w+\s+with\s+exposure\s+to\b/i,
  ];
  for (const re of patterns) {
    if (re.test(body)) {
      hits.push({
        section: "Profile",
        phrase: `Profile body contains passive 'exposure to' / 'familiarity with' / 'working knowledge of' construction. These claim PROXIMITY to a thing, not ACTION on it. Recruiters skip past. Rewrite as an active verb: 'Reviewing supplier contracts daily' / 'Handles supplier contract review' / 'Manages supplier disputes' instead of 'Daily exposure to supplier contract review'. The active form makes the same claim more credibly in fewer words.`,
      });
      break;
    }
  }
  return hits;
}

// ── Abstract-noun-stack scanner (universal) ─────────────────────────────
// Catches AI-y abstract noun phrases like "primary operational data
// structure", "primary X system", "key Y capability" — vague abstract
// stacks that fill words without conveying anything concrete. Real CV
// writers use concrete nouns (a tool name, a count, a specific outcome).
//
// Heuristic: catches "(now |currently )?(the|a) [adj] [generic-abstract-
// noun] [generic-system-noun]" patterns.
function scanProfileAbstractNounStack(cv: TailoredCV): BannedHit[] {
  const hits: BannedHit[] = [];
  if (!cv.summary) return hits;
  const sentences = splitSentences(cv.summary);
  if (sentences.length === 0) return hits;
  const body = sentences.slice(0, 3).join(" ");

  // "primary / central / core / main + operational / strategic / data + structure / framework / system / infrastructure / capability"
  const abstractStackPattern =
    /\b(?:now\s+|currently\s+)?(?:the|a|an)\s+(?:primary|central|core|main|key|critical|fundamental|underlying)\s+(?:operational|strategic|analytical|business|data|process|workflow|reporting|organisational|organizational)\s+(?:structure|framework|system|infrastructure|capability|backbone|foundation|engine)\b/i;
  // "the X's primary [abstract noun]" — possessive variant
  const possessiveAbstractPattern =
    /\b(?:the\s+\w+(?:\s+\w+)?'s|business's|company's|team's|firm's)\s+(?:primary|central|core|main|key|critical)\s+(?:operational|strategic|analytical|business|data|process|workflow|reporting|organisational|organizational)\s+(?:structure|framework|system|infrastructure|capability|backbone|foundation|engine)\b/i;

  if (abstractStackPattern.test(body) || possessiveAbstractPattern.test(body)) {
    hits.push({
      section: "Profile",
      phrase: `Profile body contains an abstract noun stack like "primary operational data structure" or "the business's main analytical framework". These read AI-generic because there's no concrete reality behind them. Replace with a concrete description: name the actual tool ("Airtable ERP, now used daily across procurement and inventory"), name the actual outcome ("now the team's main system for stock reconciliation"), or drop the abstract phrase entirely and let the named tool stand on its own. NEVER stack adjectives + abstract nouns + abstract nouns to fill words.`,
    });
  }
  return hits;
}

// ── Sole-vs-Co contradiction (universal — Truth Contract) ───────────────────
// Catches sentences containing BOTH a "sole [role/builder/owner]" claim AND
// a "co-[designed/built/created]" claim about (implicitly) the same item.
// The candidate cannot be BOTH the sole builder AND a co-collaborator on the
// same artefact — it's a self-contradiction and a Truth Contract violation.
// Real-world example caught: "Sole builder of a bespoke Airtable-based ERP
// system, co-designed with the company director." — sole AND co are
// mutually exclusive attributions.
// Sole-implying signals — phrases that claim the candidate built/owned/
// founded something ALONE. Includes both the "Sole X" form and the
// "from scratch" / "single-handedly" / "built alone" / "founding" patterns
// the model uses as soft euphemisms.
const SOLE_IMPLYING_PATTERNS = [
  /\bsole\s+(?:builder|architect|owner|designer|founder|creator|developer|lead|analyst|engineer|author|maker)\b/i,
  /\bbuilt\s+(?:[^,.;]*\s+)?from\s+scratch\b/i,
  /\bdesigned\s+(?:[^,.;]*\s+)?from\s+scratch\b/i,
  /\bsingle[-\s]handed(?:ly)?\b/i,
  /\bon\s+(?:my|their)\s+own\b/i,
  /\bfound(?:ed|ing)\s+(?:engineer|hire|designer|architect)\b/i,
];

const CO_COLLAB_PATTERNS = [
  /\bco[-\s](?:designed|built|created|developed|founded|authored|led|owned|architected|delivered|launched|wrote|engineered)\b/i,
  /\bjointly\s+(?:designed|built|created|developed|delivered)\b/i,
  /\bpartnered\s+(?:with|alongside)\b/i,
  /\bcollaborated\s+with\b/i,
  /\bhelped\s+to\s+(?:design|build|create|develop|launch)\b/i,
];

function scanProfileSoleVsCoContradiction(cv: TailoredCV): BannedHit[] {
  const hits: BannedHit[] = [];
  if (!cv.summary) return hits;
  const sentences = splitSentences(cv.summary);
  for (let i = 0; i < sentences.length; i++) {
    const s = sentences[i];
    const hasSoleClaim = SOLE_IMPLYING_PATTERNS.some((re) => re.test(s));
    const hasCoCollab = CO_COLLAB_PATTERNS.some((re) => re.test(s));
    if (hasSoleClaim && hasCoCollab) {
      hits.push({
        section: "Profile",
        phrase: `Sentence ${i + 1} contains a self-contradiction: a sole-implying claim ("sole", "from scratch", "single-handedly") AND a collaborative claim ("co-", "with", "alongside") about (implicitly) the same item. The candidate cannot be the SOLE builder AND a COLLABORATOR on the same item — Truth Contract violation. Pick ONE truthful attribution: if they built it alone, drop all collaborative language; if they collaborated, drop "sole" / "from scratch" / "single-handedly".`,
      });
      break;
    }
  }
  return hits;
}

// Cross-references the Profile's sole-implying claims against the FactBase.
// Catches the case the in-sentence contradiction scanner misses: model
// writes "Built X from scratch" while the FactBase explicitly says
// "co-designed X with the director" — no in-sentence contradiction, but a
// direct FactBase Truth Contract violation. Profile must mirror the
// FactBase's attribution wording, not invent solo authorship to make a
// claim sound stronger.
//
// Triggers only when the FactBase contains collaborative wording near a
// named system the Profile claims as sole. Conservative — we flag only
// clear conflicts.
// Scope-anchor enforcer (FactBase-aware). The single most credible recruiter
// signal at any candidate level is a quantified scope anchor (2x revenue
// growth, £40k recovered, 12 suppliers, 30% reduction). The Master prompt
// has a SCOPE-ANCHOR PRESERVATION rule but the generator keeps dropping
// these in career-changer mode to make room for bridge clauses. This is the
// deterministic enforcer: extract scope numbers from the FactBase, verify
// at least one appears in the Profile body. Catches the regression.
//
// Extracts numeric anchors of the form: Nx (revenue growth), £X / $X / €X
// (with optional k/m/M/k suffix), N% (percentage), N+ (count with plus),
// "across N [entities]" (counted scale).
export function scanProfileScopeAnchorVsFactBase(
  cv: TailoredCV,
  factbaseText: string
): BannedHit[] {
  const hits: BannedHit[] = [];
  if (!cv.summary || !factbaseText) return hits;

  // Extract candidate scope anchors from the FactBase. We look for the most
  // recruiter-recognisable patterns; if any appear, the Profile body must
  // surface at least one.
  const factbaseScopeAnchors = extractScopeAnchors(factbaseText);
  if (factbaseScopeAnchors.length === 0) return hits;

  // Check the Profile body (S1-S3) for any scope anchor. S4 close anchors
  // don't count (those are degree details, not work scope).
  const sentences = splitSentences(cv.summary);
  const body = sentences.slice(0, Math.max(3, sentences.length - 1)).join(" ");
  const profileScopeAnchors = extractScopeAnchors(body);

  if (profileScopeAnchors.length === 0) {
    const exampleFromFb = factbaseScopeAnchors[0];
    hits.push({
      section: "Profile",
      phrase: `Profile body has NO quantified scope anchor, but the FactBase contains at least one (e.g. "${exampleFromFb}"). The single most credible recruiter signal at any candidate level is a quantified scope number — Nx growth, £X recovered, N suppliers managed, N% delta. The Profile body MUST surface at least one. Dropping it for bridge framing or sector reframing is a generator failure. Restore the scope anchor in S2 or S3.`,
    });
  }
  return hits;
}

// Extract quantified scope anchors from text. Returns the matched phrases
// (with surrounding context) so the error message can quote a real FactBase
// example back to the model.
function extractScopeAnchors(text: string): string[] {
  if (!text) return [];
  const anchors: string[] = [];
  const seen = new Set<string>();
  const patterns: RegExp[] = [
    // Nx growth / Nx revenue (e.g. "2x revenue growth", "3x growth")
    /\b\d+x\s+(?:revenue\s+growth|growth|increase)\b/gi,
    // Currency amounts (£X, $X, €X, with optional unit suffix and "in/of/by/saved/recovered" context)
    /[£$€]\s?\d+(?:\.\d+)?\s?(?:k|m|million|bn|billion)?(?:\s+(?:in|of|saved|recovered|cut|reduced|recouped|managed|spend))?\b/gi,
    // Percentage outcomes (e.g. "30% reduction", "improved by 20%", "saving 15%")
    /\b\d+(?:\.\d+)?%\s*(?:reduction|improvement|uplift|growth|increase|cut|saving|saved|recovered|cost\s+saving)?\b/gi,
    // Counted entities ("12 overseas suppliers", "5 markets", "20 countries", etc.)
    /\b\d+\+?\s+(?:overseas\s+)?(?:suppliers|countries|markets|regions|sites|locations|stores|distribution\s+centres|teams|clients|customers|product\s+lines|skus|brands|partners|vendors|reports|dashboards|deals|projects|launches)\b/gi,
    // "across N+ X" / "scaling to N" patterns
    /\bacross\s+\d+\+?\s+\w+/gi,
    /\bscal(?:ed|ing)\s+to\s+\d+\+?\s+\w+/gi,
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const v = m[0].trim().toLowerCase();
      if (!seen.has(v)) {
        seen.add(v);
        anchors.push(m[0].trim());
      }
    }
  }
  return anchors;
}

export function scanProfileSoleClaimVsFactBase(
  cv: TailoredCV,
  factbaseText: string
): BannedHit[] {
  const hits: BannedHit[] = [];
  if (!cv.summary || !factbaseText) return hits;

  const summary = cv.summary;
  const factbaseLower = factbaseText.toLowerCase();

  // Collaborative signals to look for in the FactBase.
  const factbaseCollaborativePatterns = [
    /\bco[-\s](?:designed|built|created|developed|founded|authored|architected|delivered|launched|wrote|engineered)\b/i,
    /\bdesigned\s+(?:[^,.;]*\s+)?(?:with|alongside)\s+(?:the\s+)?\w+/i,
    /\bbuilt\s+(?:[^,.;]*\s+)?(?:with|alongside)\s+(?:the\s+)?\w+/i,
    /\bhelped\s+to\s+(?:design|build|create|develop|launch)\b/i,
    /\bpartnered\s+(?:with|alongside)\b/i,
    /\bjointly\b/i,
    /\bcollaborated\s+with\b/i,
    /\balongside\s+the\s+\w+/i,
  ];
  const factbaseHasCollab = factbaseCollaborativePatterns.some((re) =>
    re.test(factbaseLower)
  );
  if (!factbaseHasCollab) return hits;

  // CHECK 1 — explicit sole-implying claim in Profile ("Sole X", "from
  // scratch", "single-handedly").
  const soleClaimMatched = SOLE_IMPLYING_PATTERNS.some((re) => re.test(summary));
  if (soleClaimMatched) {
    hits.push({
      section: "Profile",
      phrase: `Profile claims sole authorship of an item ("sole", "from scratch", "single-handedly", "founding"), but the FactBase contains COLLABORATIVE wording about the same kind of work ("co-designed", "with the director", "alongside", "helped to design"). The Profile must mirror the FactBase's attribution — if the candidate co-designed something with someone else, the Profile must say "co-designed with [collaborator]" or "designed alongside [collaborator]", NOT "built from scratch" or "sole builder". Restate the attribution exactly as the FactBase has it.`,
    });
    return hits;
  }

  // CHECK 2 — implicit sole claim. Profile uses a build/design verb ("Built
  // X", "Designed X", "Created X") about a named system that the FactBase
  // attributes collaboratively. Plain "Built X" without acknowledging
  // collaboration is misleading when the FactBase says co-designed with
  // someone.
  //
  // Heuristic: extract named-system phrases from the FactBase's
  // collaborative claims, then check if the Profile uses a build verb
  // followed by that same noun phrase WITHOUT a collaborative qualifier.
  //
  // We look for "co-designed [phrase]" / "co-built [phrase]" / "designed
  // [phrase] with [collaborator]" / "built [phrase] alongside [X]" in the
  // FactBase, extract the 1-4 word noun phrase, and check if the Profile
  // says "Built [phrase]" / "Designed [phrase]" without "co-" / "with" /
  // "alongside" near the same noun.
  const collabSystemRegex =
    /\b(?:co[-\s](?:designed|built|created|developed)|(?:designed|built|created|developed)\s+(?:with|alongside))\s+(?:an?\s+|the\s+)?([\w-]+(?:\s+[\w-]+){0,4})/gi;
  const collabSystems = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = collabSystemRegex.exec(factbaseLower)) !== null) {
    const phrase = match[1]?.trim().toLowerCase();
    if (!phrase) continue;
    // Take the first 1-3 words as the distinguishing keyword set.
    const words = phrase.split(/\s+/).slice(0, 3);
    // Build progressively shorter keys so we can match either the full
    // phrase or just the noun head ("airtable-based erp system" / "airtable
    // erp" / "erp" all reduce to checking the noun).
    if (words.length >= 1) collabSystems.add(words.join(" "));
    if (words.length >= 2) collabSystems.add(words.slice(0, 2).join(" "));
    // Single distinguishing noun (last word) as a fallback key.
    const lastWord = words[words.length - 1];
    if (lastWord && lastWord.length >= 3) collabSystems.add(lastWord);
  }
  if (collabSystems.size === 0) return hits;

  const summaryLower = summary.toLowerCase();
  // Look for "Built/Designed/Created/Developed [up to 6 words] [SYSTEM KEY]"
  // patterns in the Profile.
  const buildVerbRegex =
    /\b(?:built|designed|created|developed|architected|engineered|launched)\s+(?:an?\s+|the\s+)?((?:[\w-]+\s+){0,5}[\w-]+)/gi;
  let buildMatch: RegExpExecArray | null;
  while ((buildMatch = buildVerbRegex.exec(summaryLower)) !== null) {
    const profilePhrase = buildMatch[1]?.trim();
    if (!profilePhrase) continue;
    // Check whether this Profile phrase matches any collab system.
    const matchesCollab = Array.from(collabSystems).some((sys) =>
      profilePhrase.includes(sys)
    );
    if (!matchesCollab) continue;
    // Check whether collaborative qualifier appears within ~50 chars of the
    // match in the Profile. If yes, the Profile is acknowledging — pass.
    const matchStart = buildMatch.index;
    const windowEnd = Math.min(summaryLower.length, matchStart + buildMatch[0].length + 60);
    const windowText = summaryLower.slice(matchStart, windowEnd);
    const hasQualifier =
      /\bco[-\s](?:designed|built|created|developed)/.test(windowText) ||
      /\b(?:with|alongside)\s+(?:the\s+)?(?:director|founder|team|co-founder|colleague|company\s+\w+)/.test(
        windowText
      ) ||
      /\bhelped\s+(?:design|build|create|develop)/.test(windowText) ||
      /\bjointly/.test(windowText);
    if (hasQualifier) continue;

    hits.push({
      section: "Profile",
      phrase: `Profile says "${buildMatch[0].trim()}" but the FactBase attributes this work COLLABORATIVELY ("co-designed", "with the director", "alongside", etc.). Dropping the co-attribution to make the claim sound stronger is a Truth Contract violation. Restate as "Co-designed [system] with [collaborator]" / "Designed [system] alongside [collaborator]" / "Built [system] with [collaborator]" — match the FactBase's actual attribution.`,
    });
    break; // One flag per scan run is enough; fixing one usually reveals patterns.
  }
  return hits;
}

// ── Career-changer scanners (called conditionally when career-changer mode
// is active — i.e. targetRoleFamily is set AND factbaseFitForFamily is
// "transferable" or "minimal"). These enforce the structural mandates of a
// career-changer Profile that the prompt-only rules can't reliably hold.

// Pivot signals — explicit career-change language. S1 must contain ONE of
// these patterns for a career-changer Profile to read as such; otherwise
// the recruiter sees a confident-current-domain Profile and assumes the
// application is confused.
const PIVOT_SIGNAL_PATTERNS = [
  /\bpivoting\s+(?:to|into|toward)\b/i,
  /\bmoving\s+(?:to|into|toward)\b/i,
  /\btransitioning\s+(?:to|into|toward)\b/i,
  /\bcareer[-\s]chang(?:ing|er|e)\b/i,
  /\bapplying\b[^.]{0,60}\bto\s+(?:a\s+)?(?:role\s+in|career\s+in)\b/i,
  /\bcrossing\s+(?:to|into)\b/i,
  /\brepositioning\b/i,
  /\bshift(?:ing|ed)\s+(?:to|into|toward)\b/i,
  /\bretrain(?:ing|ed)\s+(?:as|into|for)\b/i,
  /\bre[-\s]trained?\s+(?:as|into|for)\b/i,
  /\bbridge\s+(?:to|into)\b/i,
  /\bnext\s+step\s+(?:is|toward)\b/i,
  /\bbringing\s+\w+(?:\s+\w+){0,5}\s+(?:to|into)\s+(?:a\s+)?\w+\s+(?:career|role|practice)\b/i,
];

export function scanProfileCareerChangerPivotSignal(
  cv: TailoredCV,
  targetRoleFamily: string
): BannedHit[] {
  const hits: BannedHit[] = [];
  if (!cv.summary || !targetRoleFamily.trim()) return hits;
  const sentences = splitSentences(cv.summary);
  if (sentences.length === 0) return hits;
  const s1 = sentences[0];
  const hasPivotSignal = PIVOT_SIGNAL_PATTERNS.some((re) => re.test(s1));
  if (!hasPivotSignal) {
    hits.push({
      section: "Profile",
      phrase: `S1 lacks an explicit pivot signal — career-changer Profile for ${targetRoleFamily} requires S1 to make the pivot UNMISTAKABLE within the first sentence. Insert one of these patterns directly: "Supply Chain Analyst pivoting to ${targetRoleFamily}", "Marketing Manager moving into ${targetRoleFamily}", "Project Coordinator transitioning to ${targetRoleFamily}", "career-changing into ${targetRoleFamily} from current role". Without this signal in S1, the recruiter reads the Profile as confident-in-current-domain and misreads the application as a confused one.`,
    });
  }
  return hits;
}

// Family-bridge synonyms — when career-changer S2 doesn't contain the
// literal target family word, these natural alternatives also count as a
// valid bridge. Prevents false positives when the model uses a clearly-
// related concept rather than the family name itself.
const FAMILY_BRIDGE_SYNONYMS: Record<string, string[]> = {
  legal: [
    "law", "legal", "compliance", "regulatory", "contract", "contractual",
    "litigation", "advisory", "paralegal", "solicitor", "barrister",
  ],
  data: [
    "data", "analytical", "analytics", "modelling", "modeling",
    "quantitative", "statistical", "dashboard", "insight", "reporting",
  ],
  consulting: [
    "consulting", "advisory", "strategy", "strategic", "client",
    "engagement", "hypothesis", "structured analysis",
  ],
  finance: [
    "finance", "financial", "accounting", "treasury", "audit",
    "FP&A", "controls",
  ],
  banking: [
    "banking", "M&A", "capital markets", "deal", "pitch", "client-coverage",
    "investment banking",
  ],
  marketing: [
    "marketing", "brand", "content", "campaign", "growth", "paid media",
    "creative",
  ],
  sales: [
    "sales", "BD", "business development", "pipeline", "quota", "account",
    "named account",
  ],
  product: [
    "product", "roadmap", "GTM", "launch", "user research", "feature",
    "discovery",
  ],
  engineering: [
    "engineering", "software", "development", "code", "deploy", "ship",
    "platform",
  ],
  property: [
    "property", "real estate", "surveying", "valuation", "asset", "lettings",
    "agency",
  ],
  procurement: [
    "procurement", "sourcing", "vendor", "supplier", "category", "spend",
  ],
  supply: [
    "supply chain", "demand planning", "logistics", "inventory", "S&OP",
  ],
  hr: [
    "HR", "people", "talent", "L&D", "HRBP", "comp", "benefits",
  ],
  healthcare: [
    "healthcare", "clinical", "medical", "nursing", "patient", "NHS",
  ],
  education: [
    "education", "teaching", "curriculum", "pastoral", "academic",
  ],
  hospitality: [
    "hospitality", "travel", "restaurant", "covers", "guest experience",
  ],
};

function checkFamilyBridge(s2Lower: string, family: string): boolean {
  const familyLower = family.toLowerCase().trim();
  // First check direct match — split family by spaces / slashes / etc. and
  // see if any meaningful word appears in S2.
  const familyWords = familyLower
    .split(/[\s/&,()-]+/)
    .filter((w) => w.length >= 4);
  if (familyWords.some((w) => s2Lower.includes(w))) return true;
  // Fall back to synonym mapping for common families.
  for (const [key, synonyms] of Object.entries(FAMILY_BRIDGE_SYNONYMS)) {
    if (familyLower.includes(key)) {
      if (synonyms.some((syn) => s2Lower.includes(syn.toLowerCase()))) {
        return true;
      }
    }
  }
  return false;
}

export function scanProfileCareerChangerS2Bridge(
  cv: TailoredCV,
  targetRoleFamily: string
): BannedHit[] {
  const hits: BannedHit[] = [];
  if (!cv.summary || !targetRoleFamily.trim()) return hits;
  const sentences = splitSentences(cv.summary);
  if (sentences.length < 2) return hits;
  const s2Lower = sentences[1].toLowerCase();
  if (!checkFamilyBridge(s2Lower, targetRoleFamily)) {
    hits.push({
      section: "Profile",
      phrase: `S2 does not bridge to ${targetRoleFamily}. Career-changer Profile S2 must include an explicit clause connecting current work to the target family. S2 currently reads as pure current-domain operational claim with NO mention of ${targetRoleFamily} or any clearly-related concept. Add a clause that names ${targetRoleFamily} or a closely-related concept (for Legal: contract review, liability, compliance, regulatory; for Data: analytical reporting, dashboards, modelling). Frame the bridge as concrete work the candidate does, in natural English. Do NOT use tagline phrasings like "the operational counterpart of X practice" — these read as model-tells.`,
    });
  }
  return hits;
}

export function scanProfileCareerChangerNamedTarget(
  cv: TailoredCV,
  targetRoleFamily: string
): BannedHit[] {
  const hits: BannedHit[] = [];
  if (!cv.summary || !targetRoleFamily.trim()) return hits;
  const sentences = splitSentences(cv.summary);
  if (sentences.length === 0) return hits;
  const last = sentences[sentences.length - 1];
  const hasNamedTarget =
    /\b(?:targeting|target\s+role|aiming\s+(?:for|at)|positioned\s+for|seeking\s+(?:a|an)|moving\s+toward|en\s+route\s+to|en[-\s]route\s+(?:to|into)|pursuing\s+(?:a|an)\s+role)\b/i.test(
      last
    );
  if (!hasNamedTarget) {
    hits.push({
      section: "Profile",
      phrase: `Career-changer S4 lacks a named-target close. The closing sentence must contain an explicit named target after the degree details — e.g. "Targeting a graduate paralegal role" / "Targeting an SQE-route training contract" / "Targeting a junior analyst role in commercial ${targetRoleFamily}". Without this, S4 reads as a sector-agnostic close, not a career-change close, and the pivot intent fades at the end of the Profile.`,
    });
  }
  return hits;
}

// Composite — call only when career-changer mode is active.
export function scanProfileCareerChangerMode(
  cv: TailoredCV,
  targetRoleFamily: string
): BannedHit[] {
  return [
    ...scanProfileCareerChangerPivotSignal(cv, targetRoleFamily),
    ...scanProfileCareerChangerS2Bridge(cv, targetRoleFamily),
    ...scanProfileCareerChangerNamedTarget(cv, targetRoleFamily),
  ];
}

// ══════════════════════════════════════════════════════════════════════════════
// SKILLS SECTION SCANNERS (Phase 2 build — evidence-based, 25-source research)
// ══════════════════════════════════════════════════════════════════════════════
//
// These enforce the rules that 2025-2026 ATS parser tests + recruiter eye-
// tracking studies + the 15K-application callback study established:
//   - Single-token / short-phrase items (Workday classifier weighting)
//   - No standalone soft skills (76% of CVs list "Communication" — recruiters
//     discount; Workday's classifier drops multi-word soft-skill phrases)
//   - Tool-specificity required ("Excel" alone is dead since 2024)
//   - 8-20 items, 3-5 categories when >12 items, 3-7 per category
//   - Banned buzzword filler
//
// The Profile-section scanners use cv.summary; these use cv.skills (array of
// { category, items[] }).

// Banned generic-competency items — soft skills as standalone Skills-section
// entries. The Workday classifier explicitly drops multi-word soft-skill
// phrases. Recruiters discount unsubstantiated soft-skill nouns. Soft skills
// belong in experience bullets where evidence supports them, NOT as standalone
// items in the Skills section.
//
// Match is case-insensitive, full-item match (the item BY ITSELF in any of
// these forms triggers; partial matches like "stakeholder management" stay
// allowed because they pair the soft skill with a concrete domain noun).
const SKILLS_BANNED_STANDALONE_SOFT_SKILLS = [
  // Communication family
  /^communication(?:\s+skills?)?$/i,
  /^(?:strong|excellent|effective|professional)\s+communication$/i,
  /^written\s+communication$/i,
  /^verbal\s+communication$/i,
  /^interpersonal(?:\s+skills?)?$/i,

  // Teamwork family
  /^teamwork$/i,
  /^team\s+player$/i,
  /^collaborative$/i,
  /^team\s+working$/i,

  // Problem-solving / critical-thinking
  /^problem[-\s]solving$/i,
  /^problem[-\s]solver$/i,
  /^critical\s+thinking$/i,
  /^analytical\s+thinking$/i, // when standalone — paired with domain is OK

  // Leadership
  /^leadership(?:\s+skills?)?$/i,
  /^strong\s+leader(?:ship)?$/i,
  /^natural\s+leader$/i,

  // Detail / organisation
  /^detail[-\s]oriented$/i,
  /^attention\s+to\s+detail$/i,
  /^(?:highly\s+)?organised$/i,
  /^(?:highly\s+)?organized$/i,
  /^time\s+management$/i,
  /^multi[-\s]tasking$/i,
  /^multitasking$/i,

  // Self-driven family
  /^self[-\s]starter$/i,
  /^self[-\s]motivated$/i,
  /^self[-\s]driven$/i,
  /^hard[-\s]working$/i,
  /^hardworking$/i,
  /^dedicated$/i,

  // Passion / motivation
  /^passionate$/i,
  /^driven$/i,
  /^motivated$/i,
  /^enthusiastic$/i,

  // Results / goal
  /^results[-\s]driven$/i,
  /^results[-\s]oriented$/i,
  /^goal[-\s]oriented$/i,
  /^outcome[-\s]oriented$/i,

  // Adaptability
  /^adaptable$/i,
  /^flexible$/i,
  /^resilient$/i,

  // Strategic-thinking (standalone — domain-paired forms like "Strategic
  // procurement" stay allowed because they anchor to a domain noun)
  /^strategic\s+thinking$/i,
  /^strategic\s+mindset$/i,
  /^strategic\s+vision$/i,

  // Generic "soft skills" categories some CVs literally list
  /^soft\s+skills$/i,
  /^transferable\s+skills$/i,
];

export function scanSkillsBannedStandaloneSoftSkills(cv: TailoredCV): BannedHit[] {
  const hits: BannedHit[] = [];
  if (!cv.skills) return hits;
  for (const group of cv.skills) {
    for (const item of group.items) {
      const trimmed = item.trim();
      if (!trimmed) continue;
      for (const re of SKILLS_BANNED_STANDALONE_SOFT_SKILLS) {
        if (re.test(trimmed)) {
          hits.push({
            section: `Key Skills: ${group.category}`,
            phrase: `Skills item "${trimmed}" is a standalone soft-skill that recruiters discount + Workday's classifier drops. 76% of CVs list this — listing makes the candidate AVERAGE, not differentiated. DELETE this item from the Skills section. Soft skills belong in experience bullets where the FactBase shows evidence (e.g. "Led cross-functional weekly stand-ups…" demonstrates communication + leadership without listing them as nouns).`,
          });
          break;
        }
      }
    }
  }
  return hits;
}

// Bare-tool detection. The bar since 2024: tools must be paired with feature
// or use specificity. "Excel" alone is dead. Forces "Excel (PivotTables,
// Power Query, advanced formulas)" or similar expansion.
const SKILLS_BARE_TOOL_PATTERNS = [
  // Microsoft family bare names
  /^(?:microsoft\s+)?excel$/i,
  /^microsoft\s+office(?:\s+suite)?$/i,
  /^ms\s+office$/i,
  /^office\s+365$/i,
  /^outlook$/i,
  /^word$/i,
  /^powerpoint$/i,
  // Google bare
  /^google\s+(?:suite|workspace|docs|sheets)$/i,
  // Programming language bare
  /^programming$/i,
  /^coding$/i,
  /^scripting$/i,
  // Generic system categories
  /^erp(?:\s+systems?)?$/i,
  /^crm(?:\s+systems?)?$/i,
  /^database(?:s)?$/i,
  /^data\s+(?:tools?|software)$/i,
  /^statistical\s+software$/i,
  /^analytics\s+(?:tools?|software)$/i,
  /^bi\s+tools?$/i,
];

export function scanSkillsBareTools(cv: TailoredCV): BannedHit[] {
  const hits: BannedHit[] = [];
  if (!cv.skills) return hits;
  for (const group of cv.skills) {
    for (const item of group.items) {
      const trimmed = item.trim();
      if (!trimmed) continue;
      for (const re of SKILLS_BARE_TOOL_PATTERNS) {
        if (re.test(trimmed)) {
          hits.push({
            section: `Key Skills: ${group.category}`,
            phrase: `Skills item "${trimmed}" is a bare tool name without feature / use specificity — this is the dead-since-2024 CV register. Expand to name the actual features / methods the candidate uses. Examples: "Excel" → "Excel (PivotTables, Power Query, advanced formulas)"; "Microsoft Office" → list specific apps with features; "ERP Systems" → name the actual system ("SAP IBP", "Oracle SCM", "Airtable ERP"); "Programming" → name the languages ("Python (pandas, scikit-learn)"). Bare tool names fail BOTH ATS keyword matching AND recruiter credibility.`,
          });
          break;
        }
      }
    }
  }
  return hits;
}

// Item format scanner. Items must be 1-6 words. No sentences. No explanations.
// The Skills section is keyword density, not prose.
export function scanSkillsItemFormat(cv: TailoredCV): BannedHit[] {
  const hits: BannedHit[] = [];
  if (!cv.skills) return hits;
  for (const group of cv.skills) {
    for (const item of group.items) {
      const trimmed = item.trim();
      if (!trimmed) continue;
      // Count words OUTSIDE parenthetical content (because "Excel (PivotTables,
      // Power Query, advanced formulas)" is a legitimate compound item and we
      // don't want to count the parenthetical's words against the main item).
      const outsideParens = trimmed.replace(/\([^)]*\)/g, "").trim();
      const wordCount = outsideParens.split(/\s+/).filter(Boolean).length;
      if (wordCount > 6) {
        hits.push({
          section: `Key Skills: ${group.category}`,
          phrase: `Skills item "${trimmed}" is too long (${wordCount} words outside parens; max 6). Skills items must be concise noun phrases — keyword density, not prose. Split or shorten. If the item is multi-claim, break into multiple items. If it's a sentence/explanation, move that content to an experience bullet.`,
        });
        continue;
      }
      // Detect full sentences masquerading as Skills items (contains period
      // not at the end, OR ends with period + capital after).
      if (
        /\.\s+[A-Z]/.test(trimmed) ||
        (/[.!?]$/.test(trimmed) && /\s/.test(trimmed) && wordCount > 3)
      ) {
        hits.push({
          section: `Key Skills: ${group.category}`,
          phrase: `Skills item "${trimmed}" appears to contain a sentence — Skills items must be noun phrases only, never sentences. Move the explanation to an experience bullet.`,
        });
      }
    }
  }
  return hits;
}

// Skills total count scanner. <8 items reads thin, >20 reads as padding.
export function scanSkillsTotalCount(cv: TailoredCV): BannedHit[] {
  const hits: BannedHit[] = [];
  if (!cv.skills) return hits;
  const total = cv.skills.reduce((sum, g) => sum + (g.items?.length ?? 0), 0);
  if (total < 8) {
    hits.push({
      section: "Key Skills",
      phrase: `Skills section has only ${total} total items — minimum is 8. Thin Skills sections fail ATS keyword density + recruiter credibility checks. Add more skills from the FactBase (work history bullets, achievements, persisted user_skills). If the FactBase truly only supports <8 items, the candidate needs more evidence captured — flag this as a gap to surface in the audit modal.`,
    });
  } else if (total > 20) {
    hits.push({
      section: "Key Skills",
      phrase: `Skills section has ${total} total items — maximum is 20. >20 items reads as padding / keyword-stuffing and triggers modern ATS stuffing penalties. Cut the least JD-relevant items. Prefer ${cv.skills?.length ?? 0} fewer high-quality items over more filler.`,
    });
  }
  return hits;
}

// Category-count scanner. Below ~12 items, flat (1 category) outperforms
// categorisation per parser-test research. Above 12, categorisation is
// mandatory (3-5 categories). Above 5 categories = noise.
export function scanSkillsCategoryCount(cv: TailoredCV): BannedHit[] {
  const hits: BannedHit[] = [];
  if (!cv.skills) return hits;
  const total = cv.skills.reduce((sum, g) => sum + (g.items?.length ?? 0), 0);
  const categoryCount = cv.skills.length;

  // Flat (1 category) allowed when total ≤12. Categorised (3-5) when >12.
  // 2 categories awkward; either flatten to 1 or expand to 3.
  if (total > 12 && categoryCount < 3) {
    hits.push({
      section: "Key Skills",
      phrase: `Skills section has ${total} items but only ${categoryCount} ${categoryCount === 1 ? "category" : "categories"} — when item count exceeds 12, categorisation into 3-5 distinct categories becomes mandatory (parser-test research: >12 items in one block reads as wall-of-text and recruiters skip past). Split into 3-5 concrete domain categories.`,
    });
  }
  if (total <= 12 && categoryCount > 2) {
    hits.push({
      section: "Key Skills",
      phrase: `Skills section has ${total} items split across ${categoryCount} categories — research shows categorisation only adds value above ~12 items. Below 12, a flat single category ("Key Skills" or domain-named) outperforms categorisation on ATS parsing + recruiter scan. Consider flattening to 1 category, OR adding more items to justify the categorisation.`,
    });
  }
  if (categoryCount > 5) {
    hits.push({
      section: "Key Skills",
      phrase: `Skills section has ${categoryCount} categories — maximum is 5. >5 categories becomes visual noise and recruiters can't navigate. Merge similar categories.`,
    });
  }
  // Generic catch-all categories ("Skills", "Other", "Miscellaneous").
  const bannedCategoryNames = [
    /^skills$/i,
    /^other$/i,
    /^miscellaneous$/i,
    /^additional\s+skills$/i,
    /^additional$/i,
    /^misc$/i,
  ];
  for (const group of cv.skills) {
    if (bannedCategoryNames.some((re) => re.test(group.category.trim()))) {
      hits.push({
        section: "Key Skills",
        phrase: `Category name "${group.category}" is a generic catch-all — banned. Categories must be concrete and domain-fit (e.g. "Tools & Systems", "Supply Chain & Procurement", "Methods & Frameworks"). Rename or merge into another category.`,
      });
    }
  }
  return hits;
}

// Items-per-category scanner. 3-7 per category optimal.
export function scanSkillsItemsPerCategory(cv: TailoredCV): BannedHit[] {
  const hits: BannedHit[] = [];
  if (!cv.skills) return hits;
  // Only flag per-category counts when the Skills section is categorised
  // (>1 category). A single flat category can hold more items.
  if (cv.skills.length <= 1) return hits;
  for (const group of cv.skills) {
    const count = group.items?.length ?? 0;
    if (count < 3) {
      hits.push({
        section: `Key Skills: ${group.category}`,
        phrase: `Category "${group.category}" has only ${count} ${count === 1 ? "item" : "items"} — minimum 3. Thin categories look unprofessional and waste real estate. Either add items (from FactBase / work history bullets) or merge this category into another.`,
      });
    } else if (count > 7) {
      hits.push({
        section: `Key Skills: ${group.category}`,
        phrase: `Category "${group.category}" has ${count} items — maximum 7. Walls of items defeat the purpose of categorisation. Cut the least JD-relevant items, or split into two distinct categories.`,
      });
    }
  }
  return hits;
}

// ── Round 3 Skills scanners ────────────────────────────────────────────────
//
// Built 2026-05-25 in response to Tom's JLR audit. The five-scanner pack
// catches the patterns Round 1 missed:
//   - Items in the wrong category (MRP in Tools; Process improvement in
//     Stakeholder)
//   - Cross-category duplicates
//   - Semantic-equivalent duplicates (Material planning + MRP)
//   - Buzzword filler inside items
//   - Acronym-without-spelled-form

// Patterns that identify an item as a METHODOLOGY / framework / approach.
// Used by scanSkillsCategoryFit to detect items mis-placed in TOOL
// categories.
const METHODOLOGY_INDICATORS = [
  // Named methods + frameworks (case-insensitive substring within item)
  /\blean(?:\s+(?:manufacturing|six\s+sigma|management))?\b/i,
  /\bagile\b/i,
  /\bscrum\b/i,
  /\bkanban\b/i,
  /\bsix\s+sigma\b/i,
  /\bkaizen\b/i,
  /\bdmaic\b/i,
  /\b5s\b/i,
  /\bfmea\b/i,
  /\bpdca\b/i,
  /\bracile?\b/i,
  /\brice\b/i,
  /\bmoscow\b/i,
  /\bjit\b/i, // just-in-time
  /\bjust[-\s]in[-\s]time\b/i,
  /\bcontinuous\s+improvement\b/i,
  /\bprocess\s+improvement\b/i,
  /\broot[-\s]cause\s+analysis\b/i,
  /\b(?:gap|swot|pestle?|porters?)\s+analysis\b/i,
  /\bs[&]op\b/i,
  /\bsales\s+(?:and|&)\s+operations\s+planning\b/i,
  /\bmrp\b/i,
  /\bmaterial\s+requirements?\s+planning\b/i,
  /\botif\b/i,
  /\bon[-\s]time[-\s](?:in|and)[-\s]full\b/i,
  /\betl\b/i,
  /\bbpm[n]?\b/i,
  /\bfp&a\b/i,
  // Common methodology phrases
  /\b\w+\s+methodology\b/i,
  /\b\w+\s+framework(?:s)?\b/i,
  /\b\w+\s+approach\b/i,
];

// Patterns that identify an item as a TOOL / platform / system.
const TOOL_INDICATORS = [
  // Common named tools (extend as needed)
  /\bexcel\b/i,
  /\bword\b/i,
  /\bpowerpoint\b/i,
  /\boutlook\b/i,
  /\bsharepoint\b/i,
  /\bteams\b/i,
  /\bsap\b/i,
  /\boracle\b/i,
  /\btableau\b/i,
  /\bpower\s+bi\b/i,
  /\blooker\b/i,
  /\bqlik\b/i,
  /\bsalesforce\b/i,
  /\bhubspot\b/i,
  /\bjira\b/i,
  /\bconfluence\b/i,
  /\btrello\b/i,
  /\basana\b/i,
  /\bslack\b/i,
  /\bnotion\b/i,
  /\bairtable\b/i,
  /\bfigma\b/i,
  /\bsketch\b/i,
  /\badobe\b/i,
  /\bgit(?:hub|lab)?\b/i,
  /\baws\b/i,
  /\bazure\b/i,
  /\bgcp\b/i,
  /\bsnowflake\b/i,
  /\bdatabricks\b/i,
  /\bmongodb\b/i,
  /\bpostgres(?:ql)?\b/i,
  /\bmysql\b/i,
  /\bpython\b/i,
  /\bjava(?:script)?\b/i,
  /\btypescript\b/i,
  /\bnode\.?js\b/i,
  /\breact\b/i,
  /\bnext\.?js\b/i,
  /\bchatgpt\b/i,
  /\bclaude\b/i,
  /\bgemini\b/i,
  /\bvapi\b/i,
  /\blexisnexis\b/i,
  /\bpractical\s+law\b/i,
  /\bwestlaw\b/i,
  /\brelativity\b/i,
  /\bimanage\b/i,
  /\bhighq\b/i,
  /\bcontractpodai\b/i,
  // Generic tool patterns: items with parenthetical feature lists
  /\([^)]+\)/, // any item with parentheses (likely tool features)
  // "X CRM" / "X ERP" / "X system" patterns
  /\b\w+\s+(?:crm|erp|system|platform|software|suite|tooling)\b/i,
];

function classifyItem(item: string): "tool" | "methodology" | "other" {
  const t = item.trim().toLowerCase();
  if (!t) return "other";
  // Check methodology first because some items match both (e.g. "MRP" is a
  // methodology even though it sometimes appears in Tools categories).
  for (const re of METHODOLOGY_INDICATORS) {
    if (re.test(t)) return "methodology";
  }
  for (const re of TOOL_INDICATORS) {
    if (re.test(t)) return "tool";
  }
  return "other";
}

function classifyCategory(
  category: string
): "tools" | "methods" | "stakeholder" | "domain" | "sector" | "ambiguous" {
  const c = category.trim().toLowerCase();
  if (
    /\b(?:tools?|systems?|software|platforms?|applications?|suites?)\b/.test(c)
  ) {
    return "tools";
  }
  if (
    /\b(?:methods?|frameworks?|methodolog(?:y|ies)|approaches?|techniques?|processes)\b/.test(
      c
    )
  ) {
    return "methods";
  }
  if (
    /\b(?:stakeholders?|communication|people|leadership|management|reporting)\b/.test(
      c
    )
  ) {
    return "stakeholder";
  }
  if (
    /\b(?:domain|functional|capabilit(?:y|ies)|expertise|skills?)\b/.test(c)
  ) {
    return "domain";
  }
  if (/\b(?:sector|industr(?:y|ies))\b/.test(c)) {
    return "sector";
  }
  return "ambiguous";
}

// 7. SKILLS CATEGORY FIT — flags items that have been placed in the wrong
// category type. Catches:
//   - Methodologies (MRP, Process improvement, Lean, S&OP) inside a "Tools"
//     category
//   - Named tools (Excel, SAP, Tableau) inside a "Methods" category
//   - Stakeholder/communication items inside Tools/Methods/Sector categories
//
// Conservative: only flags clear mismatches. Items classified as "other"
// (ambiguous domain items like "Demand forecasting") pass through.
export function scanSkillsCategoryFit(cv: TailoredCV): BannedHit[] {
  const hits: BannedHit[] = [];
  if (!cv.skills) return hits;
  for (const group of cv.skills) {
    const catType = classifyCategory(group.category);
    if (catType === "ambiguous" || catType === "domain") {
      // Domain / ambiguous categories accept mixed content — skip.
      continue;
    }
    for (const item of group.items) {
      const itemType = classifyItem(item);
      // Methodology item in Tools category → flag.
      if (itemType === "methodology" && catType === "tools") {
        hits.push({
          section: `Key Skills: ${group.category}`,
          phrase: `Item "${item}" is a methodology / framework, not a tool. It's in the "${group.category}" category which is for named tools / platforms / software. Move it to a Methods / Frameworks category, OR rename the category to something domain-fitting that legitimately holds both (e.g. "Supply Chain & Procurement" can hold both MRP as a method AND SAP as a tool — but "Systems & Tools" strictly should be named tools).`,
        });
      }
      // Tool item in Methods category → flag.
      if (itemType === "tool" && catType === "methods") {
        hits.push({
          section: `Key Skills: ${group.category}`,
          phrase: `Item "${item}" is a named tool / platform, not a methodology. It's in the "${group.category}" category which is for methods / frameworks / approaches. Move to Tools & Systems category.`,
        });
      }
      // Methodology item in Stakeholder/Sector → flag (rarely fits).
      if (
        itemType === "methodology" &&
        (catType === "stakeholder" || catType === "sector")
      ) {
        hits.push({
          section: `Key Skills: ${group.category}`,
          phrase: `Item "${item}" is a methodology — it doesn't belong in the "${group.category}" category. Move to Methods / Frameworks, or to a domain-fitting category. e.g. "Process improvement" reads as a method, NOT a stakeholder/management skill.`,
        });
      }
    }
  }
  return hits;
}

// 8. CROSS-CATEGORY DUPLICATES — same item appears in two or more
// categories. Wastes Skills budget + reads as careless.
export function scanSkillsDuplicates(cv: TailoredCV): BannedHit[] {
  const hits: BannedHit[] = [];
  if (!cv.skills) return hits;
  // Build map of normalised-item → [categories where it appears]
  const itemToCategories = new Map<string, string[]>();
  for (const group of cv.skills) {
    for (const item of group.items) {
      const key = item.trim().toLowerCase();
      if (!key) continue;
      const existing = itemToCategories.get(key) ?? [];
      existing.push(group.category);
      itemToCategories.set(key, existing);
    }
  }
  for (const [key, categories] of itemToCategories) {
    if (categories.length > 1) {
      hits.push({
        section: "Key Skills",
        phrase: `Item "${key}" appears in ${categories.length} categories (${categories.join(", ")}). Pick ONE category and remove from the others. Duplicates waste Skills budget + signal careless authoring.`,
      });
    }
  }
  return hits;
}

// 9. SEMANTIC OVERLAP — items that mean the same thing under different
// names. e.g. "Material planning" + "Material Requirements Planning (MRP)" =
// same concept. "Excel" + "Excel (PivotTables...)" = same tool. Detected by
// stripping parenthetical content, articles, and "management" suffix, then
// checking for substring overlap of the main noun phrase.
export function scanSkillsOverlap(cv: TailoredCV): BannedHit[] {
  const hits: BannedHit[] = [];
  if (!cv.skills) return hits;
  // Collect all (normalised, original, category) triples.
  const normalise = (s: string) => {
    return s
      .toLowerCase()
      // Strip parenthetical content + acronym short-forms.
      .replace(/\([^)]*\)/g, "")
      // Strip leading articles + trailing generic suffixes.
      .replace(/^\s*(?:the|a|an)\s+/, "")
      .replace(/\s+(?:management|skills?|expertise|knowledge)\s*$/, "")
      .trim();
  };
  const items: Array<{ normalised: string; original: string; category: string }> = [];
  for (const group of cv.skills) {
    for (const item of group.items) {
      const norm = normalise(item);
      if (norm.length < 3) continue;
      items.push({ normalised: norm, original: item, category: group.category });
    }
  }
  // For each pair, check if one's normalised form is contained in the other's.
  const flagged = new Set<string>();
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i];
      const b = items[j];
      if (a.normalised === b.normalised) {
        const pairKey = [a.original, b.original].sort().join("|");
        if (flagged.has(pairKey)) continue;
        flagged.add(pairKey);
        hits.push({
          section: "Key Skills",
          phrase: `Items "${a.original}" (in "${a.category}") and "${b.original}" (in "${b.category}") are the same concept under different names. Merge into ONE item, or drop one. e.g. "Material planning" + "Material Requirements Planning (MRP)" → keep MRP only.`,
        });
        continue;
      }
      // Check if the shorter one is contained inside the longer one — true
      // overlap (e.g. "Excel" inside "Excel (PivotTables, Power Query)").
      const shorter = a.normalised.length <= b.normalised.length ? a : b;
      const longer = a.normalised.length > b.normalised.length ? a : b;
      if (
        shorter.normalised.length >= 4 &&
        longer.normalised.split(/\s+/).includes(shorter.normalised)
      ) {
        const pairKey = [a.original, b.original].sort().join("|");
        if (flagged.has(pairKey)) continue;
        flagged.add(pairKey);
        hits.push({
          section: "Key Skills",
          phrase: `Items "${shorter.original}" (in "${shorter.category}") and "${longer.original}" (in "${longer.category}") overlap — "${shorter.original}" is a subset of "${longer.original}". Drop the bare form; the specific form (with features / acronym) wins.`,
        });
      }
    }
  }
  return hits;
}

// 10. BUZZWORDS IN SKILLS ITEMS — buzzword filler ("synergy", "dynamic",
// "world-class") anywhere inside a Skills item. Buzzwords waste recruiter
// attention and trigger AI-tell flags.
const SKILLS_BUZZWORD_PATTERNS = [
  /\bsynerg(?:y|ies|istic|ise|ize)\b/i,
  /\bdynamic\b/i,
  /\bholistic\b/i,
  /\bcutting[-\s]edge\b/i,
  /\bstate[-\s]of[-\s]the[-\s]art\b/i,
  /\bworld[-\s]class\b/i,
  /\bbest[-\s]in[-\s]class\b/i,
  /\brobust\b/i,
  /\bseamless\b/i,
  /\binnovative\b/i,
  /\boperational\s+excellence\b/i,
  /\bbest\s+practice(?:s)?\b/i,
  /\bvalue[-\s]add\b/i,
];

export function scanSkillsBuzzwords(cv: TailoredCV): BannedHit[] {
  const hits: BannedHit[] = [];
  if (!cv.skills) return hits;
  for (const group of cv.skills) {
    for (const item of group.items) {
      for (const re of SKILLS_BUZZWORD_PATTERNS) {
        if (re.test(item)) {
          hits.push({
            section: `Key Skills: ${group.category}`,
            phrase: `Skills item "${item}" contains buzzword filler ("synergy", "dynamic", "world-class", etc.). Buzzwords waste recruiter attention + trigger AI-tell flags. Rewrite to drop the buzzword OR remove the item.`,
          });
          break;
        }
      }
    }
  }
  return hits;
}

// 11. ACRONYM NORMALISATION — common acronyms (S&OP, MRP, ERP, CRM, OTIF,
// FP&A, etc.) should appear WITH their spelled-out form on first mention in
// Skills section (Workday + Lever ATS both win when both forms are present).
// Catches bare-acronym items missing the spelled form.
const ACRONYM_SPELLED_PAIRS: Array<[RegExp, string]> = [
  [/\bs[&]op\b/i, "Sales & Operations Planning"],
  [/\bmrp\b/i, "Material Requirements Planning"],
  [/\berp\b/i, "Enterprise Resource Planning"],
  [/\bcrm\b/i, "Customer Relationship Management"],
  [/\botif\b/i, "On Time In Full"],
  [/\bfp&a\b/i, "Financial Planning & Analysis"],
  [/\bbpm[n]?\b/i, "Business Process Management"],
  [/\betl\b/i, "Extract Transform Load"],
  [/\bkpi(?:s)?\b/i, "Key Performance Indicators"],
];

export function scanSkillsAcronymNormalisation(cv: TailoredCV): BannedHit[] {
  const hits: BannedHit[] = [];
  if (!cv.skills) return hits;
  // Build a flat all-items string to test for spelled-form presence anywhere
  // in the Skills section.
  const allItemsFlat = cv.skills
    .flatMap((g) => g.items)
    .join(" | ")
    .toLowerCase();
  for (const group of cv.skills) {
    for (const item of group.items) {
      for (const [acronymRe, spelledForm] of ACRONYM_SPELLED_PAIRS) {
        if (!acronymRe.test(item)) continue;
        // Acronym appears in item. Check whether the spelled form appears
        // anywhere in the Skills section (the item itself OR another item).
        const spelledLower = spelledForm.toLowerCase();
        if (allItemsFlat.includes(spelledLower)) {
          continue; // both forms present
        }
        // Check whether the item ALREADY contains the spelled form inside
        // parens (e.g. "Material Requirements Planning (MRP)").
        if (item.toLowerCase().includes(spelledLower)) continue;
        // Spelled form missing — flag.
        hits.push({
          section: `Key Skills: ${group.category}`,
          phrase: `Skills item "${item}" uses a bare acronym without the spelled-out form. Workday + Lever ATS both win when BOTH forms appear: "${spelledForm} (${item.match(acronymRe)?.[0].toUpperCase() ?? ""})". Either expand this item OR ensure another item in the Skills section contains the spelled form.`,
        });
        break;
      }
    }
  }
  return hits;
}

// Composite — all 11 Skills scanners (6 from Round 1 + 5 from Round 3).
export function scanSkills(cv: TailoredCV): BannedHit[] {
  return [
    ...scanSkillsBannedStandaloneSoftSkills(cv),
    ...scanSkillsBareTools(cv),
    ...scanSkillsItemFormat(cv),
    ...scanSkillsTotalCount(cv),
    ...scanSkillsCategoryCount(cv),
    ...scanSkillsItemsPerCategory(cv),
    ...scanSkillsCategoryFit(cv),
    ...scanSkillsDuplicates(cv),
    ...scanSkillsOverlap(cv),
    ...scanSkillsBuzzwords(cv),
    ...scanSkillsAcronymNormalisation(cv),
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
      fix = "Tricolons (X, Y, and Z lists) are a Claude tell — the model loves them, recruiters skim past them. Pick the TWO STRONGEST items from the 3-item list and DROP the third entirely. Use 'X and Y' format with no third item. Do NOT replace with another tricolon (X, Y, and Z stays banned even with different items). Do NOT use a semicolon list (X; Y; Z) as a workaround — same Claude-tell shape.\n\nWorked examples:\n  BAD: 'covering delivery performance, liability and damaged stock' (tricolon)\n  GOOD: 'covering delivery performance and liability terms' (2 items)\n  GOOD: 'covering supplier liability and damaged-stock recovery' (2 items, different pick)\n\n  BAD: 'managing suppliers, contracts, and procurement risk' (tricolon)\n  GOOD: 'managing suppliers and procurement risk' (2 items)\n  GOOD: 'managing contracts across overseas suppliers' (restructured)\n\nThe scanner re-runs after your rewrite. If you produce another tricolon, the loop continues. Don't just shuffle the same three items — pick TWO and commit.";
    } else if (/third-person verb/i.test(what)) {
      fix = "Restart the sentence with either a gerund ('Owning…', 'Running…', 'Building…') or a noun-form ('Sole [role]', 'As the only person in the role…') — NEVER a verb ending in -s.";
    } else if (/first-person pronoun/i.test(what)) {
      fix = "Drop 'I/my/me' entirely. Lead with the action or role: 'Built X…' not 'I built X…'.";
    } else if (/sentence 2 contains no number/i.test(what)) {
      fix = "Lead Sentence 2 with the dominant scope anchor from the FactBase (e.g. '2x revenue growth', 'across 12 overseas suppliers', '£40M category'). The number is the centrepiece, not a clause.";
    } else if (/em-dash|en-dash|double-hyphen|space-hyphen-space/i.test(what)) {
      fix = "Replace EVERY em-dash (—), en-dash (–), double-hyphen (--), or space-hyphen-space ( - ) with a comma, period, or full restructure. The model has a strong bias toward em-dash for parentheticals — beat it explicitly. Worked examples:\n  BAD: 'Daily exposure to contracts — reviewing terms closely.'\n  GOOD (period): 'Daily exposure to contracts. Reviewing terms closely.'\n  GOOD (comma): 'Daily exposure to contracts, with close review of terms.'\n  GOOD (restructure): 'Daily contract exposure includes close term review.'\n\n  BAD: 'Scaled the function through 2x growth — managing wider supplier base.'\n  GOOD: 'Scaled the function through 2x growth, managing a wider supplier base.'\n\nNever substitute en-dash, double-hyphen, or space-hyphen-space — those are the same Claude tell wearing different clothes. The scanner catches them all.";
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
    } else if (/\babsorb(?:ing|ed|s)?\b/i.test(what)) {
      // Special-case "absorbing" — it's the model's go-to verb for scale-
      // plus-complexity claims ("Scaled X through Y growth, absorbing
      // higher PO volumes") and slips past six rewrite attempts because
      // generic "use a plain verb" guidance isn't concrete enough. Be
      // explicit about the restructuring options.
      fix = "The word 'absorbing' / 'absorbed' MUST NOT appear in the output. It is a CLAUDE-tell euphemism for 'managing'. Restructure the sentence in ONE of these ways:\n  (a) Replace with 'managing' — 'Scaled the function through 2x revenue growth, managing higher PO volumes across a wider supplier base'\n  (b) Replace with 'handling' — same shape\n  (c) DELETE the verb entirely — 'Scaled the function through 2x revenue growth across a wider supplier base, with higher PO volumes'\n  (d) Restructure around a different action from the FactBase — 'Scaled the function through 2x revenue growth, switching logistics partners after analysing courier performance data'\nPick whichever keeps the underlying claim intact. Do NOT submit another output containing 'absorbing' — the scanner will reject it.";
    } else if (/spearhead|leverage|orchestrate|champion|pioneer|drove|underpin/i.test(what)) {
      fix = "Replace the banned verb with a plain, concrete alternative: built, designed, ran, led, delivered, reduced, recovered, switched, negotiated.";
    } else if (/JD echo/i.test(what)) {
      fix = "Reword to use individual JD terms in your own factual statements; do NOT copy 4+ word phrases from the JD verbatim.";
    } else if (/contains no specific named item/i.test(what)) {
      fix = "Replace one abstract claim with a SPECIFIC named item from the FactBase: a built system (e.g. 'Airtable ERP', 'supplier scorecard'), a named brand from a previous role (e.g. 'Siemens DISW', 'Goldman Sachs'), a recovered £-amount, a named tool (e.g. 'Power BI'), or a named credential. The Profile must include at least ONE specific named anchor.";
    } else if (/S1 contains current employer name/i.test(what)) {
      fix = "Remove the current employer's name from sentence 1 entirely. The employer name lives in the Experience section. Replace 'X at [Employer]' with just 'X' (no employer mention) OR add a real scale/sector descriptor instead (e.g. 'at a £10M consumer-goods business' — only if you have a real scale signal).";
    } else if (/sector descriptor .* that carries NO scale or position signal/i.test(what)) {
      fix = "Delete the descriptor entirely. Lead S1 with role + work scope only — e.g. 'Supply Chain Analyst working across procurement and demand planning across an overseas supply base'. Do NOT replace one decorative descriptor with another. Only re-add a descriptor if you can attach a concrete £-figure, count, top-N rank, or named geographic market — and that signal must trace to the FactBase.";
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
    } else if (/structural hedge/i.test(what)) {
      fix = "Rewrite the sentence so the scope anchor IS the subject of the verb, not a temporal qualifier. NOT: 'Switched logistics partners during a period of 2x revenue growth'. YES: 'Scaled the supply chain through 2x revenue growth, switching logistics partners after analysing courier performance data'. The anchor leads, the action follows.";
    } else if (/jammed into one sentence|action verbs jammed/i.test(what)) {
      fix = "Rewrite the sentence to ONE main action only. Pick the strongest action verb and drop the others — including gerunds (building, switching, producing, analysing, reviewing, recovering, managing ALL count as actions). If you have a second high-value action, MOVE IT TO ITS OWN NEW SENTENCE (the Profile allows up to 5 sentences now). Don't try to cram both into one — that's the failure mode this rule catches.\n\nWorked example (BAD 28-word multi-action S4):\n  BAD: 'Co-designed a supplier performance system with the company director, recovering refunds on damaged stock through structured contract dispute work and switching logistics partners after identifying an underperforming provider.' (4 actions: Co-designed, recovering, switching, identifying)\n\nGOOD (split into two cleaner sentences):\n  GOOD S3: 'Co-designed an Airtable-based ERP system with the company director, recovering refunds on damaged stock during supplier disputes.' (2 actions, 17 words)\n  GOOD S4: 'Switched logistics partners after identifying an underperforming provider.' (1 action, 8 words)\n\nProfile body sentences carry ONE main claim each. The Profile is allowed 3-5 sentences total — use the budget. Stop jamming multiple distinct claims into one sentence.";
    } else if (/too long for a Profile body sentence/i.test(what)) {
      fix = "Cut the sentence to 12-22 words. If you're trying to fit scope-anchor + career-changer bridge + multiple actions into the same sentence and overflowing, SPLIT into two sentences (the Profile now allows up to 5). Career-changer S2 should typically be split into: sentence A = scope anchor with the work that delivered it (active verb), sentence B = the bridge clause naming target-family-relevant work (active verb). Both stay in S2 territory but as two short tight sentences instead of one bloated one. Don't try to keep everything in one sentence; the cap is non-negotiable.";
    } else if (/keyword-stuffing/i.test(what)) {
      fix = "Drop or rephrase the repeated phrase so it appears in ONE sentence only, not three. Pick the sentence where it lands hardest and remove it from the others. The Profile should read as varied, distinct evidence — not the same theme echoed across sentences.";
    } else if (/concept-level variant of the excluded phrase|near-paraphrases of/i.test(what)) {
      fix = "REMOVE the excluded concept entirely — not by paraphrasing, but by picking a DIFFERENT FactBase claim. The user has banned this underlying capability from appearing in any form. Don't swap one word and resubmit — pick another claim from the FactBase that doesn't touch the excluded concept.";
    } else if (/third-person -s\/-es verb/i.test(what)) {
      fix = "Restart the sentence with a gerund ('Producing structured performance reports…'), past-tense ('Produced structured performance reports…'), or noun-form ('Sole analyst producing…'). NEVER lead a Profile sentence with a verb ending in -s/-es — that reads as a recruiter talking ABOUT the candidate, not as the candidate.";
    } else if (/Brand name .* appears in \d+ sentences/i.test(what)) {
      fix = "Drop the second mention of the brand name. Brand-tier credibility lands once. Restructure the sentence to make the same point without re-anchoring to the brand — the action stands without it.";
    } else if (/self-contradiction.*sole-implying.*collaborative claim/i.test(what)) {
      fix = "Pick ONE attribution that matches the FactBase. If the candidate built the system alone → keep 'sole' / 'from scratch' / 'single-handedly' and DROP all collaborative language. If they collaborated → DROP 'sole' / 'from scratch' and use 'co-designed with [collaborator]' / 'jointly built with [X]' / 'designed alongside [Y]'. The two cannot coexist for the same item — pick the truthful framing the FactBase supports.";
    } else if (/Profile claims sole authorship.*FactBase contains COLLABORATIVE wording/i.test(what)) {
      fix = "REWRITE the sole-implying claim to match the FactBase's actual attribution. Drop 'Built X from scratch' / 'Sole builder of X' / 'single-handedly built X' and replace with the collaborative wording the FactBase uses: 'Co-designed X with [collaborator]', 'Built X alongside [collaborator]', or 'Designed X jointly with [collaborator]'. The Profile MUST mirror the FactBase's attribution — inflating shared work into solo authorship to make a claim sound stronger is a Truth Contract violation and will be caught by the recruiter if they reference-check.";
    } else if (/Profile body has NO quantified scope anchor/i.test(what)) {
      fix = "Add a quantified scope anchor from the FactBase to S2 or S3. Recruiters scan for ONE concrete number — Nx growth, £X recovered, N suppliers managed, N% delta. The FactBase contains at least one; surface it. For career-changer Profiles, scope anchor + bridge clause to target family can coexist — split into two short sentences if needed (Profile allows 3-5 sentences). DO NOT regenerate the Profile without a scope anchor — it's the most credible recruiter signal you have.";
    } else if (/passive 'exposure to'|familiarity with|working knowledge of/i.test(what)) {
      fix = "Rewrite the passive proximity construction as an ACTIVE verb claiming the work. Worked examples:\n  BAD: 'Daily exposure to supplier contract review, checking delivery and liability terms'\n  GOOD: 'Reviewing supplier contracts daily for delivery and liability terms'\n  GOOD: 'Handles supplier contract review across delivery and liability disputes'\n\n  BAD: 'Familiarity with regulatory reporting and compliance frameworks'\n  GOOD: 'Owns weekly regulatory reporting and quarterly compliance reviews'\n\nNever start with 'Exposure to' / 'Familiarity with' / 'Working knowledge of' / 'Awareness of'. These are weak CV-tells. Lead with the action verb that names the work the candidate ACTUALLY does.";
    } else if (/abstract noun stack/i.test(what)) {
      fix = "Replace the abstract noun stack with a concrete description. Worked examples:\n  BAD: 'now the business's primary operational data structure'\n  GOOD: 'now used daily across procurement and inventory'\n  GOOD: 'now the team's main system for stock reconciliation'\n  GOOD: (drop the abstract phrase entirely — let the named tool stand alone)\n\nThe phrase fails because 'primary operational data structure' is three abstract nouns with no concrete grounding. A recruiter cannot picture what this means. Name the actual outcome, the actual use case, or the actual user — not abstract organisational language.";
    } else if (/possessive non-brand-tier employer name/i.test(what)) {
      fix = "Drop the possessive employer name from the Profile body. Replace '[Employer]'s supply chain' / '[Employer]'s function' with 'the supply chain' / 'the function' (or restructure without the noun phrase entirely). The employer name lives in the Experience section heading — repeating it in the Profile wastes words and reads clunky. EXCEPTION: brand-tier employers (Siemens, Goldman, McKinsey, FAANG, etc.) MAY appear as bare names ('at Siemens DISW'), but never as possessive constructions ('Siemens DISW's procurement team').";
    } else if (/lacks an explicit pivot signal/i.test(what)) {
      fix = "Restructure S1 to LEAD with the pivot. Format: '[Current role] [pivot verb] [target family], [transferable bridge clause from FactBase].' Pivot verbs: 'pivoting to', 'moving into', 'transitioning to', 'career-changing into'. Example for Supply Chain → Legal: 'Supply Chain Analyst pivoting to Legal, with hands-on supplier contract review at Grain and Frame.' (replace 'hands-on' with a non-banned alternative). The pivot signal MUST appear in S1, not anywhere else.";
    } else if (/S2 does not bridge/i.test(what)) {
      fix = "Rewrite S2 to combine the scope anchor with an explicit target-family bridge. The scope anchor (2x growth, £40M, count) stays; the action paired with it must NAME the target family or a clearly-related concept. The Profile allows up to 5 sentences — if you can't fit the scope anchor AND the bridge in one one-breath sentence, split into two short sentences (both still within S2 territory). Do NOT use tagline phrasings like 'the operational counterpart of X practice' — these read as model-tells. Frame the bridge as concrete work the candidate does, in natural English.";
    } else if (/lacks a named-target close/i.test(what)) {
      fix = "Append a named target to S4 after the degree details. Format: '[Degree close]. Targeting [a specific role appropriate to the candidate's level] [in the target family].' Examples: 'First-Class Business with Marketing BA from Birmingham City University. Targeting a graduate paralegal role at a commercial firm.' / '...Targeting an SQE-route training contract.' The target role must match the candidate's realistic entry-level for the target family — not 'senior X' if they're a career-changer entry-level candidate.";
    } else if (/passive CV-speak|introducer verb/i.test(what)) {
      fix = "Rewrite the close to LEAD with the degree itself — 'First-Class BSc Economics from LSE, top of the cohort' — not 'Awarded a...', 'Graduated with...', 'Holds a...', 'Earned a...'. The qualification is the subject; no introducer verb needed.";
    } else if (/connective fluff|specialising in|focusing on/i.test(what)) {
      fix = "Replace the fluff verb with plain scope language. NOT 'X specialising in Y and Z'. YES 'X working across Y and Z' or 'X owning Y and Z' or 'X at [employer], with scope spanning Y and Z'.";
    } else if (/standalone soft-skill that recruiters discount/i.test(what)) {
      fix = "DELETE this item from the Skills section entirely. Soft skills as standalone Skills entries are banned — 76% of CVs list them, making the candidate average not differentiated, AND Workday's classifier drops multi-word soft-skill phrases. Route the underlying claim to an experience bullet where the FactBase provides evidence (e.g. 'Communication' becomes a bullet like 'Led weekly cross-functional stand-ups with engineering and finance'). If the candidate's FactBase has no evidence for the soft skill, drop the claim entirely — listing it without evidence is worse than not listing it.";
    } else if (/bare tool name without feature/i.test(what)) {
      fix = "Expand the bare tool to name specific features / methods / use. Bare tool names are dead-since-2024 CV register. Worked examples:\n  BAD: 'Excel' → GOOD: 'Excel (PivotTables, Power Query, advanced formulas)' or 'Excel (VLOOKUP, INDEX-MATCH, dynamic arrays)'\n  BAD: 'Microsoft Office' → GOOD: name specific apps with features ('Excel (PivotTables), PowerPoint (executive decks), Word (long-form analysis)') or drop entirely\n  BAD: 'ERP Systems' → GOOD: name the actual system ('SAP IBP', 'Oracle SCM', 'Airtable ERP')\n  BAD: 'Programming' → GOOD: name languages with libraries ('Python (pandas, scikit-learn)', 'SQL (joins, window functions)')\n  BAD: 'Database' → GOOD: name the system ('PostgreSQL', 'MySQL', 'MongoDB')\nThe FactBase / work history should provide the specifics — if the candidate genuinely only used the bare tool, drop the item; a bare bullet point is worse than nothing.";
    } else if (/Skills item .* is too long/i.test(what) || /Skills item .* contains a sentence/i.test(what)) {
      fix = "Shorten the Skills item to 1-6 words (excluding parenthetical content). Skills items are keyword density, not prose. If you have a multi-claim item, split into separate items. If you have a sentence/explanation, move that content to an experience bullet and use a short noun phrase in Skills.";
    } else if (/Skills section has only \d+ total items/i.test(what)) {
      fix = "Pull more skills from the FactBase: work history bullets, achievements, persisted user_skills, JD-required skills the FactBase plausibly supports. Add until total ≥8. If the FactBase truly cannot support 8 items, the candidate has a content gap to address before tailoring (raise via the audit modal).";
    } else if (/Skills section has \d+ total items.* maximum is 20/i.test(what)) {
      fix = "Cut the least JD-relevant items until total ≤20. Prioritise items that (a) appear in the JD as required/desirable, (b) are tool-specific not generic, (c) have FactBase evidence. Drop generic competencies and items with weak FactBase support first.";
    } else if (/items but only .* categor(?:y|ies).* categorisation into 3-5/i.test(what)) {
      fix = "Split the items into 3-5 concrete domain categories. Examples for supply chain: 'Supply Chain & Procurement', 'Data Analysis & Reporting', 'Methods & Frameworks', 'Systems & Tools'. Each category should be domain-specific (not generic 'Skills' / 'Other' / 'Miscellaneous'). Order by JD relevance.";
    } else if (/research shows categorisation only adds value above ~12 items/i.test(what)) {
      fix = "Flatten into a single category. With ≤12 items, categorisation reads as forced and harms parsing. Use one category labelled 'Key Skills' (or a domain-specific name like 'Supply Chain & Analysis Skills'). Order items by JD relevance.";
    } else if (/has \d+ categories.* maximum is 5/i.test(what)) {
      fix = "Merge similar categories until total ≤5. Look for conceptual overlap (e.g. 'Tools' + 'Software' = merge; 'Communication' + 'Stakeholders' = merge).";
    } else if (/Category name .* is a generic catch-all/i.test(what)) {
      fix = "Rename the generic catch-all category to something concrete and domain-specific. Banned: 'Skills', 'Other', 'Miscellaneous', 'Additional Skills'. Use a concrete domain category instead: 'Tools & Systems', 'Methods & Frameworks', 'Domain Expertise', '[Specific industry] Skills', etc.";
    } else if (/Category .* has only \d+ item|Category .* has \d+ items.*maximum is 7/i.test(what)) {
      fix = "For thin categories (<3 items): either add items from FactBase OR merge into another category. For overstuffed categories (>7 items): cut least JD-relevant items, OR split into two concrete categories. Each category should be a domain-fit cluster of 3-7 specific items.";
    } else if (/is a methodology .* not a tool/i.test(what)) {
      fix = "Move the methodology item OUT of the Tools/Systems category. Best options: (a) move into a Methods / Frameworks category if one exists; (b) move into a Supply Chain / Domain category that legitimately holds both methods + tools; (c) rename the current category to something domain-fit that holds both. Worked examples:\n  BAD: 'Systems & Tools: Excel, SAP, Material Requirements Planning (MRP), Airtable' — MRP is a method, not a tool\n  GOOD: 'Systems & Tools: Excel (PivotTables), SAP, Airtable' (tools only) + add a 'Methods & Frameworks: MRP, S&OP, Lean' category\n  GOOD ALT: rename to 'Supply Chain Tools & Methods' so both fit\nThe scanner re-runs after rewrite; methodology items in Tool-only categories stay flagged.";
    } else if (/is a named tool .* not a methodology/i.test(what)) {
      fix = "Move the tool item OUT of the Methods/Frameworks category and into a Tools & Systems category. Methods categories hold abstract approaches (Lean, Agile, S&OP); they do NOT hold named tools.";
    } else if (/methodology .* doesn't belong in the .* category/i.test(what)) {
      fix = "Move the methodology item into a Methods / Frameworks category (or a domain-fit category). Common mistake: putting 'Process improvement' or 'Continuous improvement' under Stakeholder/Management — these are methods, not stakeholder skills.";
    } else if (/Item .* appears in \d+ categories/i.test(what)) {
      fix = "Pick the ONE most-fitting category for this item and remove it from all others. e.g. 'Stakeholder management' belongs in Stakeholder & Communication, not also in Supply Chain. Duplicates waste 1-2 items of your 8-20 budget for no recruiter benefit.";
    } else if (/are the same concept under different names|overlap .* is a subset/i.test(what)) {
      fix = "Merge the overlapping items into ONE. Pick the form with the highest specificity / JD-alignment. Worked examples:\n  BAD: Both 'Material planning' AND 'Material Requirements Planning (MRP)' → keep MRP (acronym normalised, JD-matching)\n  BAD: Both 'Excel' AND 'Excel (PivotTables, Power Query)' → keep the feature-specific form\n  BAD: Both 'Stakeholder management' AND 'Stakeholder reporting' → keep both if genuinely distinct, OR merge if the same activity\nFreed-up budget can go to a more JD-relevant skill.";
    } else if (/contains buzzword filler/i.test(what)) {
      fix = "Rewrite the item to drop the buzzword. 'Robust stakeholder management' → 'Stakeholder management'. 'Innovative process redesign' → 'Process redesign'. 'World-class reporting' → 'Director-level reporting'. If removing the buzzword leaves nothing distinctive, drop the item entirely — buzzwords aren't substitutes for content.";
    } else if (/uses a bare acronym without the spelled-out form/i.test(what)) {
      fix = "Expand the bare acronym to include the spelled-out form. Workday + Lever both win on dual-form presence (acronym + expansion). Worked examples:\n  BAD: 'MRP' → GOOD: 'Material Requirements Planning (MRP)'\n  BAD: 'S&OP' → GOOD: 'Sales & Operations Planning (S&OP)'\n  BAD: 'OTIF' → GOOD: 'On Time In Full (OTIF)'\n  BAD: 'CRM' → GOOD: 'Customer Relationship Management (CRM)' OR name the specific CRM system ('Salesforce', 'HubSpot')\nIf another Skills item already contains the spelled form, that's also acceptable.";
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

  // Each retry gets progressively stronger language because the previous
  // rewrite still failed the critic. By attempt 3 we are explicit that this
  // is the LAST chance and any flagged phrase remaining is unacceptable.
  const escalatedHeader =
    attempt >= 3
      ? `FINAL REWRITE ATTEMPT — three previous rewrites have failed the critic on the same patterns. Strip and rebuild any sentence still flagged. If a sentence keeps tripping the same rule (multi-action S2, anchor leak, banned word), delete the offending clause entirely rather than rephrasing it. The output must contain ZERO of the flagged patterns.

`
      : attempt >= 2
      ? `THIRD REWRITE ATTEMPT — two previous rewrites have failed. Be ruthless. If a sentence keeps failing the same rule, change its structure entirely instead of editing words. Do not produce another output that contains any of the flagged phrases or patterns.

`
      : attempt >= 1
      ? `SECOND REWRITE ATTEMPT — the previous rewrite STILL failed the critic. Be ruthless. Do not produce another output that contains any of the flagged phrases or patterns. If a word is banned in a sentence, the corrected sentence must not contain that word at all.

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

function buildSystemPrompt(exclusions: string[] = []): string {
  const exclusionsBlock =
    exclusions.length > 0
      ? `

USER EXCLUSIONS (HARDEST RULE — never include any of these phrases anywhere in the CV, especially the Profile, regardless of FactBase content or JD relevance. The user has explicitly forbidden them):
${exclusions.map((e) => `- ${e}`).join("\n")}
`
      : "";

  return `You are a UK CV writer. You produce ATS-safe, evidence-grounded, tailored CVs that read as authentically human.${exclusionsBlock}

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
- Skills section sits BETWEEN Profile and Experience in the rendered CV — a scan-friendly keyword block for ATS and recruiters. Earn that prime placement with sharp categorisation.

SKILLS — EVIDENCE-BASED RULES (NON-NEGOTIABLE):

Format research (2025-2026, triangulated across Workday, Greenhouse, Lever, iCIMS, Taleo parser tests + 15K-application callback study): optimised Skills sections deliver 11.7% callback rate vs 4.2% generic. The rules below survive every major ATS, score highest on AI screeners (GPT-4-class), get seen in the 7-11s recruiter scan, and clear keyword-stuffing thresholds.

VOLUME:
- 8-20 total items across the section. <8 reads thin; >20 reads as padding.
- 3-5 categories when total items >12; flat single category "Key Skills" allowed when total ≤12 (categorisation only adds value above ~12 items).
- 3-7 items per category. <3 = thin category (merge or drop); >7 = wall of text (split or trim).

ITEM FORMAT:
- 1-6 words per item. Single-token entities (Workday, Greenhouse) and short noun phrases (2-4 words) parse + score highest.
- NEVER sentences. NEVER explanations. The Skills section is keyword density, not prose.
- Acronyms must appear WITH spelled-out form on first/primary mention: "Sales & Operations Planning (S&OP)", "Material Requirements Planning (MRP)", "Machine Learning (ML)", "Customer Relationship Management (CRM)". Lever does not auto-expand; Workday and AI screeners reward both forms present.

TOOL SPECIFICITY (HARD — Bare tools fail):
Bare tool names without feature / use specificity are inadequate. The standard since 2024:
- BAD: "Excel" / "Microsoft Office" / "Programming" / "ERP Systems" / "Database"
- GOOD: "Excel (PivotTables, Power Query, advanced formulas)" / "Excel (VLOOKUP, INDEX-MATCH, dynamic arrays)" / "Python (pandas, scikit-learn)" / "SQL (joins, window functions, CTEs)" / "SAP IBP" / "Oracle SCM" / "Salesforce CRM"
- For each bare-tool item the candidate could expand, expand it. "Excel" alone signals 2010-era CV register.

STANDALONE SOFT SKILLS — HARD BAN:
Soft skills as standalone Skills-section items are BANNED. Workday's classifier explicitly drops multi-word soft-skill phrases. Recruiters (203-pro survey, 89% pass-rate impact) discount unsubstantiated soft-skill nouns. 76% of CVs list "Communication skills" — listing makes the candidate AVERAGE, not differentiated.

BANNED as standalone items in any category:
- Communication / Communication skills / Strong communication / Excellent communication
- Teamwork / Team player / Collaborative
- Problem solving / Problem-solver / Critical thinking
- Leadership / Strong leader / Natural leader
- Detail-oriented / Attention to detail / Eye for detail
- Self-starter / Self-motivated / Self-driven
- Hard-working / Hardworking / Dedicated
- Time management / Organised / Multitasking
- Passionate / Driven / Motivated
- Results-driven / Results-oriented / Goal-oriented
- Adaptable / Flexible / Resilient
- Strategic thinking (standalone) / Strategic mindset

Soft skills BELONG in experience bullets where the FactBase provides evidence ("Led cross-functional weekly stand-ups with engineering, finance, and ops" demonstrates communication + leadership without listing them). Move them out of Skills entirely.

EXCEPTION — contextualised competencies allowed as items when paired with a domain noun:
- "Stakeholder management" (domain-anchored) — ACCEPTABLE
- "Vendor negotiation" — ACCEPTABLE
- "Cross-functional facilitation" — ACCEPTABLE
- "Executive-level written analysis" — ACCEPTABLE
- "Director-level reporting" — ACCEPTABLE

BANNED BUZZWORDS / FILLER (anywhere in items):
- Synergy / Synergistic / Synergies
- Holistic / Holistic approach
- Dynamic / Dynamic environment
- Cutting-edge / State-of-the-art
- World-class / Best-in-class
- Robust / Seamless
- Excellence / Operational excellence

CATEGORY CHOICES (when categorised):
Pick 3-5 from these or invent equivalents that fit the candidate:
  · "Tools & Systems" / "Software & Platforms" (NAMED tools with features)
  · "Methods" / "Frameworks" / "Methodologies" (Agile, S&OP, Lean Six Sigma, MRP, etc.)
  · "Domain Expertise" / "Functional Skills" (subject areas)
  · "Stakeholder & Communication" (contextualised — never just "Communication")
  · "Technical / Coding / Modelling" (technical roles)
  · "Sector / Industry" (only if JD-relevant)

NEVER use generic catch-all categories: "Key Skills", "Other", "Miscellaneous", "Additional Skills", "Skills". Categories must be concrete and domain-fit.

KEYWORD DENSITY (HARD — modern AI screeners flag stuffing):
- 75-85% match between Skills items and JD-required skills/tools — the optimal callback band.
- No single keyword repeated >4 times across the entire CV (Skills + Profile + bullets combined).
- Overall keyword density across the CV: 1-2% optimal; >5% triggers stuffing penalties.
- Surface JD-required skills ONLY where the FactBase supports the claim. Truth Contract is non-negotiable.

ORDER:
- Order categories by JD relevance — most JD-critical category first.
- Within each category, order items by JD relevance — JD-named tools first, candidate strengths second.

TRUTH CONTRACT:
Every item must trace to FactBase (work history, achievements, persisted user_skills) OR to a JD-required skill the FactBase plausibly supports (e.g. FactBase shows "Power BI reporting" → Skills can list "Power BI"). NEVER invent skills the FactBase doesn't support. NEVER list a JD-required skill the candidate clearly lacks just to keyword-match.

OUTPUT SHAPE: skills: [{ category: "Tools & Systems", items: ["Excel (PivotTables, Power Query)", "SAP IBP", "Power BI", ...] }, { category: "Methods", items: [...] }, ...]

THIN-FACTBASE FALLBACK:
If the FactBase genuinely doesn't support 12+ specific items across 3 categories, output FEWER (minimum 2 categories, minimum 3 items each, minimum 8 items total). Prefer fewer high-quality items over padding. Empty space is better than fluff that triggers buzzword/stuffing flags.

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
  // Skills audit answers from the CV Builder pre-flight checklist modal.
  // The user has ticked these JD-required skills they actually have, plus
  // specified vague items, plus added free-text. All three are
  // truth-contract-grounded inputs from the user — must surface in the
  // Skills section.
  skillsAuditAnswers?: {
    confirmedSkills?: string[];
    vagueSpecifications?: Array<{ vagueItem: string; specifics: string[] }>;
    additionalSkills?: string[];
  };
}): string {
  const { factbaseText, jdText, companyName, roleName, preTailoredProfile, skillsAuditAnswers } = args;
  const targetLine = [companyName && `Target company: ${companyName}`, roleName && `Target role: ${roleName}`]
    .filter(Boolean)
    .join("\n");

  const profileSection = preTailoredProfile
    ? `=== USER'S MASTER PROFILE (MUST USE VERBATIM) ===
The user has saved this Master Profile and chosen to use it verbatim. Copy the following text EXACTLY into the "summary" field of your output — same wording, same punctuation, same word order. Do NOT rewrite, edit, summarise, paraphrase, or "improve" it. Even if you think a phrase could be sharper for this JD, leave it alone — the user has chosen this wording deliberately.

If a JD-relevant fact in the FactBase isn't reflected in the Master Profile, surface it through the bullets, skills, or other sections — never by altering the Profile.

${preTailoredProfile}

`
    : "";

  // Skills-audit block — assembled when the user came through the pre-flight
  // SkillsAuditModal in the CV Builder. These are TRUTH-CONTRACT-GROUNDED
  // inputs from the user (they confirmed they have these skills) — must
  // surface in the Skills section.
  const skillsAuditBlock =
    skillsAuditAnswers &&
    ((skillsAuditAnswers.confirmedSkills?.length ?? 0) > 0 ||
      (skillsAuditAnswers.vagueSpecifications?.length ?? 0) > 0 ||
      (skillsAuditAnswers.additionalSkills?.length ?? 0) > 0)
      ? `=== USER-CONFIRMED SKILLS (treat as truth — user explicitly ticked / added these) ===
${
  skillsAuditAnswers.confirmedSkills && skillsAuditAnswers.confirmedSkills.length > 0
    ? `\nJD-required skills the user has (confirmed via checklist):\n${skillsAuditAnswers.confirmedSkills.map((s) => `- ${s}`).join("\n")}\n`
    : ""
}${
  skillsAuditAnswers.vagueSpecifications && skillsAuditAnswers.vagueSpecifications.length > 0
    ? `\nVague-item specifications (replace the vague items with these named tools in the Skills section):\n${skillsAuditAnswers.vagueSpecifications
        .map(
          (v) =>
            `- "${v.vagueItem}" → specify as: ${v.specifics.join(", ")}`
        )
        .join("\n")}\n`
    : ""
}${
  skillsAuditAnswers.additionalSkills && skillsAuditAnswers.additionalSkills.length > 0
    ? `\nAdditional skills user added (free-text):\n${skillsAuditAnswers.additionalSkills.map((s) => `- ${s}`).join("\n")}\n`
    : ""
}
These items MUST appear in the Skills section. Surface them in the appropriate categories. They are user-confirmed and JD-relevant — drop other less JD-relevant items from the Skills section to make room if needed.

`
      : "";

  return `${targetLine ? targetLine + "\n\n" : ""}=== JOB DESCRIPTION ===
${jdText.trim()}

=== CANDIDATE FACTBASE ===
${factbaseText}

${profileSection}${skillsAuditBlock}=== TASK ===
Produce a UK-conventional, ATS-safe, JD-tailored CV using ONLY the FactBase above.
- Pick the bullets and skills with the highest JD relevance.
- Rewrite each chosen bullet using the XYZ formula where possible, but stay strictly within what the FactBase supports.
${preTailoredProfile
  ? "- The Profile (\"summary\" field) is the user's Master Profile. Copy it VERBATIM into the output. Same words, same order. Do not modify it under any circumstances. JD-relevance is conveyed through the bullets and skills sections, NOT by editing the Profile."
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
