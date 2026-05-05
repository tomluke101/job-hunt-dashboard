"use server";

import { auth } from "@clerk/nextjs/server";
import { revalidatePath } from "next/cache";
import { createServerSupabaseClient } from "@/lib/supabase-server";
import { callAI } from "@/lib/ai-router";
import { extractFactBase, ExtractFactBaseOptions, ExtractFactBaseResult } from "@/lib/cv/extract";
import {
  tailorCV as tailorCVImpl,
  refineTailoredCV as refineTailoredCVImpl,
  TailorInput,
  RefineInput,
  TailorResult,
} from "@/lib/cv/tailor";
import {
  generateMasterProfileFromFactBase,
  tailorMasterToJD,
} from "@/lib/cv/master-profile";
import { getApiKeyValues } from "@/app/actions/api-keys";
import type { TailoredCV } from "@/lib/cv/tailored-cv";

export async function getFactBase(
  options: ExtractFactBaseOptions = {}
): Promise<ExtractFactBaseResult> {
  return extractFactBase(options);
}

export async function tailorCV(input: TailorInput): Promise<TailorResult> {
  return tailorCVImpl(input);
}

export async function refineTailoredCV(input: RefineInput): Promise<TailorResult> {
  return refineTailoredCVImpl(input);
}

// ── Master Profiles (multi-Master) ───────────────────────────────────────────
//
// Users can save multiple Masters (e.g. "Supply Chain Analyst", "Commercial
// Property Master") with one marked as default. CV tailoring uses the user's
// chosen Master per JD; if not specified, the default is used.

export interface MasterProfile {
  id: string;
  user_id: string;
  name: string;
  summary: string;
  source: "manual" | "generated" | "edited";
  factbase_hash: string | null;
  updated_at: string;
  created_at: string;
  is_default: boolean;
  // Per-Master "never include in Profile" list. Phrases the AI must honour
  // when this Master is in use (Master generator + per-CV Adapt prompts).
  exclusions: string[];
}

function rowToMaster(data: Record<string, unknown>): MasterProfile {
  const exclusions: string[] = Array.isArray(data.exclusions)
    ? (data.exclusions as unknown[]).filter(
        (e): e is string => typeof e === "string" && !!e.trim()
      )
    : [];
  return {
    id: String(data.id ?? ""),
    user_id: String(data.user_id ?? ""),
    name: String(data.name ?? "My Master"),
    summary: String(data.summary ?? ""),
    source: (data.source as MasterProfile["source"]) ?? "manual",
    factbase_hash: (data.factbase_hash as string | null) ?? null,
    updated_at: String(data.updated_at ?? ""),
    created_at: String(data.created_at ?? data.updated_at ?? ""),
    is_default: !!data.is_default,
    exclusions,
  };
}

// List every Master the signed-in user has saved, default first.
export async function getMasterProfiles(): Promise<MasterProfile[]> {
  const { userId } = await auth();
  if (!userId) return [];
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from("user_master_profile")
    .select("*")
    .eq("user_id", userId)
    .order("is_default", { ascending: false })
    .order("created_at", { ascending: true });
  if (error) {
    console.error("[getMasterProfiles] error:", error);
    return [];
  }
  return (data ?? []).map((row) => rowToMaster(row as Record<string, unknown>));
}

// Get the user's default Master, or null if they have none.
export async function getDefaultMasterProfile(): Promise<MasterProfile | null> {
  const { userId } = await auth();
  if (!userId) return null;
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from("user_master_profile")
    .select("*")
    .eq("user_id", userId)
    .eq("is_default", true)
    .maybeSingle();
  if (error) {
    console.error("[getDefaultMasterProfile] error:", error);
    return null;
  }
  return data ? rowToMaster(data as Record<string, unknown>) : null;
}

// Get a specific Master by id (RLS ensures it's the user's own).
export async function getMasterProfileById(id: string): Promise<MasterProfile | null> {
  const { userId } = await auth();
  if (!userId) return null;
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from("user_master_profile")
    .select("*")
    .eq("id", id)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) {
    console.error("[getMasterProfileById] error:", error);
    return null;
  }
  return data ? rowToMaster(data as Record<string, unknown>) : null;
}

// Backwards-compat alias for the single-Master era. New code should use
// getDefaultMasterProfile() or getMasterProfileById(id).
export async function getMasterProfile(): Promise<MasterProfile | null> {
  return getDefaultMasterProfile();
}

// Save (insert OR update) a Master. id present = update; absent = insert new.
// On insert, becomes the default if the user has none yet, otherwise follows
// the explicit isDefault flag.
export async function saveMaster(input: {
  id?: string;
  name?: string;
  summary: string;
  source?: "manual" | "generated" | "edited";
  isDefault?: boolean;
}): Promise<{ error?: string; id?: string }> {
  try {
    const { userId } = await auth();
    if (!userId) return { error: "Not signed in" };
    if (!input.summary || !input.summary.trim()) return { error: "Profile is empty" };

    const supabase = await createServerSupabaseClient();
    const trimmedSummary = input.summary.trim();
    const trimmedName = (input.name ?? "").trim() || "My Master";
    const source = input.source ?? "manual";

    if (input.id) {
      // Update existing Master (preserving exclusions / default flag unless overridden).
      const update: Record<string, unknown> = {
        summary: trimmedSummary,
        name: trimmedName,
        source,
        updated_at: new Date().toISOString(),
      };
      if (typeof input.isDefault === "boolean") update.is_default = input.isDefault;
      const { error } = await supabase
        .from("user_master_profile")
        .update(update)
        .eq("id", input.id)
        .eq("user_id", userId);
      if (error) {
        console.error("[saveMaster] update error:", error);
        return { error: error.message };
      }
      // If we just set this one default, demote others.
      if (input.isDefault === true) {
        await supabase
          .from("user_master_profile")
          .update({ is_default: false })
          .eq("user_id", userId)
          .neq("id", input.id);
      }
      revalidatePath("/profile");
      revalidatePath("/cv");
      return { id: input.id };
    }

    // Insert new Master. If user has no Masters yet, this one becomes default.
    const { data: existing } = await supabase
      .from("user_master_profile")
      .select("id")
      .eq("user_id", userId)
      .limit(1);
    const willBeFirst = !existing || existing.length === 0;
    const isDefault = input.isDefault ?? willBeFirst;

    if (isDefault && !willBeFirst) {
      // Demote current default before inserting the new one (partial unique index).
      await supabase
        .from("user_master_profile")
        .update({ is_default: false })
        .eq("user_id", userId)
        .eq("is_default", true);
    }

    const { data: inserted, error } = await supabase
      .from("user_master_profile")
      .insert({
        user_id: userId,
        name: trimmedName,
        summary: trimmedSummary,
        source,
        is_default: isDefault,
        updated_at: new Date().toISOString(),
      })
      .select("id")
      .single();
    if (error) {
      console.error("[saveMaster] insert error:", error);
      return { error: error.message };
    }
    revalidatePath("/profile");
    revalidatePath("/cv");
    return { id: inserted?.id };
  } catch (e) {
    console.error("[saveMaster] unexpected:", e);
    return { error: e instanceof Error ? e.message : "Failed to save." };
  }
}

// Backwards-compat: save (or upsert) the default Master. Maintained for any
// callers that haven't migrated to saveMaster() yet.
export async function saveMasterProfile(input: {
  summary: string;
  source?: "manual" | "generated" | "edited";
}): Promise<{ error?: string }> {
  // Find the user's default (if any) and update; otherwise insert as default.
  const { userId } = await auth();
  if (!userId) return { error: "Not signed in" };
  const existing = await getDefaultMasterProfile();
  return saveMaster({
    id: existing?.id,
    name: existing?.name ?? "My Master",
    summary: input.summary,
    source: input.source,
    isDefault: true,
  });
}

// Set which Master is the user's default. Atomically demotes the current
// default and promotes the chosen one.
export async function setDefaultMaster(id: string): Promise<{ error?: string }> {
  try {
    const { userId } = await auth();
    if (!userId) return { error: "Not signed in" };
    const supabase = await createServerSupabaseClient();
    // Demote all of user's Masters first, then promote the chosen one.
    const { error: demoteErr } = await supabase
      .from("user_master_profile")
      .update({ is_default: false })
      .eq("user_id", userId)
      .neq("id", id);
    if (demoteErr) {
      console.error("[setDefaultMaster] demote error:", demoteErr);
      return { error: demoteErr.message };
    }
    const { error: promoteErr } = await supabase
      .from("user_master_profile")
      .update({ is_default: true, updated_at: new Date().toISOString() })
      .eq("id", id)
      .eq("user_id", userId);
    if (promoteErr) {
      console.error("[setDefaultMaster] promote error:", promoteErr);
      return { error: promoteErr.message };
    }
    revalidatePath("/profile");
    revalidatePath("/cv");
    return {};
  } catch (e) {
    console.error("[setDefaultMaster] unexpected:", e);
    return { error: e instanceof Error ? e.message : "Failed to set default." };
  }
}

// Save exclusions for a specific Master.
export async function setMasterExclusions(
  arg1: string | string[],
  arg2?: string[]
): Promise<{ error?: string; needsMigration?: boolean }> {
  // Backwards-compat overload: setMasterExclusions(exclusions) operates on
  // the default Master. setMasterExclusions(masterId, exclusions) operates
  // on the specified one.
  let masterId: string | null = null;
  let exclusions: string[];
  if (Array.isArray(arg1)) {
    exclusions = arg1;
  } else {
    masterId = arg1;
    exclusions = arg2 ?? [];
  }

  try {
    const { userId } = await auth();
    if (!userId) return { error: "Not signed in" };

    // Resolve the target Master.
    if (!masterId) {
      const def = await getDefaultMasterProfile();
      if (!def) {
        return {
          error:
            "Save a Master Profile first — exclusions attach to it, so the row needs to exist before we can store them.",
        };
      }
      masterId = def.id;
    }

    // Sanitise: trim, drop empties, dedupe (case-insensitive), cap to 50.
    const cleaned = Array.from(
      new Map(
        exclusions
          .map((e) => (typeof e === "string" ? e.trim() : ""))
          .filter(Boolean)
          .map((e) => [e.toLowerCase(), e])
      ).values()
    ).slice(0, 50);

    const supabase = await createServerSupabaseClient();
    const { error } = await supabase
      .from("user_master_profile")
      .update({ exclusions: cleaned, updated_at: new Date().toISOString() })
      .eq("id", masterId)
      .eq("user_id", userId);

    if (error) {
      const msg = String(error.message ?? "");
      const code = String((error as { code?: string }).code ?? "");
      const missingColumn =
        code === "42703" ||
        /column .*exclusions.* does not exist/i.test(msg) ||
        /could not find the .*exclusions.* column/i.test(msg);
      if (missingColumn) {
        return {
          error:
            "The exclusions feature needs a one-line database migration. Run the SQL in your Supabase dashboard, then try again.",
          needsMigration: true,
        };
      }
      console.error("[setMasterExclusions] supabase error:", error);
      return { error: error.message };
    }
    revalidatePath("/profile");
    revalidatePath("/cv");
    return {};
  } catch (e) {
    console.error("[setMasterExclusions] unexpected:", e);
    return { error: e instanceof Error ? e.message : "Failed to save exclusions." };
  }
}

// Delete a Master by id. If it was the default and others remain, the
// most-recently-updated other becomes the new default.
export async function deleteMaster(id: string): Promise<{ error?: string }> {
  try {
    const { userId } = await auth();
    if (!userId) return { error: "Not signed in" };
    const supabase = await createServerSupabaseClient();

    // Fetch the row to know if it was default.
    const { data: row } = await supabase
      .from("user_master_profile")
      .select("id, is_default")
      .eq("id", id)
      .eq("user_id", userId)
      .maybeSingle();
    if (!row) return { error: "Master not found." };

    const { error: delErr } = await supabase
      .from("user_master_profile")
      .delete()
      .eq("id", id)
      .eq("user_id", userId);
    if (delErr) {
      console.error("[deleteMaster] error:", delErr);
      return { error: delErr.message };
    }

    // Promote a replacement default if needed.
    if (row.is_default) {
      const { data: replacement } = await supabase
        .from("user_master_profile")
        .select("id")
        .eq("user_id", userId)
        .order("updated_at", { ascending: false })
        .limit(1);
      if (replacement && replacement.length > 0) {
        await supabase
          .from("user_master_profile")
          .update({ is_default: true })
          .eq("id", replacement[0].id);
      }
    }

    revalidatePath("/profile");
    revalidatePath("/cv");
    return {};
  } catch (e) {
    console.error("[deleteMaster] unexpected:", e);
    return { error: e instanceof Error ? e.message : "Failed to delete." };
  }
}

// Backwards-compat: deletes the user's default Master.
export async function deleteMasterProfile(): Promise<{ error?: string }> {
  const def = await getDefaultMasterProfile();
  if (!def) return {};
  return deleteMaster(def.id);
}

export async function generateMasterProfile(input: {
  cvId?: string;
  // Optional ad-hoc context from the Profile Builder Wizard. Treated as
  // truth-grounded supplementary data, not persisted to user_skills /
  // user_employers. Used only for THIS generation call.
  wizardContext?: WizardContext;
}): Promise<{ summary?: string; warnings: string[]; error?: string }> {
  const keys = await getApiKeyValues();
  if (Object.keys(keys).length === 0) {
    return { warnings: [], error: "No AI provider connected. Add an API key in Settings." };
  }
  // Pull the default Master's saved exclusions so they're honoured even by
  // the FIRST Master generation (not just per-CV adapt). If user has no
  // Master yet, exclusions is [].
  const existing = await getDefaultMasterProfile();
  const exclusions = existing?.exclusions ?? [];
  return generateMasterProfileFromFactBase({
    exclusions,
    cvId: input.cvId,
    connectedProviders: keys,
    wizardContext: input.wizardContext,
  });
}

// Mirror of WizardAnswers — kept here so the server action signature doesn't
// have to import client component types.
export interface WizardContext {
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

export async function tailorMasterProfile(input: {
  master: string;
  jdText: string;
  cvId?: string;
  companyName?: string;
  roleName?: string;
  exclusions?: string[];
}): Promise<{ tailored?: string; warnings: string[]; error?: string }> {
  const keys = await getApiKeyValues();
  if (Object.keys(keys).length === 0) {
    return { warnings: [], error: "No AI provider connected. Add an API key in Settings." };
  }
  return tailorMasterToJD({
    master: input.master,
    jdText: input.jdText,
    cvId: input.cvId,
    companyName: input.companyName,
    roleName: input.roleName,
    exclusions: input.exclusions,
    connectedProviders: keys,
  });
}

// Per-CV adapter for the "Adapt to this JD" button. Loads the chosen Master
// (or the user's default if no id given) + its exclusions, runs the
// constrained adaptation, returns original + adapted + warnings + the master
// name so the UI can show "Adapting [Master name] for [JD]".
export async function adaptMasterForCV(input: {
  jdText: string;
  cvId?: string;
  companyName?: string;
  roleName?: string;
  masterId?: string;
}): Promise<{
  master?: string;
  adapted?: string;
  masterName?: string;
  warnings: string[];
  error?: string;
  unchanged?: boolean;
}> {
  const { userId } = await auth();
  if (!userId) return { warnings: [], error: "Not signed in" };

  const masterRow = input.masterId
    ? await getMasterProfileById(input.masterId)
    : await getDefaultMasterProfile();

  if (!masterRow || !masterRow.summary?.trim()) {
    return {
      warnings: [],
      error: "No saved Master Profile to adapt. Save one on the Profile page first.",
    };
  }

  const masterSummary = masterRow.summary.trim();
  const exclusions = masterRow.exclusions ?? [];

  const result = await tailorMasterProfile({
    master: masterSummary,
    jdText: input.jdText,
    cvId: input.cvId,
    companyName: input.companyName,
    roleName: input.roleName,
    exclusions,
  });

  if (result.error) {
    return { warnings: result.warnings, error: result.error };
  }

  const adapted = result.tailored ?? masterSummary;
  return {
    master: masterSummary,
    adapted,
    masterName: masterRow.name,
    warnings: result.warnings,
    unchanged: adapted === masterSummary,
  };
}

// ── Profile Builder prefill — wizard reads this to populate fields/suggestions ──
export interface ProfileBuilderPrefill {
  currentJobTitle: string | null;
  currentCompany: string | null;
  currentSector: string | null;
  recentEmployers: Array<{ company: string; title: string; isCurrent: boolean }>;
  existingSkills: Array<{ id: string; text: string }>;
  educationSummary: string | null;
  distinctiveCandidates: string[]; // Skills containing sole/founding/only language
  fullName: string | null;
  headline: string | null;
}

// AI-assisted suggestion: takes the user's wizard answers + their existing
// Skills, and returns 3-5 specific "distinctive angles" they could claim.
// Used by Step 4 when users can't think of what's distinctive themselves.
export async function suggestDistinctiveAngles(input: {
  jobTitle?: string;
  companyOrSector?: string;
  achievement?: string;
  achievementScale?: string;
}): Promise<{ suggestions: string[]; error?: string }> {
  const { userId } = await auth();
  if (!userId) return { suggestions: [], error: "Not signed in" };

  const keys = await getApiKeyValues();
  if (Object.keys(keys).length === 0) {
    return { suggestions: [], error: "No AI provider connected. Add an API key in Settings." };
  }

  const supabase = await createServerSupabaseClient();
  const skillsRes = await supabase
    .from("user_skills")
    .select("raw_text, polished_text")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(20);
  const skills = (skillsRes.data ?? [])
    .map((s) => s.polished_text || s.raw_text)
    .filter(Boolean);

  const wizardContext = [
    input.jobTitle && `Current role: ${input.jobTitle}`,
    input.companyOrSector && `Company / sector: ${input.companyOrSector}`,
    input.achievement && `Headline achievement: ${input.achievement}`,
    input.achievementScale && `Scale: ${input.achievementScale}`,
  ]
    .filter(Boolean)
    .join("\n");

  const skillsContext = skills.length > 0 ? skills.map((s) => `- ${s}`).join("\n") : "(none)";

  const systemPrompt = `You help job-seekers identify what makes their situation distinctive — i.e. what would another candidate doing their same role NOT have. Read the user's role context and saved skills/achievements. Return 3-5 specific, evidence-grounded distinctive claims they could make.

These suggestions are pasted directly into the candidate's CV Profile. They must therefore follow ALL the same Profile rules:

EACH suggestion must:
- Be grounded in the user's actual data — never invent metrics, employers, sectors, scopes, or credentials. If the data doesn't say it, you don't say it.
- Be specific (not "you have lots of experience").
- Be distinctive — not "you do procurement", which every candidate at that role does.
- Be ONE short sentence, MAX 22 WORDS.
- Use IMPLIED FIRST PERSON. Start with the action or status — never "I", "I'm", "I've", "my", "me", and never a third-person verb at sentence start ("Manages…", "Holds…", "Leads…", "Owns…", "Builds…").
- Contain NO em-dashes. Use commas or full stops.
- Contain NO tricolons (no "X, Y, and Z" lists). Two items max.
- Contain NO banned vocabulary: spearhead, leverage, orchestrate, championed, drove, pioneered, synergise, utilise, streamline, robust, seamless, cutting-edge, results-driven, passionate, dynamic, proven, demonstrated, hands-on, forward-thinking, fast-paced, world-class, best-in-class, value-add.
- Contain NO opening adjective stack ("Dedicated, organised…").
- NOT name a current employer unless the FactBase shows it is brand-tier (FTSE 100, S&P 500, FAANG, MBB, Magic Circle, Big 4, household-name unicorn). If you're not sure, omit the employer name.

Examples of distinctive angles to look for:
- Sole / only person in their role
- Founder / first hire / founding-team member
- Reports unusually high (CEO / Founder / SLT)
- Built the function from scratch
- Cross-functional across multiple disciplines
- Unusually rapid promotion or scope expansion
- Distinctive credential (rare cert, top-tier school, named scholarship)
- Single-handedly handled a scope-stretch event (2x growth, crisis, transition)
- Sector cross-over (career-changer with rare combination)
- Demographic / pipeline distinctive (only graduate in senior team, etc.)

GOOD example: "Sole supply chain analyst at the business, reporting directly to the founder."
GOOD example: "First-class Economics from a Russell Group, top of the cohort."
GOOD example: "Built the function from scratch with no predecessor or playbook."
BAD example: "I'm spearheading a leverage-driven, cross-functional, cutting-edge transformation across procurement, finance, and operations." (banned vocab, tricolon, "I'm", em-dash)

Return ONLY a JSON object: { "suggestions": [string, string, string, string, string] }. 3-5 items. If you genuinely can't find 3 distinctive things in the user's data, return fewer. Never fabricate.`;

  const userPrompt = `=== USER'S ROLE CONTEXT ===
${wizardContext || "(not yet provided)"}

=== USER'S SAVED SKILLS / ACHIEVEMENTS ===
${skillsContext}

=== TASK ===
Identify 3-5 distinctive angles the user could claim. Return ONLY the JSON.`;

  try {
    const result = await callAI({
      task: "cv-tailor",
      connectedProviders: keys,
      systemPrompt,
      prompt: userPrompt,
    });
    const trimmed = result.text.trim();
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start === -1 || end === -1) return { suggestions: [] };
    const parsed = JSON.parse(trimmed.slice(start, end + 1)) as { suggestions?: string[] };
    const cleaned = (parsed.suggestions ?? [])
      .filter((s): s is string => typeof s === "string" && !!s.trim())
      .map((s) => s.trim())
      .filter(passesProfileRulesSuggestion);
    return { suggestions: cleaned.slice(0, 5) };
  } catch (e) {
    console.error("[suggestDistinctiveAngles] error:", e);
    return { suggestions: [], error: e instanceof Error ? e.message : "AI call failed." };
  }
}

// Deterministic post-filter: drops any suggestion that breaks the Profile rules
// (em-dash, tricolon, first-person, banned vocab, length). Cheap insurance
// against the model occasionally ignoring the system prompt.
function passesProfileRulesSuggestion(s: string): boolean {
  const t = s.trim();
  if (t.length === 0) return false;

  // Word count cap — 22 words.
  const wordCount = t.split(/\s+/).filter(Boolean).length;
  if (wordCount > 24) return false;
  if (wordCount < 4) return false;

  // No em-dashes.
  if (/[—–]/.test(t)) return false;

  // No first-person pronouns.
  if (/\b(?:I|I'm|I've|I'll|my|me|mine)\b/i.test(t)) return false;

  // No tricolons (X, Y, and Z).
  if (/,[^,]+,[^,]+\band\b/i.test(t)) return false;

  // No banned vocabulary.
  const banned = [
    "spearhead",
    "leverage",
    "orchestrate",
    "championed",
    "championing",
    "drove",
    "pioneered",
    "synergise",
    "synergize",
    "utilise",
    "utilize",
    "streamline",
    "robust",
    "seamless",
    "cutting-edge",
    "results-driven",
    "passionate",
    "dynamic",
    "proven",
    "demonstrated",
    "hands-on",
    "forward-thinking",
    "fast-paced",
    "world-class",
    "best-in-class",
    "value-add",
  ];
  const lower = t.toLowerCase();
  for (const b of banned) {
    if (lower.includes(b)) return false;
  }

  // No opening adjective stack ("Dedicated, organised, ...").
  if (/^[A-Z][a-z]+,\s+[a-z]+,/.test(t)) return false;

  return true;
}

export async function getProfileBuilderPrefill(): Promise<ProfileBuilderPrefill> {
  const empty: ProfileBuilderPrefill = {
    currentJobTitle: null,
    currentCompany: null,
    currentSector: null,
    recentEmployers: [],
    existingSkills: [],
    educationSummary: null,
    distinctiveCandidates: [],
    fullName: null,
    headline: null,
  };

  try {
    const { userId } = await auth();
    if (!userId) return empty;

    const supabase = await createServerSupabaseClient();
    const [profileRes, employersRes, skillsRes] = await Promise.all([
      supabase.from("user_profile").select("full_name, headline").eq("user_id", userId).maybeSingle(),
      supabase
        .from("user_employers")
        .select("company_name, role_title, is_current, end_date, start_date")
        .eq("user_id", userId)
        .order("is_current", { ascending: false })
        .order("end_date", { ascending: false, nullsFirst: true })
        .order("start_date", { ascending: false })
        .limit(5),
      supabase
        .from("user_skills")
        .select("id, raw_text, polished_text")
        .eq("user_id", userId)
        .order("created_at", { ascending: false })
        .limit(200),
    ]);

    const employers = employersRes.data ?? [];
    const skills = skillsRes.data ?? [];
    const profile = profileRes.data ?? null;

    const currentEmp = employers.find((e) => e.is_current) ?? null;
    const distinctiveRegex = /\b(?:sole|only|founding|first[- ]hire|first[- ]ever|single[- ]handed)\b/i;

    return {
      currentJobTitle: currentEmp?.role_title ?? null,
      currentCompany: currentEmp?.company_name ?? null,
      currentSector: null, // user can fill if not derivable
      recentEmployers: employers.map((e) => ({
        company: e.company_name,
        title: e.role_title,
        isCurrent: !!e.is_current,
      })),
      existingSkills: skills.map((s) => ({
        id: s.id,
        text: s.polished_text || s.raw_text,
      })),
      educationSummary: null,
      distinctiveCandidates: skills
        .map((s) => s.polished_text || s.raw_text)
        .filter((t) => distinctiveRegex.test(t))
        .slice(0, 3),
      fullName: profile?.full_name ?? null,
      headline: profile?.headline ?? null,
    };
  } catch (e) {
    console.error("[getProfileBuilderPrefill] error:", e);
    return empty;
  }
}

// ── Saved tailored CVs (linked to applications) ──────────────────────────────

export interface SavedTailoredCV {
  id: string;
  application_id: string | null;
  company: string | null;
  role: string | null;
  jd_text: string | null;
  tailored_data: TailoredCV | null;   // null for manually-pasted CVs
  content: string | null;             // plain text fallback (always populated)
  created_at: string;
}

export async function saveTailoredCV(input: {
  tailoredCV: TailoredCV;
  applicationId?: string;
  companyName?: string;
  roleName?: string;
  jdText?: string;
}): Promise<{ id?: string; error?: string }> {
  try {
    const { userId } = await auth();
    if (!userId) return { error: "Not signed in" };

    const supabase = await createServerSupabaseClient();
    const plain = serialiseTailoredCVPlain(input.tailoredCV);

    const { data, error } = await supabase
      .from("cv_versions")
      .insert({
        user_id: userId,
        application_id: input.applicationId ?? null,
        company: input.companyName ?? null,
        role: input.roleName ?? null,
        jd_text: input.jdText ?? null,
        tailored_data: input.tailoredCV,
        content: plain,
      })
      .select("id")
      .single();

    if (error) {
      console.error("[saveTailoredCV] supabase error:", error);
      return { error: error.message };
    }
    revalidatePath("/tracker");
    revalidatePath("/cv");
    return { id: data?.id };
  } catch (e) {
    console.error("[saveTailoredCV] unexpected:", e);
    return { error: e instanceof Error ? e.message : "Failed to save tailored CV." };
  }
}

export async function getSavedTailoredCVs(
  applicationId?: string
): Promise<SavedTailoredCV[]> {
  const { userId } = await auth();
  if (!userId) return [];

  const supabase = await createServerSupabaseClient();
  const query = supabase
    .from("cv_versions")
    .select("id, application_id, company, role, jd_text, tailored_data, content, created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });

  if (applicationId) {
    query.eq("application_id", applicationId);
  }

  const { data, error } = await query;
  if (error) {
    console.error("[getSavedTailoredCVs] error:", error);
    return [];
  }
  return (data ?? []) as SavedTailoredCV[];
}

// Save a CV that was used externally (not generated by the SaaS) — paste-and-attach.
export async function saveManualCV(
  applicationId: string,
  content: string
): Promise<{ id?: string; error?: string }> {
  try {
    const { userId } = await auth();
    if (!userId) return { error: "Not signed in" };
    if (!content || !content.trim()) return { error: "CV content is empty" };

    const supabase = await createServerSupabaseClient();
    const { data, error } = await supabase
      .from("cv_versions")
      .insert({
        user_id: userId,
        application_id: applicationId,
        content: content.trim(),
        tailored_data: null,
      })
      .select("id")
      .single();

    if (error) {
      console.error("[saveManualCV] supabase error:", error);
      return { error: error.message };
    }
    revalidatePath("/tracker");
    return { id: data?.id };
  } catch (e) {
    console.error("[saveManualCV] unexpected:", e);
    return { error: e instanceof Error ? e.message : "Failed to save CV." };
  }
}

function serialiseTailoredCVPlain(cv: TailoredCV): string {
  const lines: string[] = [];
  lines.push(cv.contact.name);
  lines.push(
    [cv.contact.location, cv.contact.email, cv.contact.phone, cv.contact.linkedin]
      .filter(Boolean)
      .join("  ·  ")
  );
  if (cv.summary) {
    lines.push("", "PROFILE", cv.summary);
  }
  if (cv.skills.length > 0) {
    lines.push("", "KEY SKILLS");
    for (const g of cv.skills) lines.push(`${g.category}: ${g.items.join(", ")}`);
  }
  if (cv.roles.length > 0) {
    lines.push("", "EXPERIENCE");
    for (const r of cv.roles) {
      const dates = r.isCurrent ? `${r.startDate} – Present` : `${r.startDate} – ${r.endDate ?? ""}`;
      lines.push(`${r.title} — ${r.company}${r.location ? `, ${r.location}` : ""} (${dates.trim()})`);
      for (const b of r.bullets) lines.push(`• ${b}`);
    }
  }
  if (cv.education.length > 0) {
    lines.push("", "EDUCATION");
    for (const e of cv.education) {
      const years = [e.startYear, e.endYear].filter(Boolean).join(" – ");
      lines.push(`${e.qualification} — ${e.institution}${e.classification ? ` (${e.classification})` : ""}${years ? ` [${years}]` : ""}`);
      if (e.details) lines.push(`  ${e.details}`);
    }
  }
  if (cv.certifications.length > 0) {
    lines.push("", "CERTIFICATIONS");
    for (const c of cv.certifications) {
      const meta = [c.issuer, c.year].filter(Boolean).join(", ");
      lines.push(`• ${c.content}${meta ? ` (${meta})` : ""}`);
    }
  }
  if (cv.languages.length > 0) {
    lines.push("", "LANGUAGES", cv.languages.map((l) => `${l.language} (${l.proficiency})`).join(", "));
  }
  if (cv.interests.length > 0) {
    lines.push("", "INTERESTS", cv.interests.join(", "));
  }
  return lines.join("\n");
}
